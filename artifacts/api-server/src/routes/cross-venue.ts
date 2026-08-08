/**
 * CROSS-VENUE SCANNER/EXECUTOR — profitability-gated inventory arbitrage
 * across the THREE live venues: Kraken, Coinbase, Gemini.
 *
 * Generalization of the proven 2X (Kraken↔Coinbase) executor with identical
 * safety architecture, now venue-adapter based:
 *  - Scan (POST /arb/xv-scan): prices EVERY ordered venue pair × mutually
 *    supported USD asset from LIVE stream books (Kraken WS v2, Coinbase
 *    level2_batch, Gemini v2 l2). Depth-walked VWAP, per-venue fees on
 *    notional, slippage vs top-of-book, per-leg quote ages, and a FEASIBLE
 *    size sweep bounded by actual balances and exchange minimums when
 *    credentials are provided. NEVER trades.
 *  - Fees: detected per-venue when that venue's keys are in the request;
 *    assumed (labeled) otherwise. A route can only be marked FIRE when BOTH
 *    legs' fees are DETECTED and balances cover the legs — assumptions never
 *    gate live decisions.
 *  - Execute (POST /arb/xv-execute): one cycle, $10 hard cap, re-projected on
 *    CURRENT books with detected fees, 200ms freshness, shared live lock,
 *    first leg confirmed by ACTUAL fill quantity, second leg for exactly the
 *    confirmed quantity, ambiguity latches live runs off, "completed" only on
 *    full terminal second-leg fill. Ledger prefix "XV:".
 *
 * Gemini quote-age caveat (honest bound): Gemini's l2 feed carries no
 * exchange-side timestamps, so Gemini leg age is measured from local arrival
 * of the last delta. Kraken/Coinbase legs use exchange event time as before.
 */
import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, tradesTable } from "@workspace/db";
import { getStreamBook, getCoinbaseStreamBook, getGeminiStreamBook, startGeminiBookStream, geminiStreamStats, onBookUpdate, coinbaseBookKey, geminiBookKey, type StreamBook } from "../lib/book-stream";
import { OB_ASSETS, OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
import { routeSanityError } from "../lib/route-sanity";
import {
  getKrakenBalances,
  getCoinbaseAssetDetail,
  getCoinbaseFeeTier,
  krakenFeeTiers,
  krakenRawMarketOrder,
  krakenOrderInfo,
  coinbaseIocLimitOrder,
  coinbaseOrderDetails,
  getCoinbaseProductIncrements,
  getCoinbaseBidAsk,
  quantizeDown,
  PAIRS,
  type Pair,
} from "../lib/exchange";
import { geminiVerify, type GeminiCreds, type GeminiAccount } from "../lib/gemini";
import {
  geminiIocLimitOrder,
  geminiOrderStatus,
  geminiQuantizeQty,
  geminiSymbolDetails,
  geminiSymbols,
  isExplicitGeminiReject,
  type GeminiSymbolDetails,
} from "../lib/gemini-exec";
import { tryAcquireSharedLiveLock, releaseLiveLock, touchLiveLock, liveLockOwned } from "./arb";

const router: IRouter = Router();

export type LiveVenueId = "kraken" | "coinbase" | "gemini";
const LIVE_VENUES: LiveVenueId[] = ["kraken", "coinbase", "gemini"];

const POLL_MS = 600;
const TERMINAL_WAIT_MS = 25_000;
export const DEFAULT_MIN_NET_USD = 0.01;
const DEFAULT_MAX_QUOTE_AGE_MS = 200;
const EXEC_CAP_USD = 10; // HARD cap until realized track record is positive
const bufferFor = (sizeUsd: number) => Math.max(0.02, sizeUsd * 0.002);

// Assumed taker fees for CREDENTIAL-LESS scan display ONLY (labeled).
// Live decisions (FIRE / execute) require detected tiers — never these.
const ASSUMED_TAKER_PCT: Record<LiveVenueId, number> = { kraken: 0.4, coinbase: 1.2, gemini: 0.4 };

// ── tradable universe ─────────────────────────────────────────────────────────
// Assets each venue actually lists. Kraken/Coinbase reuse the streamed OB set;
// Gemini's list is fetched live from /v1/symbols (never guessed). USDC is a
// first-class asset where a real USD order book exists (Kraken USDCUSD +
// Gemini USDCUSD) — the "stablecoin rotation" route with near-zero volatility.
export const KRAKEN_EXTRA_PAIRS: Record<string, string> = { USDC: "USDCUSD" };
const CB_UNSUPPORTED = new Set<string>(["USDC"]); // no USDC-USD depth book on Coinbase Exchange

/** Coinbase order helpers are typed to the shared PAIRS union — a Coinbase LEG
 *  is only executable for assets in that verified list. */
function cbPairFor(asset: string): Pair | null {
  const p = `${asset}/USD`;
  return (PAIRS as readonly string[]).includes(p) ? (p as Pair) : null;
}

let geminiListed = new Set<string>();      // UPPER asset codes listed on Gemini with a USD book
let geminiUniverseAt = 0;

export async function refreshGeminiUniverse(): Promise<void> {
  if (Date.now() - geminiUniverseAt < 6 * 3600_000 && geminiListed.size) return;
  const syms = await geminiSymbols(); // lowercase like "btcusd"
  const usd = new Set(syms.filter(s => s.endsWith("usd")).map(s => s.slice(0, -3).toUpperCase()));
  const wanted = [...OB_ASSETS, "USDC"].filter(a => usd.has(a));
  geminiListed = new Set(wanted);
  geminiUniverseAt = Date.now();
  startGeminiBookStream(wanted.map(a => `${a}USD`));
}
// Fire-and-forget at module load so books are warm by the first scan.
void refreshGeminiUniverse().catch(e => console.warn("[XV] Gemini universe fetch failed (retries on next scan):", (e as Error).message));

function venueSupports(v: LiveVenueId, asset: string): boolean {
  if (v === "kraken") return asset in OB_USD_PAIRS || asset in KRAKEN_EXTRA_PAIRS;
  if (v === "coinbase") return (asset in OB_USD_PAIRS) && !CB_UNSUPPORTED.has(asset);
  return geminiListed.has(asset);
}

export function bookFor(v: LiveVenueId, asset: string): (StreamBook & { ageMs: number }) | null {
  if (v === "kraken") {
    const pair = (OB_USD_PAIRS as Record<string, string>)[asset] ?? KRAKEN_EXTRA_PAIRS[asset];
    return pair ? getStreamBook(pair) : null;
  }
  if (v === "coinbase") return getCoinbaseStreamBook(`${asset}-USD`);
  return getGeminiStreamBook(`${asset}USD`);
}

// ── pricing ───────────────────────────────────────────────────────────────────
type Level = [number, number];

function walkBuy(asks: Level[], usd: number): { qty: number; vwap: number; top: number } | null {
  let remaining = usd, qty = 0;
  const top = asks[0]?.[0] ?? 0;
  if (top <= 0) return null;
  for (const [px, vol] of asks) {
    const take = Math.min(remaining, px * vol);
    qty += take / px; remaining -= take;
    if (remaining <= 1e-9) return { qty, vwap: usd / qty, top };
  }
  return null; // depth exhausted — drop, never misprice
}
function walkSell(bids: Level[], qty: number): { usd: number; vwap: number; top: number } | null {
  let remaining = qty, usd = 0;
  const top = bids[0]?.[0] ?? 0;
  if (top <= 0) return null;
  for (const [px, vol] of bids) {
    const take = Math.min(remaining, vol);
    usd += take * px; remaining -= take;
    if (remaining <= 1e-12) return { usd, vwap: usd / qty, top };
  }
  return null;
}

interface XvProjection {
  sizeUsd: number;
  grossSpreadUsd: number;
  feesUsd: number;
  slippageUsd: number;
  bufferUsd: number;
  netProfitUsd: number;        // after fees + slippage (buffer separate, shown)
  netAfterBufferUsd: number;   // the number that must clear the floor
  baseQty: number;
  quoteAgeMs: number;
  buyAgeMs: number;
  sellAgeMs: number;
}

function project(asset: string, buy: LiveVenueId, sell: LiveVenueId, sizeUsd: number, buyFeePct: number, sellFeePct: number): XvProjection | null {
  const bBook = bookFor(buy, asset), sBook = bookFor(sell, asset);
  if (!bBook || !sBook) return null;
  const b = walkBuy(bBook.asks, sizeUsd);
  if (!b) return null;
  const s = walkSell(sBook.bids, b.qty);
  if (!s) return null;
  const feesUsd = sizeUsd * (buyFeePct / 100) + s.usd * (sellFeePct / 100);
  const rawEdgeUsd = b.top > 0 ? (s.top - b.top) * (sizeUsd / b.top) : 0;
  const netProfitUsd = s.usd - sizeUsd - feesUsd;
  const slippageUsd = Math.max(0, rawEdgeUsd - (s.usd - sizeUsd));
  const bufferUsd = bufferFor(sizeUsd);
  return {
    sizeUsd, grossSpreadUsd: rawEdgeUsd, feesUsd, slippageUsd, bufferUsd,
    netProfitUsd, netAfterBufferUsd: netProfitUsd - bufferUsd, baseQty: b.qty,
    quoteAgeMs: Math.max(bBook.ageMs, sBook.ageMs), buyAgeMs: bBook.ageMs, sellAgeMs: sBook.ageMs,
  };
}

// ── credential handling ───────────────────────────────────────────────────────
export const CredsBody = z.object({
  krakenKey: z.string().min(1).optional(), krakenSecret: z.string().min(1).optional(),
  coinbaseKey: z.string().min(1).optional(), coinbaseSecret: z.string().min(1).optional(),
  geminiKey: z.string().min(1).optional(), geminiSecret: z.string().min(1).optional(),
});
export type Creds = z.infer<typeof CredsBody>;
const hasKraken = (c: Creds) => !!(c.krakenKey && c.krakenSecret);
const hasCoinbase = (c: Creds) => !!(c.coinbaseKey && c.coinbaseSecret);
const hasGemini = (c: Creds) => !!(c.geminiKey && c.geminiSecret);

export interface VenueState {
  feeSource: "detected" | "assumed";
  takerPct: number;
  usd: number | null;                       // spendable USD (null = unknown, no keys)
  assets: Record<string, number> | null;    // spendable base balances
  error: string | null;                     // detection failure — NEVER silently downgraded for live decisions
}

export async function venueStates(c: Creds, opts: { freshBalances?: boolean } = {}): Promise<Record<LiveVenueId, VenueState>> {
  const out: Record<LiveVenueId, VenueState> = {
    kraken: { feeSource: "assumed", takerPct: ASSUMED_TAKER_PCT.kraken, usd: null, assets: null, error: null },
    coinbase: { feeSource: "assumed", takerPct: ASSUMED_TAKER_PCT.coinbase, usd: null, assets: null, error: null },
    gemini: { feeSource: "assumed", takerPct: ASSUMED_TAKER_PCT.gemini, usd: null, assets: null, error: null },
  };
  const jobs: Promise<void>[] = [];
  if (hasKraken(c)) {
    const kc = { krakenKey: c.krakenKey!, krakenSecret: c.krakenSecret! };
    jobs.push((async () => {
      try {
        const [tier, bals] = await Promise.all([
          krakenFeeTiers(kc, [OB_USD_PAIRS.BTC, OB_USD_PAIRS.ETH]),
          getKrakenBalances(kc, true),
        ]);
        if (!tier) throw new Error("Kraken fee tier unavailable");
        const assets: Record<string, number> = {};
        for (const b of bals) {
          const code = b.currency.replace(/^[XZ]/, "");
          const norm = code === "XBT" ? "BTC" : code === "XDG" ? "DOGE" : code;
          assets[norm] = (assets[norm] ?? 0) + b.amount;
        }
        out.kraken = {
          feeSource: "detected", takerPct: tier.takerFeePct,
          usd: (assets["USD"] ?? 0), assets, error: null,
        };
      } catch (e) { out.kraken.error = (e as Error).message; }
    })());
  }
  if (hasCoinbase(c)) {
    const cc = { coinbaseKey: c.coinbaseKey!, coinbaseSecret: c.coinbaseSecret! };
    jobs.push((async () => {
      try {
        const tier = await getCoinbaseFeeTier(cc);
        const usd = (await getCoinbaseAssetDetail(cc, "USD")).available;
        out.coinbase = { feeSource: "detected", takerPct: tier.takerFeePct, usd, assets: {}, error: null };
      } catch (e) { out.coinbase.error = (e as Error).message; }
    })());
  }
  if (hasGemini(c)) {
    const gc: GeminiCreds = { geminiKey: c.geminiKey!, geminiSecret: c.geminiSecret! };
    jobs.push((async () => {
      try {
        const acct: GeminiAccount = await geminiVerify(gc, opts.freshBalances ? { maxAgeMs: 0 } : undefined);
        // Fees verified — but balances count ONLY when the scope is clean.
        // A scope/permission issue means balances are UNVERIFIED (usd/assets
        // stay null → no FIRE), with the exact problem surfaced verbatim.
        out.gemini = acct.scopeIssue
          ? { feeSource: "detected", takerPct: acct.takerPct, usd: null, assets: null, error: acct.scopeIssue }
          : { feeSource: "detected", takerPct: acct.takerPct, usd: acct.usdBalance, assets: acct.balances, error: null };
      } catch (e) { out.gemini.error = (e as Error).message; }
    })());
  }
  await Promise.all(jobs);
  return out;
}

/** Coinbase per-asset balance on demand (its list API is per-asset).
 * 15s cache so scan/auto evaluation can gate on real inventory without
 * hammering the API; execution always re-fetches FRESH (maxAgeMs 0). */
const cbBalCache = new Map<string, { at: number; v: number }>();
async function coinbaseAssetBal(c: Creds, asset: string, maxAgeMs = 0): Promise<number> {
  const key = crypto.createHash("sha256").update(`${c.coinbaseKey}:${c.coinbaseSecret}:${asset}`).digest("hex");
  const hit = cbBalCache.get(key);
  if (hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) return hit.v;
  const v = (await getCoinbaseAssetDetail({ coinbaseKey: c.coinbaseKey!, coinbaseSecret: c.coinbaseSecret! }, asset)).available;
  cbBalCache.set(key, { at: Date.now(), v });
  return v;
}

// ── POST /arb/xv-scan ─────────────────────────────────────────────────────────
// Candidate sizes: full feasibility sweep under the hard cap.
const CAND_SIZES = [2, 5, 10];

/** Compact quantity for blocker labels: 4076738 → "4.08M". */
export function fmtQty(q: number): string {
  if (q >= 1e9) return `${(q / 1e9).toFixed(2)}B`;
  if (q >= 1e6) return `${(q / 1e6).toFixed(2)}M`;
  if (q >= 1e3) return `${(q / 1e3).toFixed(1)}K`;
  return q >= 1 ? q.toFixed(2) : q.toPrecision(3);
}

export type Route = {
    asset: string; buyVenue: LiveVenueId; sellVenue: LiveVenueId;
    usdRoute: boolean;                    // all-USD quotes → no basis haircut anywhere (always true here; label for FE)
    stable: boolean;                      // USDC route
    decision: "FIRE" | "SKIP";
    reason: string;
    feeSourceBuy: "detected" | "assumed"; feeSourceSell: "detected" | "assumed";
    buyTakerPct: number; sellTakerPct: number;
    best: (XvProjection & { feasible: boolean }) | null;   // best net across candidate sizes
    bestFeasible: (XvProjection & { feasible: boolean }) | null; // best net across sizes the balances/minimums allow
    projections: Array<XvProjection & { feasible: boolean; infeasibleWhy: string | null }>;
    requiredBalances: { buyUsd: number; sellAssetQty: number } | null;
    balancesOk: boolean | null;           // null = unknown (keys missing)
    minNotionalUsd: number | null;        // exchange-minimum notional for this pair (when known)
    /** Plain-English FIRST current blocker (or READY label). */
    blocker: string;
  };

/**
 * Evaluate every ordered venue pair for one asset. Shared by the full scan
 * and the event-driven auto-executor, so the displayed decision and the
 * auto-fire decision are computed by the SAME code on the SAME books.
 */
export async function evalRoutesForAsset(asset: string, vs: Record<LiveVenueId, VenueState>, c: Creds, minNetUsd: number, maxQuoteAgeMs: number): Promise<Route[]> {
  const routes: Route[] = [];
  {
    for (const buy of LIVE_VENUES) for (const sell of LIVE_VENUES) {
      if (buy === sell) continue;
      if (!venueSupports(buy, asset) || !venueSupports(sell, asset)) continue;

      const bs = vs[buy], ss = vs[sell];
      // Gemini exchange minimum (when a Gemini leg is present and metadata is reachable).
      let minNotionalUsd: number | null = null;
      if (buy === "gemini" || sell === "gemini") {
        try {
          const det = await geminiSymbolDetails(`${asset}USD`);
          const top = bookFor("gemini", asset)?.asks[0]?.[0] ?? 0;
          if (top > 0) minNotionalUsd = det.minOrderSize * top;
        } catch { minNotionalUsd = null; }
      }

      // Coinbase sell-side inventory is per-asset — fetch it (15s cache) so
      // evaluation is authoritative; null = creds missing OR fetch failed
      // (then balances stay UNVERIFIED — never assumed fine).
      let cbSellAvail: number | null = null;
      if (sell === "coinbase" && hasCoinbase(c)) {
        try { cbSellAvail = await coinbaseAssetBal(c, asset, 15_000); } catch { cbSellAvail = null; }
      }

      const projections: Route["projections"] = [];
      for (const size of CAND_SIZES) {
        const p = project(asset, buy, sell, size, bs.takerPct, ss.takerPct);
        if (!p) continue;
        let infeasibleWhy: string | null = null;
        if (minNotionalUsd != null && size < minNotionalUsd * 1.02) infeasibleWhy = `below exchange minimum (~$${minNotionalUsd.toFixed(2)} notional)`;
        if (!infeasibleWhy && bs.usd != null && bs.usd < size * 1.01) infeasibleWhy = `needs $${(size * 1.01).toFixed(2)} USD on ${buy}, have $${bs.usd.toFixed(2)}`;
        if (!infeasibleWhy && sell !== "coinbase" && ss.assets != null) {
          const have = ss.assets[asset] ?? 0;
          if (have < p.baseQty * 1.02) infeasibleWhy = `needs ~${(p.baseQty * 1.02).toFixed(6)} ${asset} on ${sell}, have ${have.toFixed(6)}`;
        }
        if (!infeasibleWhy && sell === "coinbase" && cbSellAvail != null && cbSellAvail < p.baseQty * 1.02) {
          infeasibleWhy = `needs ~${(p.baseQty * 1.02).toFixed(6)} ${asset} on coinbase, have ${cbSellAvail.toFixed(6)}`;
        }
        projections.push({ ...p, feasible: infeasibleWhy == null, infeasibleWhy });
      }
      if (!projections.length) continue;

      const byNet = [...projections].sort((a, b) => b.netAfterBufferUsd - a.netAfterBufferUsd);
      const best = byNet[0]!;
      const feas = byNet.filter(p => p.feasible);
      const bestFeasible = feas[0] ?? null;

      const bothDetected = bs.feeSource === "detected" && ss.feeSource === "detected";
      const balancesKnown = bs.usd != null && (sell === "coinbase" ? cbSellAvail != null : ss.assets != null);

      let decision: "FIRE" | "SKIP" = "SKIP";
      let reason: string;
      let blocker: string;
      const g = bestFeasible ?? best;
      const oldestLegVenue = g.buyAgeMs >= g.sellAgeMs ? buy : sell;
      // Canonical sanity guard: an implausible projected net (unit inversion,
      // corrupt/inverted book) must never rank, display, or auto-fire.
      const sanityErr = routeSanityError(g.sizeUsd, g.netProfitUsd, g.grossSpreadUsd);
      if (sanityErr) {
        reason = sanityErr;
        blocker = "PRICING CONSISTENCY ERROR";
      } else if (g.quoteAgeMs > maxQuoteAgeMs) {
        reason = `books stale: oldest leg ${g.quoteAgeMs}ms > ${maxQuoteAgeMs}ms`;
        blocker = `STALE ${oldestLegVenue.toUpperCase()} BOOK ${g.quoteAgeMs}ms`;
      } else if (g.netAfterBufferUsd < minNetUsd) {
        reason = g.netProfitUsd <= 0
          ? `net negative after costs (fees $${g.feesUsd.toFixed(4)} + slippage $${g.slippageUsd.toFixed(4)} vs gross $${g.grossSpreadUsd.toFixed(4)})`
          : `net-after-buffer $${g.netAfterBufferUsd.toFixed(4)} below floor $${minNetUsd.toFixed(2)}`;
        blocker = g.netProfitUsd <= 0 ? "NET NEGATIVE AFTER COSTS" : `NET $${g.netAfterBufferUsd.toFixed(2)} BELOW FLOOR $${minNetUsd.toFixed(2)}`;
      } else if (!bothDetected) {
        const av = bs.feeSource === "assumed" ? buy : sell;
        reason = `positive projection but fees are ASSUMED on ${av} — connect keys; assumptions never gate live decisions`;
        blocker = `${av.toUpperCase()} FEES ASSUMED — CONNECT KEYS`;
      } else if (!balancesKnown) {
        const uv = bs.usd == null ? buy : sell;
        reason = `positive projection but balances UNVERIFIED${bs.error ? ` — ${buy}: ${bs.error}` : ""}${ss.error ? ` — ${sell}: ${ss.error}` : ""}` || "positive projection but balances unverified";
        blocker = `${uv.toUpperCase()} BALANCE UNVERIFIED`;
      } else if (!bestFeasible) {
        const why = projections.find(p => p.sizeUsd === best.sizeUsd)?.infeasibleWhy ?? "balances/minimums";
        reason = `positive at $${best.sizeUsd} but infeasible: ${why}`;
        blocker = why.startsWith("needs ~") && sell !== "coinbase"
          ? `NEED ${fmtQty(best.baseQty * 1.02)} ${asset} ON ${sell.toUpperCase()}`
          : why.startsWith("needs $") ? `NEED $${(best.sizeUsd * 1.01).toFixed(2)} ON ${buy.toUpperCase()}`
          : `BELOW ${buy === "gemini" || sell === "gemini" ? "GEMINI" : "EXCHANGE"} MINIMUM`;
      } else {
        decision = "FIRE";
        reason = `net-after-buffer $${bestFeasible.netAfterBufferUsd.toFixed(4)} clears floor at feasible size $${bestFeasible.sizeUsd}`;
        blocker = autoState?.armed ? "READY TO AUTO-FIRE" : "READY TO FIRE";
      }

      routes.push({
        asset, buyVenue: buy, sellVenue: sell, usdRoute: true, stable: asset === "USDC",
        decision, reason,
        feeSourceBuy: bs.feeSource, feeSourceSell: ss.feeSource,
        buyTakerPct: bs.takerPct, sellTakerPct: ss.takerPct,
        best, bestFeasible, projections,
        requiredBalances: bestFeasible ? { buyUsd: bestFeasible.sizeUsd * 1.01, sellAssetQty: bestFeasible.baseQty * 1.02 } : null,
        balancesOk: balancesKnown ? bestFeasible != null : null,
        minNotionalUsd,
        blocker,
      });
    }
  }
  return routes;
}

router.post("/arb/xv-scan", async (req, res): Promise<void> => {
  const parsed = CredsBody.safeParse(req.body ?? {});
  const c: Creds = parsed.success ? parsed.data : {};
  const q = req.query as Record<string, string | undefined>;
  const minNetUsd = parseFloat(q.minNetUsd ?? "") || DEFAULT_MIN_NET_USD;
  const maxQuoteAgeMs = parseFloat(q.maxQuoteAgeMs ?? "") || DEFAULT_MAX_QUOTE_AGE_MS;

  try { await refreshGeminiUniverse(); } catch { /* stale universe reused; scan continues */ }
  const vs = await venueStates(c);

  const routes: Route[] = [];
  const assets = [...new Set([...OB_ASSETS, "USDC"])];
  for (const asset of assets) routes.push(...await evalRoutesForAsset(asset, vs, c, minNetUsd, maxQuoteAgeMs));

  // Rank: FIRE first by net, then near-misses by net-after-buffer. Gemini USD
  // routes and the USDC stable route surface naturally — no haircut penalty.
  routes.sort((a, b) => {
    if ((a.decision === "FIRE") !== (b.decision === "FIRE")) return a.decision === "FIRE" ? -1 : 1;
    const an = (a.bestFeasible ?? a.best)?.netAfterBufferUsd ?? -Infinity;
    const bn = (b.bestFeasible ?? b.best)?.netAfterBufferUsd ?? -Infinity;
    return bn - an;
  });

  res.json({
    scannedAt: new Date().toISOString(),
    params: { minNetUsd, maxQuoteAgeMs, execCapUsd: EXEC_CAP_USD, candidateSizes: CAND_SIZES },
    venues: (Object.entries(vs) as Array<[LiveVenueId, VenueState]>).map(([id, v]) => ({
      id, feeSource: v.feeSource, takerPct: v.takerPct, usd: v.usd, error: v.error,
      streaming: id === "gemini" ? geminiStreamStats().connected : true,
    })),
    fireCount: routes.filter(r => r.decision === "FIRE").length,
    routes: routes.slice(0, 60),
    note: "FIRE requires: fresh books (≤200ms), positive net after fees+slippage+buffer, DETECTED fees on both legs, and verified balances at a feasible size. Assumed fees can only ever produce SKIP.",
  });
});

// ── POST /arb/xv-execute ──────────────────────────────────────────────────────
let execInFlight = false;
let liveNeedsReconcile: string | null = null;

const ExecuteBody = CredsBody.extend({
  asset: z.string().min(1),
  buyVenue: z.enum(["kraken", "coinbase", "gemini"]),
  sellVenue: z.enum(["kraken", "coinbase", "gemini"]),
  sizeUsd: z.number().positive().optional(),
  minNetUsd: z.number().optional(),
  maxQuoteAgeMs: z.number().positive().optional(),
});

interface LegResult { venue: LiveVenueId; orderId: string | null; status: string; filledQty: number; avgPrice: number | null; notionalUsd: number | null; feeUsd: number | null; latencyMs: number; }

async function ledgerIndeterminate(asset: string, tag: string, note: string, buyId: string | null): Promise<void> {
  try {
    await db.insert(tradesTable).values({
      pair: `XV:${asset} ${tag} [indeterminate: ${note.slice(0, 120)}]`,
      buyExchange: "-", sellExchange: "-", volume: "0",
      estimatedProfitUsd: "0", netEdgePct: "0", isDryRun: false,
      krakenPrice: "0", coinbasePrice: "0",
      buyOrderId: buyId, sellOrderId: null,
      status: "unhedged", realizedProfitUsd: null,
    });
  } catch (e) { console.error("[XV] indeterminate ledger write failed", e); }
}

/**
 * Venue-adapter leg: place a bounded IOC-style order and poll until terminal.
 * Returns confirmed fills only; `indeterminate` means the outcome is UNKNOWN
 * (order may exist) and the caller must latch reconciliation.
 */
async function runLeg(
  venue: LiveVenueId,
  side: "buy" | "sell",
  asset: string,
  qty: number,                       // base units (buy: estimated, sell: confirmed)
  c: Creds,
  cbIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>> | null,
  gemDetails: GeminiSymbolDetails | null,
  gemTakerPct: number | null, // ALREADY-verified Gemini taker tier (no post-fill network call)
): Promise<{ leg: LegResult; indeterminate: string | null; explicitReject: string | null }> {
  const t0 = Date.now();
  const done = (leg: Partial<LegResult>, indeterminate: string | null = null, explicitReject: string | null = null) => ({
    leg: { venue, orderId: null, status: "unknown", filledQty: 0, avgPrice: null, notionalUsd: null, feeUsd: null, latencyMs: Date.now() - t0, ...leg } as LegResult,
    indeterminate, explicitReject,
  });

  if (venue === "kraken") {
    const kc = { krakenKey: c.krakenKey!, krakenSecret: c.krakenSecret! };
    const pair = (OB_USD_PAIRS as Record<string, string>)[asset] ?? KRAKEN_EXTRA_PAIRS[asset]!;
    let txid: string | null = null;
    try {
      const r = await krakenRawMarketOrder(kc, side, qty, pair);
      txid = r.txid?.[0] ?? null;
      if (!txid) throw new Error("Kraken returned no txid");
    } catch (e) {
      const msg = (e as Error).message;
      if (/EOrder:|EGeneral:Invalid|EAPI:Invalid|EFunding:|ETrade:/.test(msg)) return done({}, null, msg);
      return done({}, `Kraken ${side.toUpperCase()} (txid unknown) unconfirmed: ${msg}`);
    }
    let info = { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
    const dl = Date.now() + TERMINAL_WAIT_MS;
    while (Date.now() < dl) {
      touchLiveLock();
      try { info = await krakenOrderInfo(kc, txid); } catch { /* poll again */ }
      if (["closed", "canceled", "expired"].includes(info.status)) break;
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    if (!["closed", "canceled", "expired"].includes(info.status)) {
      return done({ orderId: txid, status: info.status, filledQty: info.volExec }, `Kraken ${side.toUpperCase()} ${txid} not terminal after ${TERMINAL_WAIT_MS / 1000}s`);
    }
    return done({ orderId: txid, status: info.status, filledQty: info.volExec || 0, avgPrice: info.price || null, notionalUsd: info.cost || null, feeUsd: info.fee || 0 });
  }

  if (venue === "coinbase") {
    const cc = { coinbaseKey: c.coinbaseKey!, coinbaseSecret: c.coinbaseSecret! };
    const cbPair = cbPairFor(asset);
    if (!cbPair) return done({}, null, `Coinbase order routing not verified for ${asset}`);
    if (!cbIncs) return done({}, null, "Coinbase increments unavailable");
    const q = (v: number) => quantizeDown(v, cbIncs.baseIncrement).value;
    let orderId: string | null = null;
    try {
      const fresh = await getCoinbaseBidAsk(cbPair);
      const px = side === "buy" ? fresh.ask * 1.005 : fresh.bid * 0.995;
      const r = await coinbaseIocLimitOrder(cc, side === "buy" ? "BUY" : "SELL", q(qty), px, cbPair, cbIncs);
      orderId = r.orderId ?? null;
      if (!orderId) throw new Error("Coinbase returned no order id");
      let det: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
      const dl = Date.now() + TERMINAL_WAIT_MS;
      while (Date.now() < dl) {
        touchLiveLock();
        try {
          const x = await coinbaseOrderDetails(cc, orderId);
          if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status)) { det = x; break; }
        } catch { /* poll again */ }
        await new Promise(r => setTimeout(r, POLL_MS));
      }
      if (!det) det = await coinbaseOrderDetails(cc, orderId);
      if (!["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(det.status)) {
        return done({ orderId, status: det.status, filledQty: det.filledSize }, `Coinbase ${side.toUpperCase()} ${orderId} not terminal after ${TERMINAL_WAIT_MS / 1000}s`);
      }
      return done({ orderId, status: det.status, filledQty: det.filledSize, avgPrice: det.avgPrice || null, notionalUsd: det.filledValue || null, feeUsd: det.totalFees });
    } catch (e) {
      return done({ orderId }, `Coinbase ${side.toUpperCase()} ${orderId ?? "(id unknown)"} unconfirmed: ${(e as Error).message}`);
    }
  }

  // gemini
  const gc: GeminiCreds = { geminiKey: c.geminiKey!, geminiSecret: c.geminiSecret! };
  if (!gemDetails) return done({}, null, "Gemini symbol details unavailable");
  const book = getGeminiStreamBook(`${asset}USD`);
  const top = side === "buy" ? book?.asks[0]?.[0] : book?.bids[0]?.[0];
  if (!book || !top || top <= 0) return done({}, null, "Gemini live book unavailable at order time");
  const bound = side === "buy" ? top * 1.005 : top * 0.995;
  let orderId: string | null = null;
  try {
    const sub = await geminiIocLimitOrder(gc, side, `${asset}USD`, qty, bound, gemDetails);
    orderId = sub.orderId;
  } catch (e) {
    const msg = (e as Error).message;
    if (isExplicitGeminiReject(msg)) return done({}, null, msg);
    return done({}, `Gemini ${side.toUpperCase()} (id unknown) unconfirmed: ${msg}`);
  }
  let info: Awaited<ReturnType<typeof geminiOrderStatus>> | null = null;
  const dl = Date.now() + TERMINAL_WAIT_MS;
  while (Date.now() < dl) {
    touchLiveLock();
    try {
      const x = await geminiOrderStatus(gc, orderId);
      if (x.terminal) { info = x; break; }
    } catch { /* poll again */ }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  if (!info) {
    try { const x = await geminiOrderStatus(gc, orderId); if (x.terminal) info = x; } catch { /* fall through */ }
  }
  if (!info) return done({ orderId, status: "unknown" }, `Gemini ${side.toUpperCase()} ${orderId} not terminal after ${TERMINAL_WAIT_MS / 1000}s`);
  // Gemini order status carries no fee field on this endpoint — fee accounted
  // from the taker tier VERIFIED BEFORE the cycle started, on the confirmed
  // notional. No network call after a fill: a transient error here must never
  // turn a confirmed fill into an ambiguous outcome. Surfaced in the response.
  if (gemTakerPct == null) return done({ orderId, status: info.status, filledQty: info.filledQty }, `Gemini ${side.toUpperCase()} ${orderId} filled but taker tier missing for fee accounting — treat as unreconciled`);
  const feeUsd = info.notionalUsd * (gemTakerPct / 100);
  return done({ orderId, status: info.status, filledQty: info.filledQty, avgPrice: info.avgPrice || null, notionalUsd: info.notionalUsd || null, feeUsd });
}

type XvLogger = { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void };
type XvExecResult = Record<string, unknown> & { executed: boolean; outcome: string; reason: string };

/**
 * The ONE execution core — used by BOTH the manual EXECUTE endpoint and the
 * auto-executor. Every hard guard lives here, so neither path can bypass a
 * gate the other enforces: re-projection on CURRENT books, freshness, floor,
 * detected fees, verified balances, minimums, shared live lock, confirmed
 * fills, reconcile latch. Manual is not an override — it is the same gates.
 */
async function executeXvCycle(b: z.infer<typeof ExecuteBody>, log: XvLogger): Promise<XvExecResult> {
  const { asset } = b;
  const buyVenue = b.buyVenue as LiveVenueId, sellVenue = b.sellVenue as LiveVenueId;
  const startedAt = new Date().toISOString();
  let out: XvExecResult | null = null;
  const res = { json: (x: XvExecResult) => { out = x; } };
  const skip = (reason: string, extra?: object) => {
    log.info({ asset, buyVenue, sellVenue, reason }, "[XV] SKIP");
    res.json({ executed: false, outcome: "skipped", reason, asset, buyVenue, sellVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: null, sellLeg: null, realizedProfitUsd: null, projection: null, ...extra });
  };

  if (buyVenue === sellVenue) { skip("buy and sell venue must differ"); return out!; }
  const needs = (v: LiveVenueId) => v === "kraken" ? hasKraken(b) : v === "coinbase" ? hasCoinbase(b) : hasGemini(b);
  if (!needs(buyVenue) || !needs(sellVenue)) { skip("missing API credentials for one or both venues"); return out!; }
  if (!venueSupports(buyVenue, asset) || !venueSupports(sellVenue, asset)) { skip(`${asset} not supported on both venues`); return out!; }
  if (liveNeedsReconcile) { skip(`live runs locked pending manual reconciliation: ${liveNeedsReconcile}. Verify on the exchange, then restart the server.`); return out!; }
  if (execInFlight) { skip("an execution is already in flight"); return out!; }

  let ordersSubmitted = false; // once true, an unexpected exception is NEVER a clean "skipped"
  const sizeUsd = Math.min(EXEC_CAP_USD, Math.max(1, b.sizeUsd ?? EXEC_CAP_USD));
  const minNetUsd = b.minNetUsd ?? DEFAULT_MIN_NET_USD;
  // Freshness is a HARD gate: callers (manual or auto) may tighten it but can
  // never loosen it past the 200ms default.
  const maxQuoteAgeMs = Math.min(b.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS, DEFAULT_MAX_QUOTE_AGE_MS);
  execInFlight = true;
  let lockGen: number | null = null;
  try {
    // 1. DETECTED fees + balances on both venues — refuse to guess.
    //    freshBalances: live preflight must NOT trust any balance cache
    //    (Gemini's verify cache is minutes old; a depleted balance must block).
    const vs = await venueStates(b, { freshBalances: true });
    const bs = vs[buyVenue], ss = vs[sellVenue];
    if (bs.feeSource !== "detected" || ss.feeSource !== "detected") {
      skip(`could not detect REAL fee tiers (never guessing for live): ${bs.error ?? ss.error ?? "keys rejected"}`); return out!;
    }

    // 2. Balance prechecks (Coinbase asset balance fetched on demand).
    //    UNVERIFIED balances (scope/permission issue) are a hard refusal with
    //    the exact reason — never treated as $0 and never guessed past.
    if (bs.usd == null) { skip(`${buyVenue} balances UNVERIFIED — ${bs.error ?? "no balance data"}`); return out!; }
    if (ss.assets == null && sellVenue !== "coinbase") { skip(`${sellVenue} balances UNVERIFIED — ${ss.error ?? "no balance data"}`); return out!; }
    const buyUsdAvail = bs.usd ?? 0;
    let sellAssetAvail = ss.assets?.[asset] ?? 0;
    if (sellVenue === "coinbase") {
      try { sellAssetAvail = await coinbaseAssetBal(b, asset, 0); } catch (e) { skip(`balance check failed: ${(e as Error).message}`); return out!; }
    }
    if (buyUsdAvail < sizeUsd * 1.01) { skip(`insufficient USD on ${buyVenue}: need ~$${(sizeUsd * 1.01).toFixed(2)}, have $${buyUsdAvail.toFixed(2)}`); return out!; }

    // 3. Mandatory exchange metadata for the venues that need it.
    let cbIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>> | null = null;
    if (buyVenue === "coinbase" || sellVenue === "coinbase") {
      const cbPair = cbPairFor(asset);
      if (!cbPair) { skip(`Coinbase order routing not verified for ${asset}`); return out!; }
      try { cbIncs = await getCoinbaseProductIncrements(cbPair); }
      catch (e) { skip(`Coinbase product increments unavailable — refusing to guess order precision: ${(e as Error).message}`); return out!; }
    }
    let gemDetails: GeminiSymbolDetails | null = null;
    if (buyVenue === "gemini" || sellVenue === "gemini") {
      try { gemDetails = await geminiSymbolDetails(`${asset}USD`); }
      catch (e) { skip(`Gemini symbol metadata unavailable — refusing to guess order precision: ${(e as Error).message}`); return out!; }
      if (gemDetails.status !== "open") { skip(`Gemini ${asset}USD market status is '${gemDetails.status}' — not trading`); return out!; }
    }

    // 4. Re-project on CURRENT books with DETECTED fees; all gates re-checked.
    const p = project(asset, buyVenue, sellVenue, sizeUsd, bs.takerPct, ss.takerPct);
    if (!p) { skip("no live depth on one/both venues (or depth cannot absorb the size)"); return out!; }
    // Canonical sanity guard on the FRESH pre-fire projection — an implausible
    // net (unit inversion, corrupt book) must never fire, even under force or
    // big-edge bypasses; those only bypass history gates, never this.
    {
      const sanityErr = routeSanityError(p.sizeUsd, p.netProfitUsd, p.grossSpreadUsd);
      if (sanityErr) { skip(sanityErr, { projection: p }); return out!; }
    }
    if (p.quoteAgeMs > maxQuoteAgeMs) { skip(`books stale: oldest leg ${p.quoteAgeMs}ms > ${maxQuoteAgeMs}ms`, { projection: p }); return out!; }
    if (p.netAfterBufferUsd < minNetUsd) { skip(`net-after-buffer $${p.netAfterBufferUsd.toFixed(4)} below floor $${minNetUsd.toFixed(2)} — never firing a negative/thin edge`, { projection: p }); return out!; }
    if (gemDetails && p.baseQty < gemDetails.minOrderSize * 1.02) { skip(`quantity ${p.baseQty.toFixed(8)} too close to Gemini min ${gemDetails.minOrderSize} — partial quantization could breach the minimum`, { projection: p }); return out!; }
    if (sellAssetAvail < p.baseQty * 1.02) { skip(`insufficient pre-positioned ${asset} on ${sellVenue}: need ~${(p.baseQty * 1.02).toFixed(8)}, have ${sellAssetAvail.toFixed(8)}`, { projection: p }); return out!; }

    // 5. Shared live lock — same lock every other executor gates on.
    lockGen = tryAcquireSharedLiveLock();
    if (lockGen == null) { skip("another live executor holds the execution lock", { projection: p }); return out!; }

    const tag = `${buyVenue}-buy→${sellVenue}-sell`;

    // 6. Leg 1: BUY. Confirmed actual fill is the only truth.
    ordersSubmitted = true;
    const buyRes = await runLeg(buyVenue, "buy", asset, p.baseQty, b, cbIncs, gemDetails, buyVenue === "gemini" ? bs.takerPct : null);
    if (buyRes.explicitReject) { skip(`${buyVenue} buy rejected by the exchange — nothing traded: ${buyRes.explicitReject}`, { projection: p }); return out!; }
    if (buyRes.indeterminate) {
      liveNeedsReconcile = buyRes.indeterminate;
      await ledgerIndeterminate(asset, tag, buyRes.indeterminate, buyRes.leg.orderId);
      res.json({ executed: true, outcome: "indeterminate", reason: `${buyRes.indeterminate} — check the exchange before trading again. Live runs locked.`, asset, buyVenue, sellVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: buyRes.leg, sellLeg: null, realizedProfitUsd: null, projection: p });
      return out!;
    }
    const buyLeg = buyRes.leg;
    if (buyLeg.filledQty <= 1e-12) { skip(`buy leg terminal with zero fill (${buyLeg.status}) — nothing traded`, { projection: p, buyLeg }); return out!; }
    if (!liveLockOwned(lockGen)) {
      liveNeedsReconcile = `${buyVenue} BUY ${buyLeg.orderId} filled ${buyLeg.filledQty.toFixed(8)} ${asset} but execution was killed before the sell`;
      res.json({ executed: true, outcome: "unhedged", reason: liveNeedsReconcile, asset, buyVenue, sellVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg, sellLeg: null, realizedProfitUsd: null, projection: p });
      return out!;
    }

    // 7. Leg 2: SELL the CONFIRMED quantity, quantized DOWN to the sell
    // venue's step BEFORE submission so the number we judge completion by is
    // the number the exchange was actually asked for. The quantization dust
    // (buy fill − submitted target) is bounded to ≤1 step and ≤$0.02 notional,
    // or the cycle is NOT called completed.
    const sellStep = sellVenue === "coinbase" && cbIncs ? parseFloat(cbIncs.baseIncrement)
      : sellVenue === "gemini" && gemDetails ? gemDetails.tickSize
      : 1e-8;
    const rawTarget = Math.min(buyLeg.filledQty, sellAssetAvail);
    const sellTarget = sellVenue === "gemini" && gemDetails ? geminiQuantizeQty(rawTarget, gemDetails.tickSize)
      : sellVenue === "coinbase" && cbIncs ? quantizeDown(rawTarget, cbIncs.baseIncrement).value
      : rawTarget;
    const quantDust = Math.max(0, buyLeg.filledQty - sellTarget);
    const dustNotionalUsd = quantDust * ((p.baseQty > 0 ? p.sizeUsd / p.baseQty : 0));
    const sellRes = await runLeg(sellVenue, "sell", asset, sellTarget, b, cbIncs, gemDetails, sellVenue === "gemini" ? ss.takerPct : null);
    const sellLeg = sellRes.leg;
    if (sellRes.indeterminate) {
      liveNeedsReconcile = sellRes.indeterminate;
      await ledgerIndeterminate(asset, tag, sellRes.indeterminate, buyLeg.orderId);
    }
    // Completion policy (strict): the SUBMITTED quantized target must be
    // fully filled (≤ float epsilon short), AND the quantization dust left on
    // the buy venue must be ≤1 sell-venue step AND ≤$0.02 notional. Anything
    // bigger is a real residual — the cycle is partial, never "completed".
    const fullySold = !sellRes.indeterminate && !sellRes.explicitReject
      && sellLeg.filledQty >= sellTarget - sellStep * 1e-6
      && quantDust <= sellStep * (1 + 1e-9)
      && dustNotionalUsd <= 0.02;
    const buyCost = (buyLeg.notionalUsd ?? 0) + (buyLeg.feeUsd ?? 0);
    const realized = fullySold && sellLeg.notionalUsd != null ? (sellLeg.notionalUsd - (sellLeg.feeUsd ?? 0)) - buyCost : null;
    const residual = Math.max(0, buyLeg.filledQty - sellLeg.filledQty);
    const outcome = sellRes.indeterminate ? "indeterminate" : fullySold ? "completed" : sellLeg.filledQty <= 1e-12 ? "sell_failed" : "partial_sell";

    try {
      await db.insert(tradesTable).values({
        pair: `XV:${asset} ${tag}${outcome !== "completed" ? ` [${outcome}: residual ${residual.toFixed(8)}]` : ""}`,
        buyExchange: buyVenue, sellExchange: sellVenue,
        volume: buyLeg.filledQty.toFixed(8),
        estimatedProfitUsd: p.netProfitUsd.toFixed(6), netEdgePct: "0", isDryRun: false,
        krakenPrice: (buyVenue === "kraken" ? buyLeg.avgPrice ?? 0 : sellVenue === "kraken" ? sellLeg.avgPrice ?? 0 : 0).toFixed(8),
        coinbasePrice: (buyVenue === "coinbase" ? buyLeg.avgPrice ?? 0 : sellVenue === "coinbase" ? sellLeg.avgPrice ?? 0 : 0).toFixed(8),
        buyOrderId: buyLeg.orderId, sellOrderId: sellLeg.orderId,
        status: outcome === "completed" ? "verified" : "unhedged",
        realizedProfitUsd: realized != null ? realized.toFixed(6) : null,
      });
    } catch (e) { log.error({ err: e }, "[XV] ledger write failed"); }

    log.info({ asset, buyVenue, sellVenue, outcome, realized, expected: p.netProfitUsd }, "[XV] execution finished");
    res.json({
      executed: true, outcome,
      reason: outcome === "completed"
        ? `expected $${p.netProfitUsd.toFixed(4)}, realized $${realized!.toFixed(4)} (confirmed fills only)`
        : `sell leg ${sellLeg.status}${sellRes.explicitReject ? `: ${sellRes.explicitReject}` : ""} — residual ${residual.toFixed(8)} ${asset} remains long${liveNeedsReconcile ? "; live runs locked pending reconciliation" : ""}`,
      asset, buyVenue, sellVenue, startedAt, finishedAt: new Date().toISOString(),
      buyLeg, sellLeg, realizedProfitUsd: realized, projection: p,
      geminiFeeNote: (buyVenue === "gemini" || sellVenue === "gemini") ? "Gemini leg fee computed from YOUR verified taker tier on the confirmed notional (order status API reports no per-order fee)" : null,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (ordersSubmitted) {
      // An order may exist on an exchange and we don't know its state — this
      // can NEVER be reported as a clean skip. Latch live runs off, ledger it.
      const note = `unexpected error after order submission: ${msg}`;
      liveNeedsReconcile = note;
      await ledgerIndeterminate(asset, `${buyVenue}-buy→${sellVenue}-sell`, note, null);
      res.json({ executed: true, outcome: "indeterminate", reason: `${note} — verify both exchanges manually; live runs locked pending reconciliation.`, asset, buyVenue, sellVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: null, sellLeg: null, realizedProfitUsd: null, projection: null });
    } else {
      res.json({ executed: false, outcome: "skipped", reason: msg, asset, buyVenue, sellVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: null, sellLeg: null, realizedProfitUsd: null, projection: null });
    }
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
    execInFlight = false;
  }
  return out!;
}

router.post("/arb/xv-execute", async (req, res): Promise<void> => {
  const parsed = ExecuteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  res.json(await executeXvCycle(parsed.data, req.log as unknown as XvLogger));
});


// ── AUTO-EXECUTE ENGINE (event-driven from live WebSocket book updates) ──────
//
// Armed via POST /arb/xv-auto/start with API keys. Fires ONLY when every hard
// guard passes on the SAME fresh snapshot that produced the displayed net:
//   verified keys + DETECTED fee tiers + verified balances/inventory +
//   exchange minimums + depth at size + net-after-buffer ≥ floor + both legs
//   ≤ maxQuoteAgeMs (hard-clamped to the 200ms default — arming can TIGHTEN
//   freshness, never loosen it).
// Every book update re-evaluates only the affected asset's routes; a FIRE
// calls the same executeXvCycle used by manual EXECUTE (which re-projects and
// re-checks everything again). No auto-transfers, ever: missing sell-venue
// inventory stays a blocker.

type XvAutoLogEntry = {
  at: string; asset: string; buyVenue: LiveVenueId; sellVenue: LiveVenueId; sizeUsd: number;
  buyAgeMs: number; sellAgeMs: number;
  feeSourceBuy: string; feeSourceSell: string;
  balancesOk: boolean | null; depthOk: boolean;
  scannerNetUsd: number;        // net profit before buffer (what the scanner ranks by)
  executableNetUsd: number;     // net after buffer — must clear the floor to fire
  floorUsd: number;
  decision: "FIRE" | "SKIP"; reason: string;
  outcome: string | null; realizedUsd: number | null; // filled in after a FIRE completes
};

const AUTO_LOG_CAP = 400;
const AUTO_FIRE_COOLDOWN_MS = 10_000;
const AUTO_EVAL_DEBOUNCE_MS = 200;

let autoState: {
  armed: boolean; startedAt: string; pausedReason: string | null;
  creds: Creds;                        // in-memory only; wiped on stop/restart
  minNetUsd: number; maxQuoteAgeMs: number;
  verifiedVenues: LiveVenueId[];
  vs: Record<LiveVenueId, VenueState>; // cached venue fees/balances; refreshed periodically + after fires
  evals: number; fires: number; lastFireAt: number;
  unsub: (() => void) | null; refreshTimer: NodeJS.Timeout | null;
} | null = null;
const autoLog: XvAutoLogEntry[] = [];
function autoLogPush(e: XvAutoLogEntry): void { autoLog.push(e); if (autoLog.length > AUTO_LOG_CAP) autoLog.splice(0, autoLog.length - AUTO_LOG_CAP); }

// restKey → asset reverse maps for the three feeds.
function assetForBookKey(restKey: string): string | null {
  if (restKey.startsWith("CB:")) { const m = restKey.slice(3).match(/^(.+)-USD$/); return m ? m[1]! : null; }
  if (restKey.startsWith("GEM:")) { const m = restKey.slice(4).match(/^(.+)USD$/); return m ? m[1]! : null; }
  for (const [asset, k] of Object.entries(OB_USD_PAIRS as Record<string, string>)) if (k === restKey) return asset;
  for (const [asset, k] of Object.entries(KRAKEN_EXTRA_PAIRS)) if (k === restKey) return asset;
  return null;
}

const autoLastEval = new Map<string, number>();  // per-asset debounce
const autoEvalBusy = new Set<string>();          // per-asset in-flight guard

function onAutoBookUpdate(restKey: string): void {
  const st = autoState;
  if (!st?.armed || st.pausedReason || liveNeedsReconcile || execInFlight) return;
  const asset = assetForBookKey(restKey);
  if (!asset) return;
  const now = Date.now();
  if (now - (autoLastEval.get(asset) ?? 0) < AUTO_EVAL_DEBOUNCE_MS || autoEvalBusy.has(asset)) return;
  autoLastEval.set(asset, now);
  autoEvalBusy.add(asset);
  autoEvalAsset(asset).catch(err => console.error("[XV-AUTO] eval error", asset, (err as Error).message)).finally(() => autoEvalBusy.delete(asset));
}

async function autoEvalAsset(asset: string): Promise<void> {
  const st = autoState;
  if (!st?.armed) return;
  // Stop barrier: after EVERY await, the engine must confirm this exact arm
  // session is still live — /stop or a re-arm invalidates it instantly.
  const stillArmed = () => autoState === st && st.armed && !st.pausedReason;
  st.evals++;
  const routes = await evalRoutesForAsset(asset, st.vs, st.creds, st.minNetUsd, st.maxQuoteAgeMs);
  if (!stillArmed()) return;
  for (const r of routes) {
    // Only auto-consider pairs where BOTH venues were verified at arm time.
    const verified = st.verifiedVenues.includes(r.buyVenue) && st.verifiedVenues.includes(r.sellVenue);
    const g = r.bestFeasible ?? r.best;
    if (!g) continue;
    const entryBase = {
      at: new Date().toISOString(), asset, buyVenue: r.buyVenue, sellVenue: r.sellVenue, sizeUsd: g.sizeUsd,
      buyAgeMs: g.buyAgeMs, sellAgeMs: g.sellAgeMs, feeSourceBuy: r.feeSourceBuy, feeSourceSell: r.feeSourceSell,
      balancesOk: r.balancesOk, depthOk: r.bestFeasible != null,
      scannerNetUsd: g.netProfitUsd, executableNetUsd: g.netAfterBufferUsd, floorUsd: st.minNetUsd,
    };
    // Log near-positives and fires only — the log is a decision record, not a firehose.
    const worthLogging = r.decision === "FIRE" || g.netAfterBufferUsd > -0.05;
    if (r.decision !== "FIRE" || !verified) {
      if (worthLogging) autoLogPush({ ...entryBase, decision: "SKIP", reason: verified ? r.reason : `venue not verified at arm time (${r.reason})`, outcome: null, realizedUsd: null });
      continue;
    }
    // FIRE path — cooldown + latch checks, then the shared execution core
    // (which re-projects on the same live books and re-checks EVERY guard).
    if (Date.now() - st.lastFireAt < AUTO_FIRE_COOLDOWN_MS) {
      autoLogPush({ ...entryBase, decision: "SKIP", reason: "auto-fire cooldown", outcome: null, realizedUsd: null });
      continue;
    }
    if (!stillArmed() || liveNeedsReconcile || execInFlight) return;
    st.lastFireAt = Date.now();
    const logEntry: XvAutoLogEntry = { ...entryBase, decision: "FIRE", reason: r.reason, outcome: "in-flight", realizedUsd: null };
    autoLogPush(logEntry);
    const logger: XvLogger = {
      info: (o, m) => console.log(`[XV-AUTO] ${m}`, JSON.stringify(o)),
      error: (o, m) => console.error(`[XV-AUTO] ${m}`, JSON.stringify(o)),
    };
    if (!stillArmed()) { logEntry.outcome = "aborted: auto-execute disarmed before submission"; return; }
    const result = await executeXvCycle({ ...st.creds, asset, buyVenue: r.buyVenue, sellVenue: r.sellVenue, sizeUsd: g.sizeUsd, minNetUsd: st.minNetUsd, maxQuoteAgeMs: st.maxQuoteAgeMs } as z.infer<typeof ExecuteBody>, logger);
    logEntry.outcome = String(result.outcome);
    logEntry.realizedUsd = (result.realizedProfitUsd as number | null) ?? null;
    if (result.outcome === "completed" || result.outcome === "partial") st.fires++;
    if (result.outcome === "skipped") logEntry.reason = `${r.reason} → exec-core refused: ${String(result.reason)}`;
    if (result.outcome === "unhedged" || result.outcome === "indeterminate") {
      st.pausedReason = `auto-execute paused after ${result.outcome} outcome: ${String(result.reason)}`;
    }
    // Balances changed — refresh the cached venue state before the next eval.
    try { autoState && (autoState.vs = await venueStates(st.creds)); } catch { /* next timer refresh will retry */ }
    return; // one fire per event burst; the next book update re-evaluates
  }
}

const AutoStartBody = CredsBody.extend({
  minNetUsd: z.number().min(0.01).optional(),
  maxQuoteAgeMs: z.number().positive().optional(),
});

let autoStarting = false;
router.post("/arb/xv-auto/start", async (req, res): Promise<void> => {
  const parsed = AutoStartBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  if (autoState?.armed || autoStarting) { res.status(409).json({ error: "auto-execute is already armed (or arming) — stop it first" }); return; }
  autoStarting = true;
  try {
  if (liveNeedsReconcile) { res.status(409).json({ error: `live runs locked pending manual reconciliation: ${liveNeedsReconcile}` }); return; }

  const minNetUsd = b.minNetUsd ?? DEFAULT_MIN_NET_USD;
  // Freshness can only be TIGHTENED, never loosened past the 200ms hard gate.
  const maxQuoteAgeMs = Math.min(b.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS, DEFAULT_MAX_QUOTE_AGE_MS);

  try { await refreshGeminiUniverse(); } catch { /* stale universe reused */ }
  const vs = await venueStates(b);
  const verifiedVenues = (Object.entries(vs) as Array<[LiveVenueId, VenueState]>)
    .filter(([, v]) => v.feeSource === "detected" && v.usd != null && !v.error)
    .map(([id]) => id);
  if (verifiedVenues.length < 2) {
    res.status(400).json({
      error: "auto-execute needs at least TWO venues with verified keys, DETECTED fee tiers, and verified balances",
      venues: (Object.entries(vs) as Array<[LiveVenueId, VenueState]>).map(([id, v]) => ({
        id, verified: v.feeSource === "detected" && v.usd != null && !v.error,
        why: v.error ?? (v.feeSource !== "detected" ? "fees not detected (keys missing/rejected)" : v.usd == null ? "balances unverified" : null),
      })),
    });
    return;
  }

  autoState = {
    armed: true, startedAt: new Date().toISOString(), pausedReason: null,
    creds: b, minNetUsd, maxQuoteAgeMs, verifiedVenues, vs,
    evals: 0, fires: 0, lastFireAt: 0,
    unsub: onBookUpdate(onAutoBookUpdate),
    refreshTimer: setInterval(() => {
      const st = autoState;
      if (!st?.armed) return;
      venueStates(st.creds).then(v => { if (autoState?.armed) autoState.vs = v; }).catch(() => { /* keep last verified state */ });
    }, 60_000),
  };
  res.json({
    armed: true, startedAt: autoState.startedAt, verifiedVenues, minNetUsd, maxQuoteAgeMs,
    note: "Event-driven: every WebSocket book tick re-evaluates the affected asset and fires the shared execution core only when ALL hard guards pass on that same fresh snapshot. Keys are held in memory only and wiped on stop or server restart.",
  });
  } finally { autoStarting = false; }
});

router.post("/arb/xv-auto/stop", async (_req, res): Promise<void> => {
  const st = autoState;
  if (!st) { res.json({ armed: false, note: "auto-execute was not armed" }); return; }
  st.armed = false;
  st.unsub?.();
  if (st.refreshTimer) clearInterval(st.refreshTimer);
  autoState = null; // creds wiped
  res.json({ armed: false, note: "auto-execute disarmed; keys wiped from memory" });
});

router.get("/arb/xv-auto/status", async (_req, res): Promise<void> => {
  const st = autoState;
  res.json({
    armed: st?.armed ?? false,
    startedAt: st?.startedAt ?? null,
    pausedReason: st?.pausedReason ?? null,
    liveNeedsReconcile,
    verifiedVenues: st?.verifiedVenues ?? [],
    minNetUsd: st?.minNetUsd ?? null,
    maxQuoteAgeMs: st?.maxQuoteAgeMs ?? null,
    evals: st?.evals ?? 0,
    fires: st?.fires ?? 0,
    lastFireAt: st && st.lastFireAt ? new Date(st.lastFireAt).toISOString() : null,
    log: [...autoLog].reverse().slice(0, 100),
  });
});


// ── POST /arb/xv-plan — inventory / pre-positioning planner ──────────────────
//
// For every positive-net route on CURRENT books: exactly what must sit where
// BEFORE execution (no transfers ever happen during a trade).
//  - buy venue: USD for the notional + taker fee + 1% safety margin
//  - sell venue: base qty + 2% safety margin (same margins execution enforces)
// Compared against VERIFIED live balances → READY / SHORT by exact amount /
// UNVERIFIED (never a guessed requirement against an unverified balance).
router.post("/arb/xv-plan", async (req, res): Promise<void> => {
  const parsed = CredsBody.safeParse(req.body ?? {});
  const c: Creds = parsed.success ? parsed.data : {};
  const q = req.query as Record<string, string | undefined>;
  const minNetUsd = parseFloat(q.minNetUsd ?? "") || DEFAULT_MIN_NET_USD;

  try { await refreshGeminiUniverse(); } catch { /* stale universe reused */ }
  const vs = await venueStates(c);

  // Evaluate with a RELAXED freshness gate for planning only: funding decisions
  // shouldn't flap because a thin book last ticked 3s ago. Execution keeps 200ms.
  const PLAN_MAX_AGE_MS = 60_000;
  const routes: Route[] = [];
  const assets = [...new Set([...OB_ASSETS, "USDC"])];
  for (const asset of assets) routes.push(...await evalRoutesForAsset(asset, vs, c, minNetUsd, PLAN_MAX_AGE_MS));

  type Req = {
    venue: LiveVenueId; kind: "quote" | "base"; asset: string;
    requiredAmount: number;      // USD for quote-side, base qty for base-side
    requiredUsdValue: number;    // approximate USD value of the requirement
    haveAmount: number | null;   // null = balance UNVERIFIED for this venue
    status: "READY" | "SHORT" | "UNVERIFIED";
    shortBy: number | null;      // exact missing amount (same unit as requiredAmount)
  };
  type PlanRoute = {
    asset: string; buyVenue: LiveVenueId; sellVenue: LiveVenueId; sizeUsd: number;
    netAfterBufferUsd: number; quoteAgeMs: number;
    feeSourceBuy: string; feeSourceSell: string;
    minNotionalUsd: number | null;
    requirements: Req[];
    executableNow: boolean;      // both requirements READY + fees detected
    blocker: string;
  };

  const mkReq = (venue: LiveVenueId, kind: "quote" | "base", asset: string, required: number, usdValue: number): Req => {
    const st = vs[venue];
    let have: number | null = null;
    if (st.usd != null) have = kind === "quote" ? st.usd : (st.assets?.[asset] ?? 0);
    // Coinbase base-side inventory is per-asset — not in st.assets; leave null
    // (UNVERIFIED for planning) unless it IS the USD side.
    if (venue === "coinbase" && kind === "base") have = null;
    const status: Req["status"] = have == null ? "UNVERIFIED" : have >= required ? "READY" : "SHORT";
    return { venue, kind, asset, requiredAmount: required, requiredUsdValue: usdValue, haveAmount: have, status, shortBy: status === "SHORT" ? required - (have ?? 0) : null };
  };

  const planRoutes: PlanRoute[] = [];
  for (const r of routes) {
    const g = r.bestFeasible ?? r.best;
    if (!g || g.netAfterBufferUsd < minNetUsd) continue; // planner covers genuinely positive routes only
    const buyFeeFrac = r.buyTakerPct / 100;
    const reqUsd = g.sizeUsd * (1 + buyFeeFrac) * 1.01;      // notional + taker fee + 1% margin
    const reqQty = g.baseQty * 1.02;                          // base + 2% margin (mirrors executor)
    const reqs = [
      mkReq(r.buyVenue, "quote", "USD", reqUsd, reqUsd),
      mkReq(r.sellVenue, "base", r.asset, reqQty, g.sizeUsd * 1.02),
    ];
    const feesDetected = r.feeSourceBuy === "detected" && r.feeSourceSell === "detected";
    planRoutes.push({
      asset: r.asset, buyVenue: r.buyVenue, sellVenue: r.sellVenue, sizeUsd: g.sizeUsd,
      netAfterBufferUsd: g.netAfterBufferUsd, quoteAgeMs: g.quoteAgeMs,
      feeSourceBuy: r.feeSourceBuy, feeSourceSell: r.feeSourceSell,
      minNotionalUsd: r.minNotionalUsd,
      requirements: reqs,
      executableNow: feesDetected && reqs.every(x => x.status === "READY"),
      blocker: r.blocker,
    });
  }
  planRoutes.sort((a, b) => b.netAfterBufferUsd - a.netAfterBufferUsd);

  // Consolidated "what to fund where": per venue, the MAX quote USD needed
  // across positive routes buying there, plus every base-asset requirement
  // selling there (max per asset). Covers the listed routes in either
  // direction with no mid-trade transfers.
  const funding: Record<LiveVenueId, { usdNeeded: number; usdHave: number | null; assets: Array<{ asset: string; qtyNeeded: number; usdValue: number; have: number | null; status: Req["status"]; shortBy: number | null }> }> =
    { kraken: { usdNeeded: 0, usdHave: vs.kraken.usd, assets: [] }, coinbase: { usdNeeded: 0, usdHave: vs.coinbase.usd, assets: [] }, gemini: { usdNeeded: 0, usdHave: vs.gemini.usd, assets: [] } };
  for (const pr of planRoutes) {
    for (const rq of pr.requirements) {
      const f = funding[rq.venue];
      if (rq.kind === "quote") f.usdNeeded = Math.max(f.usdNeeded, rq.requiredAmount);
      else {
        const existing = f.assets.find(a => a.asset === rq.asset);
        if (existing) {
          if (rq.requiredAmount > existing.qtyNeeded) { existing.qtyNeeded = rq.requiredAmount; existing.usdValue = rq.requiredUsdValue; existing.have = rq.haveAmount; existing.status = rq.status; existing.shortBy = rq.shortBy; }
        } else f.assets.push({ asset: rq.asset, qtyNeeded: rq.requiredAmount, usdValue: rq.requiredUsdValue, have: rq.haveAmount, status: rq.status, shortBy: rq.shortBy });
      }
    }
  }

  res.json({
    plannedAt: new Date().toISOString(),
    minNetUsd,
    note: "Planning uses a relaxed 60s book-age window so funding advice doesn't flap; EXECUTION still requires ≤200ms freshness, detected fees, verified balances, and positive net. Requirements: buy side = notional + taker fee + 1% margin; sell side = base qty + 2% margin — the same margins the executor enforces. UNVERIFIED means the balance could not be verified for that venue/scope — it is never treated as $0 or as sufficient.",
    venues: (Object.entries(vs) as Array<[LiveVenueId, VenueState]>).map(([id, v]) => ({ id, feeSource: v.feeSource, takerPct: v.takerPct, usd: v.usd, balancesVerified: v.usd != null, error: v.error })),
    routes: planRoutes.slice(0, 12),
    funding,
  });
});

// ── GET /arb/xv-stats ─────────────────────────────────────────────────────────
router.get("/arb/xv-stats", async (_req, res) => {
  const { sql } = await import("drizzle-orm");
  const filter = sql`${tradesTable.pair} LIKE 'XV:%' AND ${tradesTable.isDryRun} = false`;
  const [agg] = await db.select({
    trades: sql<number>`count(*)::int`,
    completed: sql<number>`count(${tradesTable.realizedProfitUsd})::int`,
    realizedTotal: sql<string>`coalesce(sum(${tradesTable.realizedProfitUsd}::numeric), 0)::text`,
  }).from(tradesTable).where(filter);
  res.json({
    trades: agg?.trades ?? 0, completed: agg?.completed ?? 0,
    incomplete: (agg?.trades ?? 0) - (agg?.completed ?? 0),
    cumulativeRealizedUsd: parseFloat(agg?.realizedTotal ?? "0"),
  });
});

export default router;
