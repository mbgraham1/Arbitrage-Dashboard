/**
 * AUTO REBALANCE / FUNDING ENGINE — pre-positions inventory for the best
 * positive-net cross-venue routes so they become executable, WITHOUT the user
 * manually visiting each exchange.
 *
 * Money-safety architecture (all fail-closed; hardened per architect review):
 *  - A route only qualifies for funding actions when BOTH legs' fees are
 *    DETECTED and BOTH venues' balances are VERIFIED. Assumed or unverified
 *    inputs can never trigger a purchase.
 *  - Two action kinds, cheapest-first:
 *      LOCAL_BUY  — buy the needed base asset ON the venue that needs it,
 *                   using USD already there. Instant, no transfer risk.
 *                   Executed as bounded IOC LIMIT orders only (never
 *                   unbounded market orders) after a fresh (≤2s book)
 *                   revalidation of edge, caps, reserves, and balances
 *                   immediately before submission.
 *      TRANSFER   — planned with REAL Kraken withdrawal fees (WithdrawInfo)
 *                   via pre-approved named withdrawal keys only, but NEVER
 *                   auto-executed in v1: on-chain delays make a quoted edge
 *                   unreliable. Gemini withdrawals need Fund Manager +
 *                   approved addresses; Coinbase Advanced Trade keys cannot
 *                   withdraw at all — both reported verbatim, not attempted.
 *  - Durable reconciliation latch (persisted to disk, survives restarts):
 *    any order that cannot be confirmed terminal sets the latch; the engine
 *    refuses to arm until the user reviews and explicitly clears it. This is
 *    what prevents double-buying inventory across ticks/arms/restarts.
 *  - Spend ledger: persisted rolling-24h ledger enforces the daily cap across
 *    stop/re-arm cycles and restarts (never resets at midnight or on rearm).
 *  - Controls: arm/stop toggle, per-action USD cap (hard ceiling $25),
 *    rolling daily USD cap, per-venue untouchable USD reserve, one action per
 *    tick, pause-on-failure, emergency stop that wipes in-memory creds.
 *  - Never touches the trade executor or its gates (200ms freshness, floors).
 *  - All profit figures are projections, never guarantees.
 */
import fs from "node:fs";
import path from "node:path";
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  venueStates, evalRoutesForAsset, refreshGeminiUniverse, bookFor, fmtQty,
  CredsBody, KRAKEN_EXTRA_PAIRS, DEFAULT_MIN_NET_USD,
  type Creds, type LiveVenueId, type VenueState, type Route,
} from "./cross-venue";
import { OB_ASSETS, OB_USD_PAIRS } from "../lib/order-book";
import {
  krakenPrivateRequest, krakenRawIocLimitOrder, krakenOrderInfo, getCoinbaseAssetDetail,
  coinbaseIocLimitOrder, coinbaseOrderDetails, getCoinbaseProductIncrements, quantizeDown,
  PAIRS, type Pair,
} from "../lib/exchange";
import { geminiRoles, type GeminiCreds } from "../lib/gemini";
import { geminiIocLimitOrder, geminiOrderStatus, geminiSymbolDetails } from "../lib/gemini-exec";

const router: IRouter = Router();

const HARD_ACTION_CAP_USD = 25;      // absolute ceiling regardless of config
const TICK_MS = 30_000;
const POLL_MS = 700;
const TERMINAL_WAIT_MS = 20_000;
const EXEC_BOOK_MAX_AGE_MS = 2_000;  // pre-submission revalidation freshness
const IOC_PRICE_SLACK = 1.005;       // worst-case bound: 0.5% above current ask

// ── durable state: reconciliation latch + rolling spend ledger ───────────────

const STATE_FILE = path.join(process.cwd(), ".rebalance-state.json");
interface DurableState { latch: string | null; spendLedger: Array<{ at: string; usd: number }>; }
function loadState(): DurableState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as DurableState;
    return { latch: raw.latch ?? null, spendLedger: Array.isArray(raw.spendLedger) ? raw.spendLedger : [] };
  } catch { return { latch: null, spendLedger: [] }; }
}
const durable: DurableState = loadState();
function saveState(): void {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(durable)); } catch (e) { console.error("[REBAL] state persist failed:", (e as Error).message); }
}
function rolling24hSpendUsd(): number {
  const cutoff = Date.now() - 24 * 3600_000;
  durable.spendLedger = durable.spendLedger.filter(x => new Date(x.at).getTime() > cutoff);
  return durable.spendLedger.reduce((s, x) => s + x.usd, 0);
}
function recordSpend(usd: number): void { durable.spendLedger.push({ at: new Date().toISOString(), usd }); saveState(); }
function setLatch(why: string): void { durable.latch = `${new Date().toISOString()} ${why}`; saveState(); }

// ── capability probes ────────────────────────────────────────────────────────

interface VenueCaps {
  venue: LiveVenueId;
  localBuy: boolean;                 // PROVEN order permission (never assumed)
  withdraw: boolean;
  whitelist: Array<{ asset: string; key: string; method: string | null }>;
  missing: string | null;            // EXACT permission / setup missing, verbatim guidance
}

async function probeCaps(c: Creds): Promise<VenueCaps[]> {
  const out: VenueCaps[] = [];

  if (c.krakenKey && c.krakenSecret) {
    const kc = { krakenKey: c.krakenKey, krakenSecret: c.krakenSecret };
    let whitelist: VenueCaps["whitelist"] = [];
    let withdraw = false; let missing: string | null = null;
    try {
      const addrs = await krakenPrivateRequest<Array<{ asset: string; key: string; method?: string }>>("/0/private/WithdrawAddresses", {}, kc);
      whitelist = (addrs ?? []).map(a => ({ asset: a.asset, key: a.key, method: a.method ?? null }));
      withdraw = whitelist.length > 0;
      if (!withdraw) missing = "Kraken key CAN withdraw, but no withdrawal addresses are whitelisted. Add named withdrawal addresses in Kraken → Funding → Withdraw (each needs email confirmation), then they appear here. NOTE: a named key does not tell the API which venue it points to — you must confirm the name really is the destination exchange's deposit address.";
    } catch (e) {
      const msg = (e as Error).message;
      missing = /Permission denied/i.test(msg)
        ? "Kraken API key lacks the 'Funds — Withdraw' permission. Enable it in Kraken → Settings → API → your key → Permissions → Funds → Withdraw. Withdrawals will still only go to addresses you have whitelisted by name."
        : `Kraken withdrawal probe failed: ${msg}`;
    }
    out.push({ venue: "kraken", localBuy: true, withdraw, whitelist, missing });
  } else out.push({ venue: "kraken", localBuy: false, withdraw: false, whitelist: [], missing: "No Kraken API keys provided." });

  // Coinbase — Advanced Trade API has NO withdrawal endpoints, period.
  out.push({
    venue: "coinbase",
    localBuy: !!(c.coinbaseKey && c.coinbaseSecret),
    withdraw: false, whitelist: [],
    missing: c.coinbaseKey
      ? "Coinbase Advanced Trade API keys cannot withdraw — Coinbase does not expose withdrawal endpoints on this API. Transfers OUT of Coinbase must be done manually in the Coinbase app/site. Local buys on Coinbase work."
      : "No Coinbase API keys provided.",
  });

  if (c.geminiKey && c.geminiSecret) {
    const gc: GeminiCreds = { geminiKey: c.geminiKey, geminiSecret: c.geminiSecret };
    let missing: string | null = null; let isTrader = false;
    try {
      const r = await geminiRoles(gc);
      isTrader = r.isTrader;
      missing = !isTrader
        ? "Gemini API key lacks the Trader role — it cannot place orders. Create a Trader-role key in Gemini → Settings → API."
        : r.isFundManager
          ? "Gemini key has the Fund Manager role, but this app does not auto-withdraw from Gemini yet (approved-address-book withdrawals are planned). Withdraw manually via Gemini → Transfer, only to approved addresses."
          : "Gemini API key lacks the Fund Manager role required for withdrawals. Create a key with Fund Manager in Gemini → Settings → API, and enable the Approved Addresses whitelist. (App-side Gemini auto-withdrawals are not enabled yet either.)";
    } catch (e) { missing = `Gemini roles probe failed (${(e as Error).message}) — order permission UNPROVEN, so local buys on Gemini are disabled.`; }
    out.push({ venue: "gemini", localBuy: isTrader, withdraw: false, whitelist: [], missing });
  } else out.push({ venue: "gemini", localBuy: false, withdraw: false, whitelist: [], missing: "No Gemini API keys provided." });

  return out;
}

// ── planning ─────────────────────────────────────────────────────────────────

interface PlannedAction {
  kind: "LOCAL_BUY" | "TRANSFER";
  asset: string;
  venue: LiveVenueId;                 // where the inventory must END UP
  sourceVenue: LiveVenueId | null;
  qty: number;
  estNotionalUsd: number;
  overheadUsd: number;                // full est. cost of the action
  routeNetUsd: number;
  netAfterOverheadUsd: number;
  beneficial: boolean;
  reason: string;
  transferRisk: string | null;
  withdrawKey: string | null;
}

function walkAskCost(venue: LiveVenueId, asset: string, qty: number, maxAgeMs = 60_000): { vwap: number; mid: number; ageMs: number } | null {
  const b = bookFor(venue, asset);
  if (!b || !b.asks.length || !b.bids.length || b.ageMs > maxAgeMs) return null;
  let rem = qty, cost = 0;
  for (const [px, sz] of b.asks) { const take = Math.min(rem, sz); cost += take * px; rem -= take; if (rem <= 0) break; }
  if (rem > 0) return null;
  const mid = (b.asks[0][0] + b.bids[0][0]) / 2;
  return { vwap: cost / qty, mid, ageMs: b.ageMs };
}

/** Kraken asset-code aliases so whitelist matching is EXACT, never substring. */
function krakenAssetAliases(asset: string): Set<string> {
  const a = asset.toUpperCase();
  const s = new Set([a]);
  if (a === "BTC") { s.add("XBT"); s.add("XXBT"); }
  if (a === "ETH") s.add("XETH");
  if (a === "USD") s.add("ZUSD");
  return s;
}

/** Verified sell-venue base inventory, or null when it CANNOT be verified. */
async function sellVenueInventory(venue: LiveVenueId, asset: string, vs: Record<LiveVenueId, VenueState>, c: Creds): Promise<number | null> {
  if (venue === "coinbase") {
    // venueStates stores {} for coinbase per-asset holdings — {} is UNKNOWN,
    // not zero. Fetch the real figure or refuse to plan.
    if (!c.coinbaseKey || !c.coinbaseSecret) return null;
    try { return (await getCoinbaseAssetDetail({ coinbaseKey: c.coinbaseKey, coinbaseSecret: c.coinbaseSecret }, asset)).available; }
    catch { return null; }
  }
  if (vs[venue].assets == null) return null;
  return vs[venue].assets![asset] ?? 0;
}

async function planActions(c: Creds, vs: Record<LiveVenueId, VenueState>, caps: VenueCaps[], cfg: RebalanceConfig): Promise<{ actions: PlannedAction[]; routesConsidered: number }> {
  const PLAN_MAX_AGE_MS = 60_000;
  const routes: Route[] = [];
  for (const asset of [...new Set([...OB_ASSETS, "USDC"])]) routes.push(...await evalRoutesForAsset(asset, vs, c, DEFAULT_MIN_NET_USD, PLAN_MAX_AGE_MS));
  const positives = routes
    .map(r => ({ r, g: r.bestFeasible ?? r.best }))
    .filter(x => x.g && x.g.netAfterBufferUsd > 0)
    .sort((a, b) => b.g!.netAfterBufferUsd - a.g!.netAfterBufferUsd);

  const actions: PlannedAction[] = [];
  for (const { r, g } of positives.slice(0, 6)) {
    if (!g) continue;
    const sellV = r.sellVenue;
    const skel = { asset: r.asset, venue: sellV, sourceVenue: null as LiveVenueId | null, qty: 0, estNotionalUsd: g.sizeUsd, overheadUsd: 0, routeNetUsd: g.netAfterBufferUsd, netAfterOverheadUsd: 0, beneficial: false, transferRisk: null as string | null, withdrawKey: null as string | null };

    // ROUTE QUALITY GATE — both legs detected fees, both venues verified USD.
    // A funding purchase for a route whose profitability rests on assumptions
    // is never allowed.
    if (r.feeSourceBuy !== "detected" || r.feeSourceSell !== "detected") {
      actions.push({ ...skel, kind: "LOCAL_BUY", reason: `Route fees not fully DETECTED (${r.buyVenue}: ${r.feeSourceBuy}, ${sellV}: ${r.feeSourceSell}) — refusing to fund a route priced on assumptions.` });
      continue;
    }
    if (vs[r.buyVenue].usd == null || vs[sellV].usd == null) {
      actions.push({ ...skel, kind: "LOCAL_BUY", reason: `Balances UNVERIFIED on ${vs[r.buyVenue].usd == null ? r.buyVenue : sellV} — cannot plan against unknown holdings. Fix key scope first.` });
      continue;
    }
    const haveQty = await sellVenueInventory(sellV, r.asset, vs, c);
    if (haveQty == null) {
      actions.push({ ...skel, kind: "LOCAL_BUY", reason: `${sellV.toUpperCase()} ${r.asset} balance could not be VERIFIED — refusing to plan (would risk overbuying inventory you may already hold).` });
      continue;
    }
    // requiredBalances is null when NO size is feasible (e.g. zero sell-venue
    // inventory) — exactly the condition this engine repairs. Fall back to the
    // projection's own base quantity.
    const needQty = (r.requiredBalances?.sellAssetQty ?? g.baseQty) * 1.02;
    if (haveQty >= needQty) continue; // already positioned
    const shortQty = needQty - haveQty;

    // Option A: LOCAL BUY on the sell venue with USD already there
    const cap = caps.find(x => x.venue === sellV)!;
    const wc = walkAskCost(sellV, r.asset, shortQty);
    const usdFree = (vs[sellV].usd ?? 0) - (cfg.reservesUsd[sellV] ?? 0);
    if (wc) {
      const feePct = vs[sellV].takerPct / 100;
      const notional = shortQty * wc.vwap;
      const overhead = notional * feePct + (wc.vwap - wc.mid) * shortQty; // fee + acquisition premium vs mid
      const net = g.netAfterBufferUsd - overhead;
      const affordable = usdFree >= notional * (1 + feePct);
      const beneficial = net > 0 && cap.localBuy && affordable && notional <= Math.min(cfg.perActionCapUsd, HARD_ACTION_CAP_USD);
      actions.push({
        ...skel, kind: "LOCAL_BUY", qty: shortQty,
        estNotionalUsd: notional, overheadUsd: overhead, netAfterOverheadUsd: net, beneficial,
        reason: beneficial
          ? `Buy ${fmtQty(shortQty)} ${r.asset} on ${sellV} for ~$${notional.toFixed(2)}: overhead $${overhead.toFixed(3)} (fee ${vs[sellV].takerPct}% + premium) < route net $${g.netAfterBufferUsd.toFixed(3)} → first cycle still +$${net.toFixed(3)} PROJECTED (not guaranteed). Revalidated on fresh books immediately before any order.`
          : !cap.localBuy ? `${sellV} order permission not proven (${cap.missing ?? "keys missing"}) — cannot buy there.`
          : !affordable ? `Needs $${(notional * (1 + feePct)).toFixed(2)} free USD on ${sellV}; only $${Math.max(0, usdFree).toFixed(2)} above your $${(cfg.reservesUsd[sellV] ?? 0).toFixed(2)} reserve.`
          : notional > Math.min(cfg.perActionCapUsd, HARD_ACTION_CAP_USD) ? `Notional $${notional.toFixed(2)} exceeds per-action cap $${Math.min(cfg.perActionCapUsd, HARD_ACTION_CAP_USD).toFixed(2)}.`
          : `Overhead $${overhead.toFixed(3)} ≥ route net $${g.netAfterBufferUsd.toFixed(3)} — buying here would eat the whole edge (net ${net >= 0 ? "+" : ""}$${net.toFixed(3)}).`,
      });
      if (beneficial) continue;
    }

    // Option B: TRANSFER from Kraken (only supported source), NEVER auto-fired
    const kCap = caps.find(x => x.venue === "kraken")!;
    if (sellV !== "kraken") {
      const aliases = krakenAssetAliases(r.asset);
      const wlKey = kCap.whitelist.find(w => aliases.has(w.asset.toUpperCase()));
      if (!kCap.withdraw || !wlKey) {
        actions.push({ ...skel, kind: "TRANSFER", sourceVenue: "kraken", qty: shortQty, reason: kCap.missing ?? `No whitelisted Kraken withdrawal address whose asset EXACTLY matches ${r.asset} — add one (pointing at your ${sellV} deposit address) to enable transfer planning.` });
      } else {
        try {
          const wi = await krakenPrivateRequest<{ fee: string; limit: string }>("/0/private/WithdrawInfo", { asset: wlKey.asset, key: wlKey.key, amount: String(shortQty) }, { krakenKey: c.krakenKey!, krakenSecret: c.krakenSecret! });
          const px = walkAskCost("kraken", r.asset, shortQty);
          const feeUsd = px ? parseFloat(wi.fee) * px.mid : NaN;
          const buyOverhead = px ? shortQty * px.vwap * (vs.kraken.takerPct / 100) + (px.vwap - px.mid) * shortQty : NaN;
          const overhead = feeUsd + buyOverhead;
          const net = g.netAfterBufferUsd - overhead;
          actions.push({
            ...skel, kind: "TRANSFER", sourceVenue: "kraken", qty: shortQty,
            estNotionalUsd: px ? shortQty * px.vwap : g.sizeUsd, overheadUsd: overhead, netAfterOverheadUsd: net,
            beneficial: false, // transfers NEVER auto-fire in v1
            reason: Number.isFinite(overhead)
              ? `Buy on Kraken + withdraw via named key '${wlKey.key}' (asset ${wlKey.asset}): withdrawal fee ~$${feeUsd.toFixed(3)} + buy overhead $${buyOverhead.toFixed(3)} vs route net $${g.netAfterBufferUsd.toFixed(3)} → ${net > 0 ? `+$${net.toFixed(3)} BEFORE transfer-delay risk` : `NEGATIVE ($${net.toFixed(3)}) — do not do this`}. Auto-transfer is disabled in v1; execute manually only after confirming '${wlKey.key}' is really your ${sellV} deposit address (the API cannot verify the destination).`
              : "Could not price the transfer (book depth or fee unavailable) — refusing to guess.",
            transferRisk: "On-chain confirmations take minutes to hours; the quoted edge can vanish before funds arrive. Kraken's API cannot confirm a named address's destination venue — verify it yourself. Never treat this projection as guaranteed.",
            withdrawKey: wlKey.key,
          });
        } catch (e) {
          actions.push({ ...skel, kind: "TRANSFER", sourceVenue: "kraken", qty: shortQty, reason: `Kraken WithdrawInfo failed for ${r.asset}: ${(e as Error).message}` });
        }
      }
    }
  }
  return { actions, routesConsidered: positives.length };
}

// ── execution (bounded LOCAL_BUY only) ───────────────────────────────────────

interface LogEntry {
  at: string; kind: string; asset: string; fromVenue: string | null; toVenue: string;
  qty: number; notionalUsd: number | null; feeUsd: number | null;
  status: "done" | "partial" | "failed" | "skipped" | "refused"; detail: string; orderId: string | null;
}

/** Bumped on EVERY arm and stop — an in-flight tick from a previous
 * generation can never submit an order after /rebalance/stop. */
let armGeneration = 0;
function stillLive(gen: number): boolean { return engine?.armed === true && gen === armGeneration && !durable.latch; }

/** Ambiguous post-submission state: charge the WORST-CASE spend to the
 * rolling ledger (so a cleared latch can never enable overspending) and
 * latch — one atomic persist. */
function latchAmbiguous(why: string, worstUsd: number): void {
  durable.spendLedger.push({ at: new Date().toISOString(), usd: worstUsd });
  setLatch(why); // setLatch persists both fields
}

/**
 * Places a bounded IOC LIMIT order (worst-case spend = qty × limit + fee).
 * Balances/fees are re-read fresh, venue metadata is fetched, and THEN the
 * book/edge/caps are revalidated at the final submission boundary (≤2s book,
 * recomputed limit + worst-case), with a stop-generation check after every
 * await. Any unknown post-submission state charges worst-case spend + latches.
 */
async function execLocalBuy(a: PlannedAction, c: Creds, cfg: RebalanceConfig, gen: number): Promise<LogEntry> {
  const base: Omit<LogEntry, "status" | "detail" | "orderId"> = { at: new Date().toISOString(), kind: "LOCAL_BUY", asset: a.asset, fromVenue: null, toVenue: a.venue, qty: a.qty, notionalUsd: a.estNotionalUsd, feeUsd: null };
  const refuse = (detail: string): LogEntry => ({ ...base, status: "refused", detail, orderId: null });

  // Fresh balances + fee tier.
  const vsNow = await venueStates(c, { freshBalances: true });
  if (!stillLive(gen)) return refuse("stopped while revalidating — no order sent");
  const feePct = vsNow[a.venue].takerPct / 100;
  if (vsNow[a.venue].feeSource !== "detected") return refuse("revalidation: fee tier no longer detected");

  // Venue metadata BEFORE the final book check, so no slow call sits between
  // book validation and order submission.
  let kPair: string | null = null;
  let cbPair: Pair | null = null; let cbIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>> | null = null;
  let gemDetails: Awaited<ReturnType<typeof geminiSymbolDetails>> | null = null;
  try {
    if (a.venue === "kraken") {
      kPair = (OB_USD_PAIRS as Record<string, string>)[a.asset] ?? KRAKEN_EXTRA_PAIRS[a.asset] ?? null;
      if (!kPair) return { ...base, status: "failed", detail: `no Kraken pair for ${a.asset}`, orderId: null };
    } else if (a.venue === "coinbase") {
      cbPair = (PAIRS as readonly string[]).includes(`${a.asset}/USD`) ? (`${a.asset}/USD` as Pair) : null;
      if (!cbPair) return { ...base, status: "failed", detail: `Coinbase order routing not verified for ${a.asset}`, orderId: null };
      cbIncs = await getCoinbaseProductIncrements(cbPair);
    } else {
      gemDetails = await geminiSymbolDetails(`${a.asset}USD`.toLowerCase());
    }
  } catch (e) { return { ...base, status: "failed", detail: `metadata fetch failed: ${(e as Error).message}`, orderId: null }; }
  if (!stillLive(gen)) return refuse("stopped while fetching metadata — no order sent");

  // FINAL submission-boundary revalidation on a ≤2s book.
  const wc = walkAskCost(a.venue, a.asset, a.qty, EXEC_BOOK_MAX_AGE_MS);
  if (!wc) return refuse(`final check: no ${a.venue} book ≤${EXEC_BOOK_MAX_AGE_MS}ms with depth for ${fmtQty(a.qty)} ${a.asset}`);
  const limitPx = wc.vwap * IOC_PRICE_SLACK;
  const worstNotional = a.qty * limitPx;
  const capUsd = Math.min(cfg.perActionCapUsd, HARD_ACTION_CAP_USD);
  if (worstNotional > capUsd) return refuse(`final check: worst-case spend $${worstNotional.toFixed(2)} exceeds per-action cap $${capUsd.toFixed(2)}`);
  if (rolling24hSpendUsd() + worstNotional > cfg.dailyCapUsd) return refuse(`final check: rolling-24h spend $${rolling24hSpendUsd().toFixed(2)} + $${worstNotional.toFixed(2)} exceeds daily cap $${cfg.dailyCapUsd.toFixed(2)}`);
  const usdFree = (vsNow[a.venue].usd ?? 0) - (cfg.reservesUsd[a.venue] ?? 0);
  if (vsNow[a.venue].usd == null || usdFree < worstNotional * (1 + feePct)) return refuse(`final check: free USD on ${a.venue} ($${Math.max(0, usdFree).toFixed(2)} above reserve) can't cover worst-case $${(worstNotional * (1 + feePct)).toFixed(2)}`);
  const overheadNow = a.qty * wc.vwap * feePct + (wc.vwap - wc.mid) * a.qty;
  if (a.routeNetUsd - overheadNow <= 0) return refuse(`final check: overhead now $${overheadNow.toFixed(3)} ≥ route net $${a.routeNetUsd.toFixed(3)} — edge gone`);
  if (!stillLive(gen)) return refuse("stopped at submission boundary — no order sent");

  try {
    if (a.venue === "kraken") {
      const kc = { krakenKey: c.krakenKey!, krakenSecret: c.krakenSecret! };
      const r = await krakenRawIocLimitOrder(kc, "buy", a.qty, limitPx, kPair!);
      const txid = r.txid?.[0] ?? null;
      if (!txid) { latchAmbiguous(`Kraken LOCAL_BUY ${a.asset}: no txid returned — order state UNKNOWN`, worstNotional); return { ...base, status: "failed", detail: "Kraken returned no txid — RECONCILE LATCH SET (worst-case charged to 24h ledger)", orderId: null }; }
      const dl = Date.now() + TERMINAL_WAIT_MS;
      let info = { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
      while (Date.now() < dl) {
        try { info = await krakenOrderInfo(kc, txid); } catch { /* poll */ }
        if (["closed", "canceled", "expired"].includes(info.status)) break;
        await new Promise(rs => setTimeout(rs, POLL_MS));
      }
      if (!["closed", "canceled", "expired"].includes(info.status)) {
        latchAmbiguous(`Kraken LOCAL_BUY ${a.asset} order ${txid} not terminal after ${TERMINAL_WAIT_MS / 1000}s (status=${info.status})`, worstNotional);
        return { ...base, status: "failed", detail: `Kraken order ${txid} NOT TERMINAL — RECONCILE LATCH SET (worst-case charged to 24h ledger)`, orderId: txid };
      }
      if (info.volExec <= 0) return { ...base, status: "failed", detail: `Kraken IOC ${txid} terminal with zero fill (${info.status})`, orderId: txid };
      const full = info.volExec >= a.qty * 0.98;
      recordSpend(info.cost || worstNotional);
      return { ...base, qty: info.volExec, notionalUsd: info.cost || null, feeUsd: info.fee ?? null, status: full ? "done" : "partial", detail: `filled ${fmtQty(info.volExec)}/${fmtQty(a.qty)} ${a.asset} @ ~$${info.price} (${info.status})`, orderId: txid };
    }

    if (a.venue === "coinbase") {
      const cc = { coinbaseKey: c.coinbaseKey!, coinbaseSecret: c.coinbaseSecret! };
      const r = await coinbaseIocLimitOrder(cc, "BUY", quantizeDown(a.qty, cbIncs!.baseIncrement).value, limitPx, cbPair!, cbIncs!);
      if (!r.orderId) { latchAmbiguous(`Coinbase LOCAL_BUY ${a.asset}: no order id — state UNKNOWN`, worstNotional); return { ...base, status: "failed", detail: "Coinbase returned no order id — RECONCILE LATCH SET (worst-case charged to 24h ledger)", orderId: null }; }
      let det: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
      const dl = Date.now() + TERMINAL_WAIT_MS;
      while (Date.now() < dl) {
        try { const x = await coinbaseOrderDetails(cc, r.orderId); if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status)) { det = x; break; } } catch { /* poll */ }
        await new Promise(rs => setTimeout(rs, POLL_MS));
      }
      if (!det) {
        latchAmbiguous(`Coinbase LOCAL_BUY ${a.asset} order ${r.orderId} not confirmed terminal after ${TERMINAL_WAIT_MS / 1000}s`, worstNotional);
        return { ...base, status: "failed", detail: `Coinbase order ${r.orderId} NOT TERMINAL — RECONCILE LATCH SET (worst-case charged to 24h ledger)`, orderId: r.orderId };
      }
      if (det.filledSize <= 0) return { ...base, status: "failed", detail: `Coinbase IOC ${r.orderId} terminal with zero fill (${det.status})`, orderId: r.orderId };
      const full = det.filledSize >= a.qty * 0.98;
      recordSpend(det.filledValue || worstNotional);
      return { ...base, qty: det.filledSize, notionalUsd: det.filledValue || null, feeUsd: det.totalFees ?? null, status: full ? "done" : "partial", detail: `filled ${fmtQty(det.filledSize)}/${fmtQty(a.qty)} ${a.asset} (${det.status})`, orderId: r.orderId };
    }

    // gemini
    const gc: GeminiCreds = { geminiKey: c.geminiKey!, geminiSecret: c.geminiSecret! };
    const r = await geminiIocLimitOrder(gc, "buy", `${a.asset}USD`.toLowerCase(), a.qty, limitPx, gemDetails!);
    let info = r;
    const dl = Date.now() + TERMINAL_WAIT_MS;
    while (!info.terminal && Date.now() < dl) {
      await new Promise(rs => setTimeout(rs, POLL_MS));
      try { info = await geminiOrderStatus(gc, r.orderId); } catch { /* poll */ }
    }
    if (!info.terminal) {
      latchAmbiguous(`Gemini LOCAL_BUY ${a.asset} order ${r.orderId} not confirmed terminal after ${TERMINAL_WAIT_MS / 1000}s`, worstNotional);
      return { ...base, status: "failed", detail: `Gemini order ${r.orderId} NOT TERMINAL — RECONCILE LATCH SET (worst-case charged to 24h ledger)`, orderId: String(r.orderId) };
    }
    if (info.filledQty <= 0) return { ...base, status: "failed", detail: `Gemini IOC ${r.orderId} terminal with zero fill`, orderId: String(r.orderId) };
    const full = info.filledQty >= a.qty * 0.98;
    recordSpend(info.notionalUsd || worstNotional);
    return { ...base, qty: info.filledQty, notionalUsd: info.notionalUsd || null, status: full ? "done" : "partial", detail: `filled ${fmtQty(info.filledQty)}/${fmtQty(a.qty)} ${a.asset} @ ~$${info.avgPrice}`, orderId: String(r.orderId) };
  } catch (e) {
    // Submission threw — we cannot know whether an order reached the venue.
    latchAmbiguous(`LOCAL_BUY ${a.asset} on ${a.venue}: submission error with unknown order state: ${(e as Error).message}`, worstNotional);
    return { ...base, status: "failed", detail: `${(e as Error).message} — RECONCILE LATCH SET (worst-case charged to 24h ledger)`, orderId: null };
  }
}

// ── engine state / loop ──────────────────────────────────────────────────────

interface RebalanceConfig { perActionCapUsd: number; dailyCapUsd: number; reservesUsd: Record<LiveVenueId, number>; }
interface EngineState {
  creds: Creds; cfg: RebalanceConfig; armed: boolean; pausedReason: string | null;
  ticks: number; actionsDone: number; timer: NodeJS.Timeout | null;
}
let engine: EngineState | null = null;
let ticking = false;
const activityLog: LogEntry[] = [];
function pushLog(e: LogEntry): void { activityLog.unshift(e); if (activityLog.length > 300) activityLog.pop(); }

async function tick(): Promise<void> {
  const st = engine;
  const gen = armGeneration;
  if (!st || !st.armed || st.pausedReason || ticking) return;
  if (durable.latch) { st.pausedReason = `reconciliation latch set: ${durable.latch}`; return; }
  ticking = true;
  try {
    st.ticks++;
    try { await refreshGeminiUniverse(); } catch { /* stale ok */ }
    const vs = await venueStates(st.creds, { freshBalances: true });
    const caps = await probeCaps(st.creds);
    const { actions } = await planActions(st.creds, vs, caps, st.cfg);
    const doable = actions.find(a => a.beneficial && a.kind === "LOCAL_BUY");
    if (!doable) return;
    if (engine !== st || !st.armed || durable.latch) return; // stop barrier
    const entry = await execLocalBuy(doable, st.creds, st.cfg, gen);
    pushLog({ ...entry, detail: `${entry.detail} | why: ${doable.reason}` });
    if (entry.status === "done" || entry.status === "partial") st.actionsDone++;
    else if (entry.status === "failed") st.pausedReason = `last action FAILED (${entry.detail}) — engine paused; review the log${durable.latch ? " and clear the reconciliation latch" : ""}, then re-arm.`;
  } catch (e) {
    if (engine) engine.pausedReason = `tick error: ${(e as Error).message}`;
  } finally { ticking = false; }
}

// ── endpoints ────────────────────────────────────────────────────────────────

router.post("/rebalance/caps", async (req, res): Promise<void> => {
  const parsed = CredsBody.safeParse(req.body ?? {});
  res.json({ venues: await probeCaps(parsed.success ? parsed.data : {}) });
});

router.post("/rebalance/plan", async (req, res): Promise<void> => {
  const parsed = CredsBody.safeParse(req.body ?? {});
  const c: Creds = parsed.success ? parsed.data : {};
  const cfg = engine?.cfg ?? { perActionCapUsd: 15, dailyCapUsd: 30, reservesUsd: { kraken: 0, coinbase: 0, gemini: 0 } };
  try { await refreshGeminiUniverse(); } catch { /* stale ok */ }
  const vs = await venueStates(c);
  const caps = await probeCaps(c);
  const { actions, routesConsidered } = await planActions(c, vs, caps, cfg);
  res.json({
    plannedAt: new Date().toISOString(), routesConsidered, caps, actions,
    latch: durable.latch,
    rolling24hSpendUsd: rolling24hSpendUsd(),
    note: "Actions execute automatically ONLY when armed, for routes with DETECTED fees on BOTH legs and VERIFIED balances, when the route net still exceeds the action's full overhead — revalidated on ≤2s-fresh books immediately before a BOUNDED IOC limit order (never an unbounded market order). Transfers are planned with real withdrawal fees but never auto-executed: confirmation delays make a quoted edge unreliable, and the API cannot verify a named address's destination venue. The daily cap is a rolling 24h ledger that survives restarts. All profit figures are projections, not guarantees.",
  });
});

const ArmBody = CredsBody.extend({
  perActionCapUsd: z.number().positive().max(HARD_ACTION_CAP_USD).default(15),
  dailyCapUsd: z.number().positive().max(100).default(30),
  reservesUsd: z.object({ kraken: z.number().min(0).default(0), coinbase: z.number().min(0).default(0), gemini: z.number().min(0).default(0) }).default({ kraken: 0, coinbase: 0, gemini: 0 }),
});

router.post("/rebalance/arm", async (req, res): Promise<void> => {
  const parsed = ArmBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "bad body" }); return; }
  const b = parsed.data;
  if (engine?.armed) { res.status(409).json({ error: "already armed — stop first" }); return; }
  if (durable.latch) { res.status(409).json({ error: `reconciliation latch set — an earlier order's outcome is unverified. Check the venue's order history, then clear the latch explicitly. Latch: ${durable.latch}` }); return; }
  const hasAnyKeys = (b.krakenKey && b.krakenSecret) || (b.coinbaseKey && b.coinbaseSecret) || (b.geminiKey && b.geminiSecret);
  if (!hasAnyKeys) { res.status(400).json({ error: "no API keys provided — the engine cannot act without at least one venue's keys" }); return; }
  armGeneration++;
  engine = {
    creds: b, cfg: { perActionCapUsd: b.perActionCapUsd, dailyCapUsd: b.dailyCapUsd, reservesUsd: b.reservesUsd },
    armed: true, pausedReason: null, ticks: 0, actionsDone: 0,
    timer: setInterval(() => { void tick(); }, TICK_MS),
  };
  pushLog({ at: new Date().toISOString(), kind: "ARM", asset: "-", fromVenue: null, toVenue: "-", qty: 0, notionalUsd: null, feeUsd: null, status: "done", detail: `armed: perAction $${b.perActionCapUsd}, daily $${b.dailyCapUsd} (rolling 24h, $${rolling24hSpendUsd().toFixed(2)} already used), reserves K$${b.reservesUsd.kraken}/C$${b.reservesUsd.coinbase}/G$${b.reservesUsd.gemini}`, orderId: null });
  void tick();
  res.json({ armed: true });
});

router.post("/rebalance/stop", (_req, res): void => {
  armGeneration++; // invalidates any in-flight tick BEFORE it can submit
  if (engine?.timer) clearInterval(engine.timer);
  if (engine) pushLog({ at: new Date().toISOString(), kind: "STOP", asset: "-", fromVenue: null, toVenue: "-", qty: 0, notionalUsd: null, feeUsd: null, status: "done", detail: "emergency stop — engine disarmed, in-memory keys wiped", orderId: null });
  engine = null; // wipes creds
  res.json({ armed: false });
});

router.post("/rebalance/clear-latch", (req, res): void => {
  const body = z.object({ confirm: z.literal(true) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "must send {\"confirm\": true} — only clear the latch AFTER checking the venue's order history for the unverified order" }); return; }
  const old = durable.latch;
  durable.latch = null; saveState();
  pushLog({ at: new Date().toISOString(), kind: "CLEAR_LATCH", asset: "-", fromVenue: null, toVenue: "-", qty: 0, notionalUsd: null, feeUsd: null, status: "done", detail: `user cleared reconciliation latch: ${old ?? "(none)"}`, orderId: null });
  res.json({ cleared: true });
});

router.get("/rebalance/status", (_req, res): void => {
  res.json({
    armed: engine?.armed ?? false,
    pausedReason: engine?.pausedReason ?? null,
    latch: durable.latch,
    cfg: engine ? { ...engine.cfg } : null,
    dailyUsedUsd: rolling24hSpendUsd(),
    ticks: engine?.ticks ?? 0,
    actionsDone: engine?.actionsDone ?? 0,
    log: activityLog.slice(0, 100),
  });
});

export default router;
