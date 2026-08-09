/**
 * MAKER-HEDGE ENGINE — the primary profit-seeking strategy.
 *
 * WHY: the live-fill audit proved this account pays ~1.20% taker on Coinbase
 * but only ~0.60% maker there and ~0.40% taker on Kraken. Posting the maker
 * leg on Coinbase and hedging taker on Kraken cuts the total fee stack from
 * ~1.60% (taker-taker) to ~1.00% AND earns the spread on the maker side.
 * The scanner also projects the REVERSE structure (Kraken maker + Coinbase
 * taker hedge) and reports when it is superior, but AUTO only fires the
 * hardened Coinbase-maker executor.
 *
 * Execution flow (one $10 cycle):
 *  1. REAL fees only: detected from the account, or the run is refused.
 *  2. Projects on live books (depth-walked hedge); refuses unless projected
 *     net ≥ floor + safety buffer. Floor is configurable, DEFAULT $0.01 net
 *     after all costs, and can never be set ≤ 0 — the engine never
 *     intentionally takes negative-expectancy trades.
 *  3. Inventory precheck for BOTH legs before any order.
 *  4. Posts a POST-ONLY limit on Coinbase joining the top of our side.
 *  5. While resting: re-projects the hedge every tick; if it drops below
 *     floor + buffer, the maker order is CANCELLED (confirmed) — no hedge is
 *     ever opened for an unfilled order.
 *  6. Only after a CONFIRMED fill does the hedge fire on Kraken: bounded IOC
 *     for exactly the confirmed quantity. Hedging a confirmed fill takes
 *     priority even if the fresh projection dropped below the floor (holding
 *     a naked position is strictly worse); the realized number tells the
 *     truth. Partial hedge ⇒ "unhedged", realized stays null.
 *  7. Every ambiguity latches live runs off until manually reconciled.
 *     Shared live-execution lock prevents double-fire with other executors.
 *
 * AUTO mode: a server-side watcher scans every few seconds and fires ONE
 * cycle at a time only when a route clears the full gate (fees + depth +
 * slippage + buffer + inventory + freshness). It stops itself on any
 * unhedged/indeterminate outcome. $10 hard cap — never auto-scaled.
 *
 * Ledger prefix "MM2:". GET /arb/cb-mm-stats aggregates the FULL history.
 */
import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ExecuteCbMmBody, MmScanBody, MmAutoStartBody } from "@workspace/api-zod";
import { projectCbMakerHedge, projectMakerHedge, projectTakerTaker, projectVenueMakerHedge, type MmProjection, type MmDirection, type MmVenue } from "../lib/cross-mm";
import { OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
import {
  getKrakenBalances,
  getCoinbaseBalances,
  getCoinbaseAssetDetail,
  getCoinbaseFeeTier,
  krakenFeeTiers,
  krakenIocLimitOrder,
  krakenRawIocLimitOrder,
  krakenRawLimitOrder,
  krakenOrderInfo,
  coinbaseLimitOrder,
  coinbaseIocLimitOrder,
  coinbaseCancelOrder,
  krakenCancelOrder,
  coinbaseOrderDetails,
  getCoinbaseProductIncrements,
  getCoinbaseBidAsk,
  quantizeDown,
  PAIRS,
  type Pair,
  bindLockHeartbeat,
} from "../lib/exchange";
import { geminiVerify, type GeminiCreds, type GeminiAccount } from "../lib/gemini";
import {
  geminiMakerOrCancelOrder,
  geminiIocLimitOrder,
  geminiOrderStatus,
  geminiCancelOrder,
  geminiQuantizeQty,
  geminiSymbolDetails,
  geminiSymbols,
  isExplicitGeminiReject,
  type GeminiSymbolDetails,
} from "../lib/gemini-exec";
import { getGeminiStreamBook, startGeminiBookStream } from "../lib/book-stream";
import { tryAcquireSharedLiveLock, releaseLiveLock, touchLiveLock, liveLockOwned, liveLockHeartbeat } from "./arb";

const router: IRouter = Router();

/** Liquid spot assets available on BOTH venues' order paths with live books. */
const MM_ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "LINK", "DOGE", "AVAX", "LTC",
  "ADA", "DOT", "UNI", "AAVE", "ATOM", "BCH", "FIL",
] as const satisfies readonly ObAsset[];
type MmAsset = typeof MM_ASSETS[number];
const cbPairOf = (a: MmAsset): Pair => `${a}/USD` as Pair;

// ── Venue-agnostic maker-hedge across kraken/coinbase/gemini ─────────────────
// Every venue id is normalized to lowercase BEFORE any lookup — display-cased
// labels ("Kraken", "Gemini") have caused silent safety no-ops before.
type MmVenueId = MmVenue; // "kraken" | "coinbase" | "gemini"
const MM_VENUES: MmVenueId[] = ["kraken", "coinbase", "gemini"];
export function normVenue(v: string): MmVenueId | null {
  const s = v.trim().toLowerCase();
  return s === "kraken" || s === "coinbase" || s === "gemini" ? s : null;
}
const venueLabel: Record<MmVenueId, string> = { kraken: "kraken", coinbase: "coinbase", gemini: "gemini" };

/** A Coinbase leg is only executable for assets in the verified PAIRS union. */
function cbPairFor(asset: string): Pair | null {
  const p = `${asset}/USD`;
  return (PAIRS as readonly string[]).includes(p) ? (p as Pair) : null;
}

// Gemini USD universe (UPPER asset codes). cross-venue.ts already starts the
// Gemini book stream for the whole OB asset set at module load, so we only
// compute which MM_ASSETS Gemini lists (no new symbols → no reconnect churn).
let geminiListed = new Set<string>();
let geminiUniverseAt = 0;
async function refreshMmGeminiUniverse(): Promise<void> {
  if (Date.now() - geminiUniverseAt < 6 * 3600_000 && geminiListed.size) return;
  const syms = await geminiSymbols(); // lowercase like "btcusd"
  const usd = new Set(syms.filter(s => s.endsWith("usd")).map(s => s.slice(0, -3).toUpperCase()));
  const wanted = (MM_ASSETS as readonly string[]).filter(a => usd.has(a));
  geminiListed = new Set(wanted);
  geminiUniverseAt = Date.now();
  startGeminiBookStream(wanted.map(a => `${a}USD`)); // idempotent; subset already subscribed
}
void refreshMmGeminiUniverse().catch(e => console.warn("[MM2] Gemini universe fetch failed (retries next scan):", (e as Error).message));

function venueListsAsset(v: MmVenueId, asset: MmAsset): boolean {
  if (v === "kraken") return asset in OB_USD_PAIRS;
  if (v === "coinbase") return cbPairFor(asset) != null;
  return geminiListed.has(asset);
}

const POLL_MS = 700;
const TERMINAL_WAIT_MS = 25_000;
const DEFAULT_REST_WINDOW_SEC = 30;
const MAX_REST_WINDOW_SEC = 120;
// User's strict rule: "Default freshness window: 200 ms. If any required leg
// is older than 200 ms, the entire route is stale. Do not execute."
const DEFAULT_MAX_QUOTE_AGE_MS = 200;
/** Scanner vs pre-fire tolerance on the SAME snapshot ($). Beyond this we
 *  refuse to fire and log PRICING CONSISTENCY ERROR. */
const CONSISTENCY_TOLERANCE_USD = 0.005;
const SIZE_USD_CAP = 10; // HARD cap — never auto-scaled

// Profit floor: configurable, DEFAULT $0.01 net after ALL costs (maker fee,
// hedge taker fee, depth-walked slippage). Never ≤ 0 — combined with the
// safety buffer the engine never knowingly takes a negative-expectancy trade.
// (The old fixed $0.25 floor is gone by explicit user decision 2026-08-08.)
const MIN_FLOOR_USD = 0.01;
const floorFor = (requested?: number | null) => Math.max(MIN_FLOOR_USD, requested ?? MIN_FLOOR_USD);
const bufferFor = (sizeUsd: number, override?: number) =>
  override != null && override >= 0 ? override : Math.max(0.02, sizeUsd * 0.002);

function isExplicitKrakenReject(msg: string): boolean {
  return /EOrder:|EGeneral:Invalid|EAPI:Invalid|EFunding:|ETrade:/.test(msg);
}

let execInFlight = false;
let liveNeedsReconcile: string | null = null;

export type Creds = { krakenKey: string; krakenSecret: string; coinbaseKey: string; coinbaseSecret: string };
type Logger = { info: (x: object, m?: string) => void; error: (x: object, m?: string) => void };

async function ledgerRow(o: {
  asset: string; direction: MmDirection; note: string; volume: number;
  makerPx: number; hedgePx: number; makerId: string | null; hedgeId: string | null;
  status: string; realized: number | null; expected: number;
}, log: Logger): Promise<void> {
  try {
    await db.insert(tradesTable).values({
      pair: `MM2:${o.asset} CB-${o.direction}-maker→K-hedge${o.note ? ` [${o.note.slice(0, 110)}]` : ""}`,
      buyExchange: o.direction === "buy" ? "coinbase" : "kraken",
      sellExchange: o.direction === "buy" ? "kraken" : "coinbase",
      volume: o.volume.toFixed(8),
      estimatedProfitUsd: o.expected.toFixed(6), netEdgePct: "0", isDryRun: false,
      krakenPrice: o.hedgePx.toFixed(8), coinbasePrice: o.makerPx.toFixed(8),
      buyOrderId: o.direction === "buy" ? o.makerId : o.hedgeId,
      sellOrderId: o.direction === "buy" ? o.hedgeId : o.makerId,
      status: o.status,
      realizedProfitUsd: o.realized != null ? o.realized.toFixed(6) : null,
    });
  } catch (e) { log.error({ err: e }, "[MM2] ledger write failed"); }
}

// ── Fee & balance caches (bounded staleness, keyed by key material) ──────────
const FEE_CACHE_MS = 10 * 60_000;
const BAL_CACHE_MS = 20_000;
import { detectFees, type Fees } from "../lib/fees";
export type { Fees };
const feeCache = new Map<string, Fees>();
export type Balances = { kUsd: number; cbUsd: number; kAssets: Map<string, number>; cbAssets: Map<string, number>; fetchedAt: number };
const balCache = new Map<string, Balances>();
const credKey = (c: Creds) => `${c.krakenKey}:${c.coinbaseKey}`;

export { detectFees };

export function krakenCodesFor(asset: string): string[] {
  if (asset === "BTC") return ["XXBT", "XBT", "BTC"];
  if (asset === "DOGE") return ["XXDG", "XDG", "DOGE"];
  return [`X${asset}`, asset];
}

export async function fetchBalances(creds: Creds, fresh = false): Promise<Balances> {
  const k = credKey(creds);
  const hit = balCache.get(k);
  if (!fresh && hit && Date.now() - hit.fetchedAt < BAL_CACHE_MS) return hit;
  const [kBals, cbBals] = await Promise.all([getKrakenBalances(creds, true), getCoinbaseBalances(creds)]);
  const kAssets = new Map<string, number>();
  let kUsd = 0;
  for (const x of kBals) {
    if (["ZUSD", "USD"].includes(x.currency)) { kUsd += x.amount; continue; }
    kAssets.set(x.currency, (kAssets.get(x.currency) ?? 0) + x.amount);
  }
  const cbAssets = new Map<string, number>();
  let cbUsd = 0;
  for (const x of cbBals) {
    if (x.currency === "USD" || x.currency === "USDC") { if (x.currency === "USD") cbUsd += x.amount; continue; }
    cbAssets.set(x.currency, (cbAssets.get(x.currency) ?? 0) + x.amount);
  }
  const b: Balances = { kUsd, cbUsd, kAssets, cbAssets, fetchedAt: Date.now() };
  balCache.set(k, b);
  return b;
}

const krakenAssetBal = (b: Balances, asset: MmAsset) =>
  krakenCodesFor(asset).reduce((a, c) => a + (b.kAssets.get(c) ?? 0), 0);

// ── Extended (Gemini-inclusive) credentials & per-venue fee/balance model ────
// The generated request schema (ExecuteCbMmBody/MmScanBody/MmAutoStartBody)
// strips unknown keys, so Gemini creds are read from the raw body separately
// (see route handlers) and carried here — never persisted, never logged.
export type GemCreds = { geminiKey: string; geminiSecret: string };
export type FullCreds = Creds & Partial<GemCreds>;
const hasGemini = (c: FullCreds): c is FullCreds & GemCreds => !!(c.geminiKey && c.geminiSecret);

/** The generated request schemas strip unknown keys, so Gemini creds and the
 *  optional venue selection are read from the RAW body (validated, never
 *  logged). Returns undefined for absent/blank fields. */
function readRawGemini(body: unknown): Partial<GemCreds> {
  const o = (body ?? {}) as Record<string, unknown>;
  const key = typeof o.geminiKey === "string" && o.geminiKey ? o.geminiKey : undefined;
  const secret = typeof o.geminiSecret === "string" && o.geminiSecret ? o.geminiSecret : undefined;
  return { geminiKey: key, geminiSecret: secret };
}
function readRawVenue(body: unknown, field: string): MmVenueId | null {
  const v = (body as Record<string, unknown> | null)?.[field];
  return typeof v === "string" ? normVenue(v) : null;
}

/** Per-venue fee tier + spendable balances. `source==="assumed"` fees can
 *  NEVER gate live execution (detect-or-refuse). `usd`/`assets` null = the
 *  balance is UNVERIFIED (keys missing or scope/permission issue) — treated as
 *  a hard block, never as $0. */
export type VenueFB = {
  venue: MmVenueId;
  makerPct: number | null;   // null = maker tier not detected for this venue
  takerPct: number | null;
  feeSource: "detected" | "assumed";
  usd: number | null;
  assets: Map<string, number> | null; // spendable base balances (UPPER asset code)
  error: string | null;
};

// Assumed tiers for CREDENTIAL-LESS display only (clearly labeled). Live
// decisions require detected tiers — these can only ever produce WATCH/SKIP.
const ASSUMED_MAKER_PCT: Record<MmVenueId, number> = { kraken: 0.16, coinbase: 0.6, gemini: 0.2 };
const ASSUMED_TAKER_PCT: Record<MmVenueId, number> = { kraken: 0.4, coinbase: 1.2, gemini: 0.4 };

const GEM_FB_CACHE_MS = 20_000;
const gemFbCache = new Map<string, { at: number; v: VenueFB }>();

/**
 * Detect fees + balances for all three venues from whichever creds are present.
 * Kraken/Coinbase reuse the existing detectFees + fetchBalances caches (so K/CB
 * behavior is identical); Gemini uses geminiVerify (fee tier + scope-checked
 * balances). `freshBalances` bypasses caches for the live path.
 */
export async function detectVenueFB(c: FullCreds, opts: { freshBalances?: boolean } = {}): Promise<Record<MmVenueId, VenueFB>> {
  const out: Record<MmVenueId, VenueFB> = {
    kraken: { venue: "kraken", makerPct: null, takerPct: ASSUMED_TAKER_PCT.kraken, feeSource: "assumed", usd: null, assets: null, error: null },
    coinbase: { venue: "coinbase", makerPct: ASSUMED_MAKER_PCT.coinbase, takerPct: ASSUMED_TAKER_PCT.coinbase, feeSource: "assumed", usd: null, assets: null, error: null },
    gemini: { venue: "gemini", makerPct: ASSUMED_MAKER_PCT.gemini, takerPct: ASSUMED_TAKER_PCT.gemini, feeSource: "assumed", usd: null, assets: null, error: null },
  };

  // Kraken + Coinbase come together from the proven detectFees/fetchBalances
  // path when BOTH sets of keys are present (unchanged K/CB behavior).
  if (c.krakenKey && c.krakenSecret && c.coinbaseKey && c.coinbaseSecret) {
    try {
      const [fees, bal] = await Promise.all([detectFees(c), fetchBalances(c, opts.freshBalances)]);
      const kAssets = new Map<string, number>();
      for (const [k, v] of bal.kAssets) kAssets.set(k, v);
      out.kraken = { venue: "kraken", makerPct: fees.kMakerPct, takerPct: fees.kTakerPct, feeSource: "detected", usd: bal.kUsd, assets: kAssets, error: null };
      out.coinbase = { venue: "coinbase", makerPct: fees.cbMakerPct, takerPct: fees.cbTakerPct, feeSource: "detected", usd: bal.cbUsd, assets: bal.cbAssets, error: null };
    } catch (e) {
      out.kraken.error = (e as Error).message;
      out.coinbase.error = (e as Error).message;
    }
  }

  if (hasGemini(c)) {
    const gc: GeminiCreds = { geminiKey: c.geminiKey, geminiSecret: c.geminiSecret };
    const key = `${c.geminiKey}`;
    const hit = gemFbCache.get(key);
    if (!opts.freshBalances && hit && Date.now() - hit.at < GEM_FB_CACHE_MS) {
      out.gemini = hit.v;
    } else {
      try {
        // Live execution passes freshBalances → maxAgeMs:0 so Gemini balances
        // are re-read FRESH, never served from lib/gemini's internal cache.
        const acct: GeminiAccount = await geminiVerify(gc, opts.freshBalances ? { maxAgeMs: 0 } : {});
        // Fees VERIFIED — but balances count only when the scope is clean; a
        // scope/permission issue leaves balances UNVERIFIED (null → no FIRE)
        // with the exact reason surfaced verbatim.
        const assets = new Map<string, number>();
        if (!acct.scopeIssue) for (const [cur, amt] of Object.entries(acct.balances)) assets.set(cur.toUpperCase(), amt);
        out.gemini = acct.scopeIssue
          ? { venue: "gemini", makerPct: acct.makerPct, takerPct: acct.takerPct, feeSource: "detected", usd: null, assets: null, error: acct.scopeIssue }
          : { venue: "gemini", makerPct: acct.makerPct, takerPct: acct.takerPct, feeSource: "detected", usd: acct.usdBalance, assets, error: null };
        gemFbCache.set(key, { at: Date.now(), v: out.gemini });
      } catch (e) { out.gemini.error = (e as Error).message; }
    }
  }
  return out;
}

/** Spendable base balance of `asset` on a venue (null = unverified). Kraken
 *  needs its currency-code aliasing; Coinbase/Gemini use the UPPER code. */
function venueAssetBal(fb: VenueFB, asset: MmAsset): number | null {
  if (fb.assets == null) return null;
  if (fb.venue === "kraken") return krakenCodesFor(asset).reduce((a, code) => a + (fb.assets!.get(code) ?? 0), 0);
  return fb.assets.get(asset) ?? 0;
}

// ── Scan: all assets × both directions × both structures ────────────────────
// Legacy K↔CB structures keep their exact ids; Gemini-inclusive maker→hedge
// structures use the generic id "venueMaker" and carry a human `structure`
// label like "gemini(maker)→kraken(hedge)".
type MmStructure = "cbMaker" | "kMaker" | "takerKtoC" | "takerCtoK" | "venueMaker";
type ScanRow = {
  asset: MmAsset; structure: MmStructure; direction: MmDirection;
  /** Human-readable structure label, e.g. "gemini(maker)→kraken(hedge)". */
  structureLabel: string;
  available: boolean;
  makerVenue: string; hedgeVenue: string;
  makerFeePct: number | null; hedgeFeePct: number | null;
  makerPrice?: number; makerQty?: number; hedgeVwapPx?: number;
  makerFeeUsd?: number; hedgeFeeUsd?: number; hedgeSlippageUsd?: number;
  grossEdgeUsd?: number | null;
  projectedNetUsd: number | null; quoteAgeMs?: number;
  inventoryReady: boolean; inventoryReason: string;
  requiredBalances: string;
  verdict: "RUN" | "WAIT"; reason: string;
  /** FIRE = full gate cleared · WATCH = positive net but blocked · SKIP = net ≤ 0 or unavailable */
  fire: "FIRE" | "WATCH" | "SKIP";
  autoExecutable: boolean;
};

function requiredBalancesText(structure: MmStructure, direction: MmDirection, asset: MmAsset, qty: number, sizeUsd: number): string {
  const usd = `$${(sizeUsd * 1.02).toFixed(2)} USD`, coin = `${(qty * 1.02).toFixed(6)} ${asset}`;
  if (structure === "cbMaker") return direction === "buy" ? `Coinbase ${usd} + Kraken ${coin}` : `Coinbase ${coin} + Kraken ${usd}`;
  if (structure === "kMaker") return direction === "buy" ? `Kraken ${usd} + Coinbase ${coin}` : `Kraken ${coin} + Coinbase ${usd}`;
  // taker: buy venue needs USD, sell venue needs the asset
  return structure === "takerKtoC" ? `Kraken ${usd} + Coinbase ${coin}` : `Coinbase ${usd} + Kraken ${coin}`;
}

function fireOf(net: number | null, verdictRun: boolean): "FIRE" | "WATCH" | "SKIP" {
  if (net == null || net <= 0) return "SKIP";
  return verdictRun ? "FIRE" : "WATCH";
}

/** Human structure label, e.g. "gemini(maker)→kraken(hedge)". */
function makerHedgeLabel(makerVenue: string, hedgeVenue: string): string {
  return `${makerVenue}(maker)→${hedgeVenue}(hedge)`;
}
function structureLabelOf(s: MmStructure, makerVenue: string, hedgeVenue: string): string {
  if (s === "takerKtoC") return "buy kraken→sell coinbase (taker/taker)";
  if (s === "takerCtoK") return "buy coinbase→sell kraken (taker/taker)";
  return makerHedgeLabel(makerVenue, hedgeVenue);
}

function inventoryFor(structure: MmStructure, direction: MmDirection, asset: MmAsset, qty: number, sizeUsd: number, bal: Balances): { ready: boolean; reason: string } {
  const needQty = qty * 1.02, needUsd = sizeUsd * 1.02;
  const kA = krakenAssetBal(bal, asset), cbA = bal.cbAssets.get(asset) ?? 0;
  // Maker side needs its own funds; hedge side needs the opposite inventory.
  if (structure === "cbMaker") {
    if (direction === "buy") {
      if (bal.cbUsd < needUsd) return { ready: false, reason: `Coinbase USD $${bal.cbUsd.toFixed(2)} < $${needUsd.toFixed(2)}` };
      if (kA < needQty) return { ready: false, reason: `Kraken ${asset} ${kA.toFixed(6)} < ${needQty.toFixed(6)} for the hedge sell` };
    } else {
      if (cbA < needQty) return { ready: false, reason: `tradable Coinbase ${asset} ${cbA.toFixed(6)} < ${needQty.toFixed(6)} (staked/held doesn't count)` };
      if (bal.kUsd < needUsd) return { ready: false, reason: `Kraken USD $${bal.kUsd.toFixed(2)} < $${needUsd.toFixed(2)} for the hedge buy` };
    }
  } else if (structure === "takerKtoC" || structure === "takerCtoK") {
    // Taker-taker: buy venue needs USD, sell venue needs pre-positioned asset.
    const buyIsKraken = structure === "takerKtoC";
    const buyUsd = buyIsKraken ? bal.kUsd : bal.cbUsd;
    const sellAsset = buyIsKraken ? cbA : kA;
    if (buyUsd < needUsd) return { ready: false, reason: `${buyIsKraken ? "Kraken" : "Coinbase"} USD $${buyUsd.toFixed(2)} < $${needUsd.toFixed(2)}` };
    if (sellAsset < needQty) return { ready: false, reason: `${buyIsKraken ? "Coinbase" : "Kraken"} ${asset} ${sellAsset.toFixed(6)} < ${needQty.toFixed(6)} to sell` };
  } else {
    if (direction === "buy") { // maker BUY on Kraken, hedge SELL on Coinbase
      if (bal.kUsd < needUsd) return { ready: false, reason: `Kraken USD $${bal.kUsd.toFixed(2)} < $${needUsd.toFixed(2)}` };
      if (cbA < needQty) return { ready: false, reason: `tradable Coinbase ${asset} ${cbA.toFixed(6)} < ${needQty.toFixed(6)} for the hedge sell` };
    } else {
      if (kA < needQty) return { ready: false, reason: `Kraken ${asset} ${kA.toFixed(6)} < ${needQty.toFixed(6)}` };
      if (bal.cbUsd < needUsd) return { ready: false, reason: `Coinbase USD $${bal.cbUsd.toFixed(2)} < $${needUsd.toFixed(2)} for the hedge buy` };
    }
  }
  return { ready: true, reason: "both legs funded" };
}

function scanAll(fees: Fees, bal: Balances, floorUsd: number, bufferUsd: number, maxQuoteAgeMs: number): ScanRow[] {
  const required = floorUsd + bufferUsd;
  const rows: ScanRow[] = [];
  for (const asset of MM_ASSETS) {
    for (const direction of ["buy", "sell"] as MmDirection[]) {
      const structures: Array<{ s: MmStructure; p: MmProjection | null; makerPct: number | null; hedgePct: number; makerVenue: string; hedgeVenue: string }> = [
        { s: "cbMaker", p: projectCbMakerHedge(asset, direction, SIZE_USD_CAP, fees.cbMakerPct, fees.kTakerPct), makerPct: fees.cbMakerPct, hedgePct: fees.kTakerPct, makerVenue: "coinbase", hedgeVenue: "kraken" },
        { s: "kMaker", p: fees.kMakerPct != null ? projectMakerHedge(asset, direction, SIZE_USD_CAP, fees.kMakerPct, fees.cbTakerPct) : null, makerPct: fees.kMakerPct, hedgePct: fees.cbTakerPct, makerVenue: "kraken", hedgeVenue: "coinbase" },
      ];
      for (const { s, p, makerPct, hedgePct, makerVenue, hedgeVenue } of structures) {
        if (!p) {
          rows.push({ asset, structure: s, structureLabel: structureLabelOf(s, makerVenue, hedgeVenue), direction, available: false, makerVenue, hedgeVenue, makerFeePct: makerPct, hedgeFeePct: hedgePct, grossEdgeUsd: null, projectedNetUsd: null, inventoryReady: false, inventoryReason: "no projection", requiredBalances: requiredBalancesText(s, direction, asset, 0, SIZE_USD_CAP), verdict: "WAIT", fire: "SKIP", reason: makerPct == null ? "maker fee tier not detected for this venue" : "no live books or hedge depth insufficient", autoExecutable: false });
          continue;
        }
        const inv = inventoryFor(s, direction, asset, p.makerQty, SIZE_USD_CAP, bal);
        const stale = p.quoteAgeMs > maxQuoteAgeMs;
        const clears = p.projectedNetUsd >= required;
        const run = clears && !stale && inv.ready;
        // Gross edge before any cost = net + all costs added back.
        const grossEdgeUsd = p.projectedNetUsd + p.makerFeeUsd + p.hedgeFeeUsd + p.hedgeSlippageUsd;
        rows.push({
          asset, structure: s, structureLabel: structureLabelOf(s, makerVenue, hedgeVenue), direction, available: true, makerVenue, hedgeVenue,
          makerFeePct: makerPct, hedgeFeePct: hedgePct,
          makerPrice: p.makerPrice, makerQty: p.makerQty, hedgeVwapPx: p.hedgeVwapPx,
          makerFeeUsd: p.makerFeeUsd, hedgeFeeUsd: p.hedgeFeeUsd, hedgeSlippageUsd: p.hedgeSlippageUsd,
          grossEdgeUsd,
          projectedNetUsd: p.projectedNetUsd, quoteAgeMs: p.quoteAgeMs,
          inventoryReady: inv.ready, inventoryReason: inv.reason,
          requiredBalances: requiredBalancesText(s, direction, asset, p.makerQty, SIZE_USD_CAP),
          verdict: run ? "RUN" : "WAIT",
          fire: fireOf(p.projectedNetUsd, run),
          reason: run
            ? `net $${p.projectedNetUsd.toFixed(4)} clears floor $${floorUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}, inventory ready`
            : p.projectedNetUsd <= 0 ? `projected net $${p.projectedNetUsd.toFixed(4)} ≤ $0 — fees + slippage eat the edge`
              : !inv.ready ? `positive net $${p.projectedNetUsd.toFixed(4)} but inventory: ${inv.reason}`
                : stale ? `positive net but books stale (${p.quoteAgeMs}ms > ${maxQuoteAgeMs}ms)`
                  : `net $${p.projectedNetUsd.toFixed(4)} below required $${required.toFixed(2)} (floor + buffer)`,
          autoExecutable: s === "cbMaker", // only the hardened executor auto-fires
        });
      }
    }
    // Taker-taker structures (evaluation only — never auto-fired; the taker
    // executor lives in the diagnostics area and is manual by design).
    const takers: Array<{ s: MmStructure; buyVenue: "kraken" | "coinbase" }> = [
      { s: "takerKtoC", buyVenue: "kraken" }, { s: "takerCtoK", buyVenue: "coinbase" },
    ];
    for (const { s: ts, buyVenue } of takers) {
      const buyFee = buyVenue === "kraken" ? fees.kTakerPct : fees.cbTakerPct;
      const sellFee = buyVenue === "kraken" ? fees.cbTakerPct : fees.kTakerPct;
      const tp = projectTakerTaker(asset, buyVenue, SIZE_USD_CAP, buyFee, sellFee);
      const makerVenue = buyVenue, hedgeVenue = buyVenue === "kraken" ? "coinbase" : "kraken";
      if (!tp) {
        rows.push({ asset, structure: ts, structureLabel: structureLabelOf(ts, makerVenue, hedgeVenue), direction: "buy", available: false, makerVenue, hedgeVenue, makerFeePct: buyFee, hedgeFeePct: sellFee, grossEdgeUsd: null, projectedNetUsd: null, inventoryReady: false, inventoryReason: "no projection", requiredBalances: requiredBalancesText(ts, "buy", asset, 0, SIZE_USD_CAP), verdict: "WAIT", fire: "SKIP", reason: "no live books or depth insufficient", autoExecutable: false });
        continue;
      }
      const inv = inventoryFor(ts, "buy", asset, tp.qty, SIZE_USD_CAP, bal);
      const stale = tp.quoteAgeMs > maxQuoteAgeMs;
      const clears = tp.projectedNetUsd >= required;
      const run = clears && !stale && inv.ready;
      rows.push({
        asset, structure: ts, structureLabel: structureLabelOf(ts, makerVenue, hedgeVenue), direction: "buy", available: true, makerVenue, hedgeVenue,
        makerFeePct: buyFee, hedgeFeePct: sellFee,
        makerPrice: tp.buyTopPx, makerQty: tp.qty, hedgeVwapPx: tp.sellVwapPx,
        makerFeeUsd: tp.buyFeeUsd, hedgeFeeUsd: tp.sellFeeUsd, hedgeSlippageUsd: tp.slippageUsd,
        grossEdgeUsd: tp.grossEdgeUsd,
        projectedNetUsd: tp.projectedNetUsd, quoteAgeMs: tp.quoteAgeMs,
        inventoryReady: inv.ready, inventoryReason: inv.reason,
        requiredBalances: requiredBalancesText(ts, "buy", asset, tp.qty, SIZE_USD_CAP),
        verdict: run ? "RUN" : "WAIT",
        fire: fireOf(tp.projectedNetUsd, run),
        reason: run
          ? `taker-taker net $${tp.projectedNetUsd.toFixed(4)} clears the gate — manual fire only (diagnostics card)`
          : tp.projectedNetUsd <= 0 ? `net $${tp.projectedNetUsd.toFixed(4)} ≤ $0 — double taker fees ($${(tp.buyFeeUsd + tp.sellFeeUsd).toFixed(3)}) eat the $${tp.grossEdgeUsd.toFixed(4)} gross edge`
            : !inv.ready ? `positive net but inventory: ${inv.reason}`
              : stale ? `positive net but books stale (${tp.quoteAgeMs}ms)`
                : `net $${tp.projectedNetUsd.toFixed(4)} below required $${required.toFixed(2)}`,
        autoExecutable: false,
      });
    }
  }
  rows.sort((a, b2) => (b2.projectedNetUsd ?? -1e9) - (a.projectedNetUsd ?? -1e9));
  return rows;
}

// ── Gemini-inclusive maker→hedge scan (venue-adapter form) ───────────────────
// Enumerates every ordered (maker, hedge) venue pair that INVOLVES Gemini —
// the K↔CB pairs are already covered by scanAll's cbMaker/kMaker rows, so we
// never duplicate them here. Maker needs post-only (all three have it); hedge
// needs IOC (all three have it). Uses the venue-agnostic projection + the
// per-venue detected/assumed fees and verified balances.
function ventureInventory(
  makerVenue: MmVenueId, hedgeVenue: MmVenueId, direction: MmDirection,
  asset: MmAsset, qty: number, sizeUsd: number,
  mFb: VenueFB, hFb: VenueFB,
): { ready: boolean; reason: string } {
  const needQty = qty * 1.02, needUsd = sizeUsd * 1.02;
  // Maker side funds its own leg; hedge side needs the opposite inventory.
  // buy = maker BUYS (needs USD on maker), hedge SELLS (needs asset on hedge).
  // sell = maker SELLS (needs asset on maker), hedge BUYS (needs USD on hedge).
  const makerUsd = mFb.usd, hedgeUsd = hFb.usd;
  const makerAsset = venueAssetBal(mFb, asset), hedgeAsset = venueAssetBal(hFb, asset);
  const unv = (v: VenueFB) => `balances UNVERIFIED on ${v.venue}${v.error ? ` (${v.error})` : ""}`;
  if (direction === "buy") {
    if (makerUsd == null) return { ready: false, reason: unv(mFb) };
    if (makerUsd < needUsd) return { ready: false, reason: `${makerVenue} USD $${makerUsd.toFixed(2)} < $${needUsd.toFixed(2)}` };
    if (hedgeAsset == null) return { ready: false, reason: unv(hFb) };
    if (hedgeAsset < needQty) return { ready: false, reason: `${hedgeVenue} ${asset} ${hedgeAsset.toFixed(6)} < ${needQty.toFixed(6)} for the hedge sell` };
  } else {
    if (makerAsset == null) return { ready: false, reason: unv(mFb) };
    if (makerAsset < needQty) return { ready: false, reason: `tradable ${makerVenue} ${asset} ${makerAsset.toFixed(6)} < ${needQty.toFixed(6)}` };
    if (hedgeUsd == null) return { ready: false, reason: unv(hFb) };
    if (hedgeUsd < needUsd) return { ready: false, reason: `${hedgeVenue} USD $${hedgeUsd.toFixed(2)} < $${needUsd.toFixed(2)} for the hedge buy` };
  }
  return { ready: true, reason: "both legs funded" };
}

function scanGeminiPairs(vfb: Record<MmVenueId, VenueFB>, floorUsd: number, bufferUsd: number, maxQuoteAgeMs: number): ScanRow[] {
  const required = floorUsd + bufferUsd;
  const rows: ScanRow[] = [];
  // Ordered maker→hedge pairs that involve Gemini.
  const pairs: Array<[MmVenueId, MmVenueId]> = [];
  for (const mv of MM_VENUES) for (const hv of MM_VENUES) {
    if (mv === hv) continue;
    if (mv !== "gemini" && hv !== "gemini") continue; // K↔CB handled by scanAll
    pairs.push([mv, hv]);
  }
  for (const asset of MM_ASSETS) {
    for (const [makerVenue, hedgeVenue] of pairs) {
      if (!venueListsAsset(makerVenue, asset) || !venueListsAsset(hedgeVenue, asset)) continue;
      const mFb = vfb[makerVenue], hFb = vfb[hedgeVenue];
      const label = makerHedgeLabel(makerVenue, hedgeVenue);
      for (const direction of ["buy", "sell"] as MmDirection[]) {
        const makerPct = mFb.makerPct, hedgePct = hFb.takerPct;
        const feesUnknown = makerPct == null || hedgePct == null;
        const p = feesUnknown ? null
          : projectVenueMakerHedge(asset, makerVenue, hedgeVenue, direction, SIZE_USD_CAP, makerPct!, hedgePct!);
        const reqBal = direction === "buy"
          ? `${makerVenue} $${(SIZE_USD_CAP * 1.02).toFixed(2)} USD + ${hedgeVenue} ${(( (p?.makerQty ?? 0)) * 1.02).toFixed(6)} ${asset}`
          : `${makerVenue} ${(((p?.makerQty ?? 0)) * 1.02).toFixed(6)} ${asset} + ${hedgeVenue} $${(SIZE_USD_CAP * 1.02).toFixed(2)} USD`;
        if (!p) {
          rows.push({ asset, structure: "venueMaker", structureLabel: label, direction, available: false, makerVenue, hedgeVenue, makerFeePct: makerPct, hedgeFeePct: hedgePct, grossEdgeUsd: null, projectedNetUsd: null, inventoryReady: false, inventoryReason: "no projection", requiredBalances: reqBal, verdict: "WAIT", fire: "SKIP", reason: feesUnknown ? "fee tier not detected for one venue" : "no live books or hedge depth insufficient", autoExecutable: false });
          continue;
        }
        const inv = ventureInventory(makerVenue, hedgeVenue, direction, asset, p.makerQty, SIZE_USD_CAP, mFb, hFb);
        const stale = p.quoteAgeMs > maxQuoteAgeMs;
        const feesDetected = mFb.feeSource === "detected" && hFb.feeSource === "detected";
        const clears = p.projectedNetUsd >= required;
        // Assumptions can NEVER gate live execution → RUN requires DETECTED fees.
        const run = clears && !stale && inv.ready && feesDetected;
        const grossEdgeUsd = p.projectedNetUsd + p.makerFeeUsd + p.hedgeFeeUsd + p.hedgeSlippageUsd;
        rows.push({
          asset, structure: "venueMaker", structureLabel: label, direction, available: true, makerVenue, hedgeVenue,
          makerFeePct: makerPct, hedgeFeePct: hedgePct,
          makerPrice: p.makerPrice, makerQty: p.makerQty, hedgeVwapPx: p.hedgeVwapPx,
          makerFeeUsd: p.makerFeeUsd, hedgeFeeUsd: p.hedgeFeeUsd, hedgeSlippageUsd: p.hedgeSlippageUsd,
          grossEdgeUsd,
          projectedNetUsd: p.projectedNetUsd, quoteAgeMs: p.quoteAgeMs,
          inventoryReady: inv.ready, inventoryReason: inv.reason,
          requiredBalances: (direction === "buy"
            ? `${makerVenue} $${(SIZE_USD_CAP * 1.02).toFixed(2)} USD + ${hedgeVenue} ${(p.makerQty * 1.02).toFixed(6)} ${asset}`
            : `${makerVenue} ${(p.makerQty * 1.02).toFixed(6)} ${asset} + ${hedgeVenue} $${(SIZE_USD_CAP * 1.02).toFixed(2)} USD`),
          verdict: run ? "RUN" : "WAIT",
          fire: fireOf(p.projectedNetUsd, run),
          reason: run
            ? `net $${p.projectedNetUsd.toFixed(4)} clears floor $${floorUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}, inventory ready`
            : p.projectedNetUsd <= 0 ? `projected net $${p.projectedNetUsd.toFixed(4)} ≤ $0 — fees + slippage eat the edge`
              : !feesDetected ? `positive net $${p.projectedNetUsd.toFixed(4)} but fees ASSUMED on ${mFb.feeSource === "assumed" ? makerVenue : hedgeVenue} — connect keys; assumptions never gate live`
                : !inv.ready ? `positive net $${p.projectedNetUsd.toFixed(4)} but inventory: ${inv.reason}`
                  : stale ? `positive net but books stale (${p.quoteAgeMs}ms > ${maxQuoteAgeMs}ms)`
                    : `net $${p.projectedNetUsd.toFixed(4)} below required $${required.toFixed(2)} (floor + buffer)`,
          autoExecutable: false, // AUTO fires only the hardened Coinbase-maker executor
        });
      }
    }
  }
  return rows;
}

// ── The execution cycle, callable by both the route and AUTO mode ───────────
type CycleParams = Creds & {
  asset: MmAsset; direction?: MmDirection;
  minNetUsd?: number | null; bufferUsd?: number | null;
  maxQuoteAgeMs?: number | null; restWindowSec?: number | null; sizeUsd?: number | null;
};
type CycleResult = {
  outcome: string; reason: string; asset: string; startedAt: string; finishedAt: string;
  makerLeg: object | null; hedgeLeg: object | null; realizedProfitUsd: number | null; projection: object | null;
};

async function runCbMmCycle(b: CycleParams, log: Logger): Promise<CycleResult> {
  const asset = b.asset;
  const sizeUsd = Math.min(SIZE_USD_CAP, Math.max(1, b.sizeUsd ?? SIZE_USD_CAP)); // HARD $10 cap — no auto-scaling
  const minNetUsd = floorFor(b.minNetUsd); // configurable, never ≤ 0
  const bufferUsd = bufferFor(sizeUsd, b.bufferUsd ?? undefined);
  const maxQuoteAgeMs = b.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const restWindowSec = Math.min(MAX_REST_WINDOW_SEC, Math.max(5, b.restWindowSec ?? DEFAULT_REST_WINDOW_SEC));
  const startedAt = new Date().toISOString();
  const kCreds = { krakenKey: b.krakenKey, krakenSecret: b.krakenSecret };
  const cbCreds = { coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret };
  const kPairRaw = OB_USD_PAIRS[asset];
  const cbPair = cbPairOf(asset);

  const finish = (outcome: string, reason: string, extra?: Partial<CycleResult>): CycleResult => {
    log.info({ asset, outcome, reason }, "[MM2]");
    return { outcome, reason, asset, startedAt, finishedAt: new Date().toISOString(), makerLeg: null, hedgeLeg: null, realizedProfitUsd: null, projection: null, ...extra };
  };

  if (!b.krakenKey || !b.krakenSecret || !b.coinbaseKey || !b.coinbaseSecret) return finish("skipped", "missing API credentials");
  if (liveNeedsReconcile) return finish("skipped", `live runs locked pending manual reconciliation: ${liveNeedsReconcile}. Verify on the exchanges, then restart the server.`);
  if (execInFlight) return finish("skipped", "an execution is already in flight");
  execInFlight = true;
  let lockGen: number | null = null;
  try {
    // 1. REAL fees on both venues — refuse to guess.
    let cbMakerPct: number, kTakerPct: number;
    try {
      const f = await detectFees(b);
      cbMakerPct = f.cbMakerPct; kTakerPct = f.kTakerPct;
    } catch (e) {
      return finish("skipped", `could not detect REAL fee tiers (never guessing for live): ${(e as Error).message}`);
    }

    // 2. Best direction on CURRENT books with REAL fees.
    const projBuy = projectCbMakerHedge(asset, "buy", sizeUsd, cbMakerPct, kTakerPct);
    const projSell = projectCbMakerHedge(asset, "sell", sizeUsd, cbMakerPct, kTakerPct);
    const requested = b.direction;
    const candidates = (requested ? [requested === "buy" ? projBuy : projSell] : [projBuy, projSell]).filter((p): p is MmProjection => p != null);
    if (!candidates.length) return finish("skipped", "no live depth books on one/both venues (or depth cannot absorb the hedge)");
    const proj = candidates.reduce((a, c) => (c.projectedNetUsd > a.projectedNetUsd ? c : a));
    const projInfo = { direction: proj.direction, makerPrice: proj.makerPrice, makerQty: proj.makerQty, projectedNetUsd: proj.projectedNetUsd, makerFeeUsd: proj.makerFeeUsd, hedgeFeeUsd: proj.hedgeFeeUsd, hedgeVwapPx: proj.hedgeVwapPx, hedgeSlippageUsd: proj.hedgeSlippageUsd, quoteAgeMs: proj.quoteAgeMs, cbMakerPct, kTakerPct, minNetUsd, bufferUsd };

    // DECISION LOG — before every decision: each market's age, route age
    // (oldest leg), scanner net, executable net, and the profit floor.
    log.info({
      asset, decision: "pre-fire",
      legAges: proj.legAges.map(l => ({ market: l.pair, ageMs: l.ageMs, recvAgeMs: l.recvAgeMs })),
      routeAgeMs: proj.quoteAgeMs,
      scannerNetUsd: proj.projectedNetUsd,
      executableNetUsd: proj.projectedNetUsd, // identical function+books at this instant; divergence re-checked below
      profitFloorUsd: minNetUsd, bufferUsd, maxQuoteAgeMs,
    }, "[MM2] decision");
    if (proj.quoteAgeMs > maxQuoteAgeMs) return finish("skipped", `books stale: oldest leg ${proj.quoteAgeMs}ms > ${maxQuoteAgeMs}ms — entire route treated as stale, not executing`, { projection: projInfo });
    if (proj.projectedNetUsd < minNetUsd + bufferUsd) {
      return finish("skipped", `projected net $${proj.projectedNetUsd.toFixed(4)} below floor $${minNetUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}`, { projection: projInfo });
    }
    // PRE-FIRE CONSISTENCY — an immediate second re-projection of the same
    // route with the identical function on the live stream books (not an
    // immutable snapshot). If two consecutive reads disagree beyond a tiny
    // tolerance, the books are moving mid-decision: block execution.
    const recheck = projectCbMakerHedge(asset, proj.direction, sizeUsd, cbMakerPct, kTakerPct);
    if (!recheck) return finish("skipped", "PRICING CONSISTENCY ERROR: pre-fire re-projection lost the books — not executing", { projection: projInfo });
    if (Math.abs(recheck.projectedNetUsd - proj.projectedNetUsd) > CONSISTENCY_TOLERANCE_USD) {
      log.error({ asset, scannerNetUsd: proj.projectedNetUsd, preFireNetUsd: recheck.projectedNetUsd, toleranceUsd: CONSISTENCY_TOLERANCE_USD }, "[MM2] PRICING CONSISTENCY ERROR");
      return finish("skipped", `PRICING CONSISTENCY ERROR: scanner net $${proj.projectedNetUsd.toFixed(4)} vs pre-fire net $${recheck.projectedNetUsd.toFixed(4)} diverged beyond $${CONSISTENCY_TOLERANCE_USD} between consecutive re-projections — not executing`, { projection: projInfo });
    }
    if (recheck.quoteAgeMs > maxQuoteAgeMs) return finish("skipped", `books went stale during consistency check (${recheck.quoteAgeMs}ms > ${maxQuoteAgeMs}ms)`, { projection: projInfo });
    const direction = proj.direction;

    // 3. Inventory precheck for BOTH legs before any order.
    let kUsd = 0, kAsset = 0, cbUsd = 0, cbAsset = 0;
    try {
      const [kBals, cbAssetDetail, cbUsdDetail] = await Promise.all([
        getKrakenBalances(kCreds, true),
        getCoinbaseAssetDetail(cbCreds, asset),
        getCoinbaseAssetDetail(cbCreds, "USD"),
      ]);
      kUsd = kBals.filter(x => ["ZUSD", "USD"].includes(x.currency)).reduce((a, x) => a + x.amount, 0);
      const kCodes = krakenCodesFor(asset);
      kAsset = kBals.filter(x => kCodes.includes(x.currency)).reduce((a, x) => a + x.amount, 0);
      cbUsd = cbUsdDetail.available; cbAsset = cbAssetDetail.available;
    } catch (e) { return finish("skipped", `balance check failed: ${(e as Error).message}`); }
    if (direction === "buy") {
      if (cbUsd < sizeUsd * 1.02) return finish("skipped", `insufficient Coinbase USD for the maker buy: need ~$${(sizeUsd * 1.02).toFixed(2)}, have $${cbUsd.toFixed(2)}`, { projection: projInfo });
      if (kAsset < proj.makerQty * 1.02) return finish("skipped", `insufficient pre-positioned Kraken ${asset} for the hedge sell: need ~${(proj.makerQty * 1.02).toFixed(8)}, have ${kAsset.toFixed(8)}`, { projection: projInfo });
    } else {
      if (cbAsset < proj.makerQty * 1.02) return finish("skipped", `insufficient TRADABLE Coinbase ${asset} for the maker sell (staked/held balances don't count): need ~${(proj.makerQty * 1.02).toFixed(8)}, have ${cbAsset.toFixed(8)}`, { projection: projInfo });
      if (kUsd < sizeUsd * 1.02) return finish("skipped", `insufficient Kraken USD for the hedge buy: need ~$${(sizeUsd * 1.02).toFixed(2)}, have $${kUsd.toFixed(2)}`, { projection: projInfo });
    }

    // 3.5 Coinbase increments are MANDATORY — never guess precision.
    let cbIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>>;
    try { cbIncs = await getCoinbaseProductIncrements(cbPair); }
    catch (e) { return finish("skipped", `Coinbase product increments unavailable — refusing to guess order precision: ${(e as Error).message}`, { projection: projInfo }); }
    const qBase = (v: number) => quantizeDown(v, cbIncs.baseIncrement).value;
    const baseTol = 2 * parseFloat(cbIncs.baseIncrement);

    // 4. Shared live lock — same lock every other executor gates on.
    lockGen = tryAcquireSharedLiveLock();
    if (lockGen == null) return finish("skipped", "another live executor holds the execution lock", { projection: projInfo });
    bindLockHeartbeat(liveLockHeartbeat(lockGen));

    // 5. POST-ONLY maker on Coinbase, joining the top of our side.
    const t0 = Date.now();
    const makerQty = qBase(proj.makerQty);
    if (makerQty <= 0) return finish("skipped", "maker quantity quantized to zero", { projection: projInfo });
    let makerId: string | null = null;
    try {
      const r = await coinbaseLimitOrder(cbCreds, direction === "buy" ? "BUY" : "SELL", makerQty, proj.makerPrice, cbPair, cbIncs);
      if (r.success === false) return finish("post_rejected", "Coinbase rejected the post-only order (would have crossed) — nothing traded", { projection: projInfo });
      makerId = r.orderId ?? null;
      if (!makerId) throw new Error("Coinbase returned no order id");
    } catch (e) {
      // Post-submit ambiguity: the maker order MAY exist. Latch.
      liveNeedsReconcile = `Coinbase MAKER ${direction} (id unknown) unconfirmed: ${(e as Error).message}`;
      await ledgerRow({ asset, direction, note: `indeterminate: maker submit unconfirmed`, volume: 0, makerPx: proj.makerPrice, hedgePx: 0, makerId: null, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
      return finish("indeterminate", `Coinbase maker order UNCONFIRMED (${(e as Error).message}) — check Coinbase open orders before trading again. Live runs locked.`, { projection: projInfo });
    }

    // 6. Rest window: wait for fill; cancel if the projected hedge degrades.
    const restDeadline = Date.now() + restWindowSec * 1000;
    let det: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
    let cancelReason: string | null = null;
    while (Date.now() < restDeadline) {
      touchLiveLock();
      if (!liveLockOwned(lockGen)) { cancelReason = "execution lock evicted (KILL/HARD RESET)"; break; }
      try {
        const x = await coinbaseOrderDetails(cbCreds, makerId);
        if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status)) { det = x; break; }
        // GATE: re-project the hedge at the RESTING price for the remaining
        // qty. If it no longer clears floor + buffer, cancel BEFORE fill.
        const remaining = Math.max(0, makerQty - x.filledSize);
        if (remaining > baseTol) {
          const re = projectCbMakerHedge(asset, direction, sizeUsd, cbMakerPct, kTakerPct, proj.makerPrice, remaining);
          if (!re) { cancelReason = "hedge book lost while resting"; break; }
          if (re.quoteAgeMs > maxQuoteAgeMs) { cancelReason = `hedge book stale (${re.quoteAgeMs}ms) while resting`; break; }
          // Floor scaled to the remaining fraction; buffer never scaled down.
          const scaledFloor = minNetUsd * (remaining / makerQty);
          if (re.projectedNetUsd < scaledFloor + bufferUsd) { cancelReason = `projected hedge net $${re.projectedNetUsd.toFixed(4)} fell below scaled floor $${scaledFloor.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}`; break; }
        }
      } catch { /* poll again */ }
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    // Not terminal → cancel (timeout or gate). Cancel MUST be confirmed.
    if (!det) {
      const why = cancelReason ?? `rest window (${restWindowSec}s) expired without a fill`;
      try {
        await coinbaseCancelOrder(cbCreds, makerId);
        const dl = Date.now() + TERMINAL_WAIT_MS;
        while (Date.now() < dl) {
          touchLiveLock();
          try {
            const x = await coinbaseOrderDetails(cbCreds, makerId);
            if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status)) { det = x; break; }
          } catch { /* poll again */ }
          await new Promise(r => setTimeout(r, POLL_MS));
        }
        if (!det) throw new Error("cancel submitted but order never reached a terminal state");
      } catch (e) {
        liveNeedsReconcile = `Coinbase MAKER ${makerId} cancel UNCONFIRMED: ${(e as Error).message}`;
        await ledgerRow({ asset, direction, note: "indeterminate: cancel unconfirmed", volume: 0, makerPx: proj.makerPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
        return finish("indeterminate", `cancel of maker order ${makerId} unconfirmed (${(e as Error).message}) — the order may still be live on Coinbase. Live runs locked.`, { projection: projInfo });
      }
      log.info({ makerId, why }, "[MM2] maker cancelled");
    }

    const filledQty = det.filledSize;
    const makerNotional = det.filledValue;
    const makerFeeUsd = det.totalFees;
    const makerLeg = { venue: "coinbase", side: direction, orderId: makerId, status: det.status, filledQty, avgPrice: det.avgPrice || null, notionalUsd: makerNotional || null, feeUsd: makerFeeUsd, latencyMs: Date.now() - t0 };

    // 7. No fill → clean exit, no hedge ever opened. ANY confirmed positive
    // fill — even dust — goes to the hedge path: deliberately ignoring a
    // small real fill would leave silent unhedged exposure.
    if (filledQty <= 0) {
      return finish("no_fill", `maker order ended ${det.status} with no fill${cancelReason ? ` (cancelled: ${cancelReason})` : ""} — nothing traded, no hedge opened`, { makerLeg, projection: projInfo });
    }

    // 8. CONFIRMED fill → hedge EXACTLY the filled quantity on Kraken now.
    // Bounded IOC (0.5% collar), never an unbounded market order. Closing the
    // exposure takes priority; if the fresh hedge is now below floor we still
    // hedge (holding an unhedged position is strictly worse) and the realized
    // number tells the truth. This IS the safest unwind: the position exists
    // on the maker venue, and closing it on the hedge venue at a bounded
    // price is strictly better than resting exposed.
    if (!liveLockOwned(lockGen)) {
      liveNeedsReconcile = `Coinbase maker ${makerId} filled ${filledQty.toFixed(8)} ${asset} but execution was killed before the hedge`;
      await ledgerRow({ asset, direction, note: "unhedged: lock evicted before hedge", volume: filledQty, makerPx: det.avgPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
      return finish("unhedged", liveNeedsReconcile, { makerLeg, projection: projInfo });
    }
    const freshProj = projectCbMakerHedge(asset, direction, sizeUsd, cbMakerPct, kTakerPct, det.avgPrice || proj.makerPrice, filledQty);
    const hedgeSide: "buy" | "sell" = direction === "buy" ? "sell" : "buy";
    const collarPx = freshProj
      ? (hedgeSide === "sell" ? freshProj.hedgeTopPx * 0.995 : freshProj.hedgeTopPx * 1.005)
      : (hedgeSide === "sell" ? det.avgPrice * 0.99 : det.avgPrice * 1.01); // book lost: collar off the maker fill
    const t1 = Date.now();
    const KRAKEN_LOT_STEP = 1e-8;
    const hedgeTarget = Math.floor(filledQty / KRAKEN_LOT_STEP) * KRAKEN_LOT_STEP;
    let hedgeTxid: string | null = null;
    let hInfo = { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
    let hedgeError: string | null = null;
    try {
      const r = await krakenIocLimitOrder(kCreds, hedgeSide, hedgeTarget, collarPx, kPairRaw);
      hedgeTxid = r.txid?.[0] ?? null;
      if (!hedgeTxid) throw new Error("Kraken returned no txid");
      const dl = Date.now() + TERMINAL_WAIT_MS;
      while (Date.now() < dl) {
        touchLiveLock();
        try { hInfo = await krakenOrderInfo(kCreds, hedgeTxid); } catch { /* poll again */ }
        if (["closed", "canceled", "expired"].includes(hInfo.status)) break;
        await new Promise(r => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      hedgeError = (e as Error).message;
      if (!isExplicitKrakenReject(hedgeError)) {
        liveNeedsReconcile = `Kraken HEDGE ${hedgeTxid ?? "(txid unknown)"} unconfirmed: ${hedgeError}`;
      }
    }
    // An IOC should terminal-ize immediately; if it is somehow still open
    // after the wait, cancel it explicitly and confirm — otherwise it could
    // keep filling after we respond. Only an unconfirmable cancel latches.
    if (hedgeTxid && !hedgeError && !["closed", "canceled", "expired"].includes(hInfo.status)) {
      try {
        await krakenCancelOrder(kCreds, hedgeTxid);
        const dl2 = Date.now() + 10_000;
        while (Date.now() < dl2) {
          touchLiveLock();
          try { hInfo = await krakenOrderInfo(kCreds, hedgeTxid); } catch { /* poll again */ }
          if (["closed", "canceled", "expired"].includes(hInfo.status)) break;
          await new Promise(r => setTimeout(r, POLL_MS));
        }
      } catch (e) { log.error({ err: e, hedgeTxid }, "[MM2] hedge cancel attempt failed"); }
    }
    const hedgeIndeterminate = (hedgeTxid && !hedgeError && !["closed", "canceled", "expired"].includes(hInfo.status)) || (!!hedgeError && !isExplicitKrakenReject(hedgeError));
    if (hedgeIndeterminate && !liveNeedsReconcile) liveNeedsReconcile = `Kraken HEDGE ${hedgeTxid} not terminal and cancel unconfirmed after ${TERMINAL_WAIT_MS / 1000}s`;
    // IOC "canceled" with partial fill is a real partial — count volExec only.
    const hedgedQty = hInfo.volExec || 0;
    const fullyHedged = !hedgeIndeterminate && hedgedQty >= hedgeTarget - KRAKEN_LOT_STEP && hedgeTarget >= filledQty - Math.max(KRAKEN_LOT_STEP, filledQty * 1e-6);
    const hedgeLeg = { venue: "kraken", side: hedgeSide, orderId: hedgeTxid, status: hedgeIndeterminate ? "indeterminate" : hInfo.status, filledQty: hedgedQty, avgPrice: hInfo.price || null, notionalUsd: hInfo.cost || null, feeUsd: hInfo.fee || null, latencyMs: Date.now() - t1 };

    // Realized ONLY when fully hedged (partial hedge ≠ realized P&L).
    let realized: number | null = null;
    if (fullyHedged) {
      realized = direction === "buy"
        ? (hInfo.cost - hInfo.fee) - (makerNotional + makerFeeUsd)   // sold on K, bought on CB
        : (makerNotional - makerFeeUsd) - (hInfo.cost + hInfo.fee);  // sold on CB, bought back on K
    }
    const residual = Math.max(0, hedgeTarget - hedgedQty);
    const outcome = hedgeIndeterminate ? "indeterminate" : fullyHedged ? "completed" : "unhedged";
    await ledgerRow({
      asset, direction,
      note: outcome === "completed" ? "" : `${outcome}: residual ${residual.toFixed(8)}`,
      volume: filledQty, makerPx: det.avgPrice, hedgePx: hInfo.price || 0,
      makerId, hedgeId: hedgeTxid,
      status: outcome === "completed" ? "verified" : "unhedged",
      realized, expected: freshProj?.projectedNetUsd ?? proj.projectedNetUsd,
    }, log);
    log.info({ asset, direction, outcome, realized, filledQty, hedgedQty }, "[MM2] finished");
    return {
      outcome,
      reason: outcome === "completed"
        ? `maker filled ${filledQty.toFixed(8)} @ ${det.avgPrice}, hedged fully — realized $${realized!.toFixed(4)}`
        : `maker filled ${filledQty.toFixed(8)} but hedge ${hedgeLeg.status}${hedgeError ? `: ${hedgeError}` : ""} — residual ${residual.toFixed(8)} ${asset} exposure${liveNeedsReconcile ? "; live runs locked pending reconciliation" : ""}`,
      asset, startedAt, finishedAt: new Date().toISOString(),
      makerLeg, hedgeLeg, realizedProfitUsd: realized, projection: projInfo,
    };
  } catch (err) {
    return finish("skipped", (err as Error).message);
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
    execInFlight = false;
  }
}

// ── Generalized (Gemini-inclusive) maker→hedge cycle ─────────────────────────
// Same safety architecture as runCbMmCycle, venue-adapter based so it works
// for ANY ordered (makerVenue, hedgeVenue) pair among kraken/coinbase/gemini.
// AUTO never fires this; it is reached from the manual cb-mm-execute route when
// a Gemini leg is requested.

type VenueCycleParams = FullCreds & {
  asset: MmAsset; makerVenue: MmVenueId; hedgeVenue: MmVenueId; direction?: MmDirection;
  minNetUsd?: number | null; bufferUsd?: number | null;
  maxQuoteAgeMs?: number | null; restWindowSec?: number | null; sizeUsd?: number | null;
};

type LegFill = { orderId: string | null; status: string; filledQty: number; avgPrice: number; notionalUsd: number; feeUsd: number };

/** Precision/step metadata needed to size orders safely per venue. */
type VenueMeta = {
  kraken: null;
  coinbaseIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>> | null;
  gemini: GeminiSymbolDetails | null;
};

function stepFor(venue: MmVenueId, meta: VenueMeta): number {
  if (venue === "coinbase" && meta.coinbaseIncs) return parseFloat(meta.coinbaseIncs.baseIncrement);
  if (venue === "gemini" && meta.gemini) return meta.gemini.tickSize;
  return 1e-8; // Kraken lot step
}
function quantVenueQty(venue: MmVenueId, qty: number, meta: VenueMeta): number {
  if (venue === "coinbase" && meta.coinbaseIncs) return quantizeDown(qty, meta.coinbaseIncs.baseIncrement).value;
  if (venue === "gemini" && meta.gemini) return geminiQuantizeQty(qty, meta.gemini.tickSize);
  return Math.floor(qty / 1e-8) * 1e-8;
}

function explicitReject(venue: MmVenueId, msg: string): boolean {
  return venue === "kraken" ? isExplicitKrakenReject(msg)
    : venue === "gemini" ? isExplicitGeminiReject(msg)
    : /rejected/i.test(msg); // Coinbase surfaces success:false → thrown "rejected"
}

type VenueCycleResult = CycleResult & { makerVenue: string; hedgeVenue: string; structure: string; unhedgedResidualQty?: number };

async function runVenueMmCycle(b: VenueCycleParams, log: Logger): Promise<VenueCycleResult> {
  const asset = b.asset;
  const makerVenue = normVenue(b.makerVenue)!, hedgeVenue = normVenue(b.hedgeVenue)!;
  const structure = makerHedgeLabel(makerVenue, hedgeVenue);
  const sizeUsd = Math.min(SIZE_USD_CAP, Math.max(1, b.sizeUsd ?? SIZE_USD_CAP)); // HARD $10 cap
  const minNetUsd = floorFor(b.minNetUsd);
  const bufferUsd = bufferFor(sizeUsd, b.bufferUsd ?? undefined);
  const maxQuoteAgeMs = Math.min(b.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS, DEFAULT_MAX_QUOTE_AGE_MS); // tighten-only
  const restWindowSec = Math.min(MAX_REST_WINDOW_SEC, Math.max(5, b.restWindowSec ?? DEFAULT_REST_WINDOW_SEC));
  const startedAt = new Date().toISOString();

  const kCreds = { krakenKey: b.krakenKey, krakenSecret: b.krakenSecret };
  const cbCreds = { coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret };
  const gCreds: GeminiCreds | null = (b.geminiKey && b.geminiSecret) ? { geminiKey: b.geminiKey, geminiSecret: b.geminiSecret } : null;
  const kPairRaw = OB_USD_PAIRS[asset];
  const cbPair = cbPairFor(asset);
  const gemSym = `${asset}USD`;

  const base = { asset, makerVenue, hedgeVenue, structure, startedAt } as const;
  const finish = (outcome: string, reason: string, extra?: Partial<VenueCycleResult>): VenueCycleResult => {
    log.info({ ...base, outcome, reason }, "[MM2]");
    return { ...base, outcome, reason, finishedAt: new Date().toISOString(), makerLeg: null, hedgeLeg: null, realizedProfitUsd: null, projection: null, ...extra };
  };

  if (makerVenue === hedgeVenue) return finish("skipped", "maker and hedge venue must differ");
  const credOk = (v: MmVenueId) => v === "kraken" ? !!(b.krakenKey && b.krakenSecret) : v === "coinbase" ? !!(b.coinbaseKey && b.coinbaseSecret) : !!gCreds;
  if (!credOk(makerVenue) || !credOk(hedgeVenue)) return finish("skipped", "missing API credentials for one or both venues");
  if (!venueListsAsset(makerVenue, asset) || !venueListsAsset(hedgeVenue, asset)) return finish("skipped", `${asset} not supported on both venues`);
  if (liveNeedsReconcile) return finish("skipped", `live runs locked pending manual reconciliation: ${liveNeedsReconcile}. Verify on the exchanges, then restart the server.`);
  if (execInFlight) return finish("skipped", "an execution is already in flight");
  execInFlight = true;
  let lockGen: number | null = null;
  let ordersSubmitted = false;
  try {
    // 1. DETECTED fees on BOTH venues — refuse to guess (assumed never gates).
    const vfb = await detectVenueFB(b, { freshBalances: true });
    const mFb = vfb[makerVenue], hFb = vfb[hedgeVenue];
    if (mFb.feeSource !== "detected" || mFb.makerPct == null) return finish("skipped", `could not detect REAL maker fee tier on ${makerVenue} (never guessing for live): ${mFb.error ?? "unavailable"}`);
    if (hFb.feeSource !== "detected" || hFb.takerPct == null) return finish("skipped", `could not detect REAL taker fee tier on ${hedgeVenue} (never guessing for live): ${hFb.error ?? "unavailable"}`);
    const makerFeePct = mFb.makerPct, hedgeFeePct = hFb.takerPct;

    // 2. Best direction on CURRENT books.
    const projBuy = projectVenueMakerHedge(asset, makerVenue, hedgeVenue, "buy", sizeUsd, makerFeePct, hedgeFeePct);
    const projSell = projectVenueMakerHedge(asset, makerVenue, hedgeVenue, "sell", sizeUsd, makerFeePct, hedgeFeePct);
    const requested = b.direction;
    const candidates = (requested ? [requested === "buy" ? projBuy : projSell] : [projBuy, projSell]).filter((p): p is MmProjection => p != null);
    if (!candidates.length) return finish("skipped", "no live depth books on one/both venues (or depth cannot absorb the hedge)");
    const proj = candidates.reduce((a, c) => (c.projectedNetUsd > a.projectedNetUsd ? c : a));
    const projInfo = { direction: proj.direction, makerVenue, hedgeVenue, structure, makerPrice: proj.makerPrice, makerQty: proj.makerQty, projectedNetUsd: proj.projectedNetUsd, makerFeeUsd: proj.makerFeeUsd, hedgeFeeUsd: proj.hedgeFeeUsd, hedgeVwapPx: proj.hedgeVwapPx, hedgeSlippageUsd: proj.hedgeSlippageUsd, quoteAgeMs: proj.quoteAgeMs, makerFeePct, hedgeFeePct, minNetUsd, bufferUsd };
    const direction = proj.direction;

    log.info({ ...base, decision: "pre-fire", direction, routeAgeMs: proj.quoteAgeMs, scannerNetUsd: proj.projectedNetUsd, profitFloorUsd: minNetUsd, bufferUsd, maxQuoteAgeMs, legAges: proj.legAges }, "[MM2] decision");

    if (proj.quoteAgeMs > maxQuoteAgeMs) return finish("skipped", `books stale: oldest leg ${proj.quoteAgeMs}ms > ${maxQuoteAgeMs}ms — entire route treated as stale`, { projection: projInfo });
    if (proj.projectedNetUsd < minNetUsd + bufferUsd) return finish("skipped", `projected net $${proj.projectedNetUsd.toFixed(4)} below floor $${minNetUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}`, { projection: projInfo });

    // PRE-FIRE CONSISTENCY — a second immediate re-projection on the live books.
    const recheck = projectVenueMakerHedge(asset, makerVenue, hedgeVenue, direction, sizeUsd, makerFeePct, hedgeFeePct);
    if (!recheck) return finish("skipped", "PRICING CONSISTENCY ERROR: pre-fire re-projection lost the books — not executing", { projection: projInfo });
    if (Math.abs(recheck.projectedNetUsd - proj.projectedNetUsd) > CONSISTENCY_TOLERANCE_USD) {
      log.error({ ...base, scannerNetUsd: proj.projectedNetUsd, preFireNetUsd: recheck.projectedNetUsd }, "[MM2] PRICING CONSISTENCY ERROR");
      return finish("skipped", `PRICING CONSISTENCY ERROR: scanner net $${proj.projectedNetUsd.toFixed(4)} vs pre-fire net $${recheck.projectedNetUsd.toFixed(4)} diverged beyond $${CONSISTENCY_TOLERANCE_USD}`, { projection: projInfo });
    }
    if (recheck.quoteAgeMs > maxQuoteAgeMs) return finish("skipped", `books went stale during consistency check (${recheck.quoteAgeMs}ms > ${maxQuoteAgeMs}ms)`, { projection: projInfo });

    // 3. Inventory precheck for BOTH legs (FRESH balances from detectVenueFB).
    const inv = ventureInventory(makerVenue, hedgeVenue, direction, asset, proj.makerQty, sizeUsd, mFb, hFb);
    if (!inv.ready) return finish("skipped", `inventory precheck failed: ${inv.reason}`, { projection: projInfo });

    // 3.5 Mandatory precision metadata — never guess order precision live.
    const meta: VenueMeta = { kraken: null, coinbaseIncs: null, gemini: null };
    if (makerVenue === "coinbase" || hedgeVenue === "coinbase") {
      if (!cbPair) return finish("skipped", `Coinbase order routing not verified for ${asset}`, { projection: projInfo });
      try { meta.coinbaseIncs = await getCoinbaseProductIncrements(cbPair); }
      catch (e) { return finish("skipped", `Coinbase product increments unavailable — refusing to guess precision: ${(e as Error).message}`, { projection: projInfo }); }
    }
    if (makerVenue === "gemini" || hedgeVenue === "gemini") {
      try { meta.gemini = await geminiSymbolDetails(gemSym); }
      catch (e) { return finish("skipped", `Gemini symbol metadata unavailable — refusing to guess precision: ${(e as Error).message}`, { projection: projInfo }); }
      if (meta.gemini.status !== "open") return finish("skipped", `Gemini ${gemSym} market status is '${meta.gemini.status}' — not trading`, { projection: projInfo });
    }
    const makerStep = stepFor(makerVenue, meta), makerTol = 2 * makerStep;

    // 4. Shared live lock.
    lockGen = tryAcquireSharedLiveLock();
    if (lockGen == null) return finish("skipped", "another live executor holds the execution lock", { projection: projInfo });
    bindLockHeartbeat(liveLockHeartbeat(lockGen));

    // 5. POST-ONLY maker on makerVenue.
    const makerQty = quantVenueQty(makerVenue, proj.makerQty, meta);
    if (makerQty <= 0) return finish("skipped", "maker quantity quantized to zero", { projection: projInfo });
    if (makerVenue === "gemini" && meta.gemini && makerQty < meta.gemini.minOrderSize) {
      return finish("skipped", `maker qty ${makerQty} below Gemini min order size ${meta.gemini.minOrderSize}`, { projection: projInfo });
    }
    // HARD $10 CAP — worst-case MAKER spend on the ACTUAL quantized qty/price
    // (not just the initial sizeUsd). A BUY spends makerQty×price + fee; a SELL
    // acquires that notional. Refuse if it can exceed the cap.
    const makerWorstNotional = makerQty * proj.makerPrice;
    const makerWorstSpend = makerWorstNotional * (1 + makerFeePct / 100);
    if (makerWorstSpend > SIZE_USD_CAP + 1e-9) {
      return finish("skipped", `maker worst-case spend $${makerWorstSpend.toFixed(4)} (qty ${makerQty} × $${proj.makerPrice} + ${makerFeePct}% fee) exceeds $${SIZE_USD_CAP} hard cap — refusing`, { projection: projInfo });
    }
    const t0 = Date.now();
    ordersSubmitted = true;
    let makerId: string | null = null;
    try {
      if (makerVenue === "kraken") {
        const r = await krakenRawLimitOrder(kCreds, direction, makerQty, proj.makerPrice, kPairRaw);
        makerId = r.txid?.[0] ?? null;
        if (!makerId) throw new Error("Kraken returned no txid");
      } else if (makerVenue === "coinbase") {
        const r = await coinbaseLimitOrder(cbCreds, direction === "buy" ? "BUY" : "SELL", makerQty, proj.makerPrice, cbPair!, meta.coinbaseIncs ?? undefined);
        if (r.success === false) return finish("post_rejected", "Coinbase rejected the post-only order (would have crossed) — nothing traded", { projection: projInfo });
        makerId = r.orderId ?? null;
        if (!makerId) throw new Error("Coinbase returned no order id");
      } else {
        // Gemini maker-or-cancel: rejected (cancelled) if it would cross.
        const r = await geminiMakerOrCancelOrder(gCreds!, direction, gemSym, makerQty, proj.makerPrice, meta.gemini!);
        makerId = r.orderId;
        if (r.terminal && r.filledQty <= 0) return finish("post_rejected", "Gemini maker-or-cancel would have crossed — cancelled, nothing rested", { projection: projInfo });
        if (!makerId) throw new Error("Gemini returned no order id");
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (explicitReject(makerVenue, msg)) return finish("post_rejected", `${makerVenue} rejected the post-only order — nothing traded: ${msg}`, { projection: projInfo });
      liveNeedsReconcile = `${makerVenue} MAKER ${direction} (id unknown) unconfirmed: ${msg}`;
      await recordLedger({ asset, makerVenue, hedgeVenue, direction, note: "indeterminate: maker submit unconfirmed", volume: 0, makerPx: proj.makerPrice, hedgePx: 0, makerId: null, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
      return finish("indeterminate", `${makerVenue} maker order UNCONFIRMED (${msg}) — check ${makerVenue} open orders before trading again. Live runs locked.`, { projection: projInfo });
    }

    // 6. Rest window: poll for terminal; cancel-on-degrade before a fill.
    const restDeadline = Date.now() + restWindowSec * 1000;
    let mFill: LegFill | null = null;
    let cancelReason: string | null = null;
    while (Date.now() < restDeadline) {
      touchLiveLock();
      if (!liveLockOwned(lockGen)) { cancelReason = "execution lock evicted (KILL/HARD RESET)"; break; }
      try {
        const st = await makerStatus(makerVenue, makerId!, { kCreds, cbCreds, gCreds, cbPair, gemSym, feePct: makerFeePct });
        if (!liveLockOwned(lockGen)) { cancelReason = "execution lock evicted (KILL/HARD RESET) mid-poll"; break; }
        if (st.terminal) { mFill = st.fill; break; }
        const remaining = Math.max(0, makerQty - st.fill.filledQty);
        if (remaining > makerTol) {
          const re = projectVenueMakerHedge(asset, makerVenue, hedgeVenue, direction, sizeUsd, makerFeePct, hedgeFeePct, proj.makerPrice, remaining);
          if (!re) { cancelReason = "hedge book lost while resting"; break; }
          if (re.quoteAgeMs > maxQuoteAgeMs) { cancelReason = `hedge book stale (${re.quoteAgeMs}ms) while resting`; break; }
          const scaledFloor = minNetUsd * (remaining / makerQty);
          if (re.projectedNetUsd < scaledFloor + bufferUsd) { cancelReason = `projected hedge net $${re.projectedNetUsd.toFixed(4)} fell below scaled floor $${scaledFloor.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}`; break; }
        }
      } catch { /* poll again */ }
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    // Not terminal → cancel (timeout or gate). Cancel MUST be confirmed.
    if (!mFill) {
      const why = cancelReason ?? `rest window (${restWindowSec}s) expired without a fill`;
      try {
        await cancelMaker(makerVenue, makerId!, { kCreds, cbCreds, gCreds });
        const dl = Date.now() + TERMINAL_WAIT_MS;
        while (Date.now() < dl) {
          touchLiveLock();
          try {
            const st = await makerStatus(makerVenue, makerId!, { kCreds, cbCreds, gCreds, cbPair, gemSym, feePct: makerFeePct });
            if (st.terminal) { mFill = st.fill; break; }
          } catch { /* poll again */ }
          await new Promise(r => setTimeout(r, POLL_MS));
        }
        if (!mFill) throw new Error("cancel submitted but order never reached a terminal state");
      } catch (e) {
        liveNeedsReconcile = `${makerVenue} MAKER ${makerId} cancel UNCONFIRMED: ${(e as Error).message}`;
        await recordLedger({ asset, makerVenue, hedgeVenue, direction, note: "indeterminate: cancel unconfirmed", volume: 0, makerPx: proj.makerPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
        return finish("indeterminate", `cancel of maker order ${makerId} unconfirmed (${(e as Error).message}) — it may still be live on ${makerVenue}. Live runs locked.`, { projection: projInfo });
      }
      log.info({ ...base, makerId, why }, "[MM2] maker cancelled");
    }

    const filledQty = mFill.filledQty;
    const makerNotional = mFill.notionalUsd;
    const makerFeeUsd = mFill.feeUsd;
    const makerLeg = { venue: makerVenue, side: direction, orderId: makerId, status: mFill.status, filledQty, avgPrice: mFill.avgPrice || null, notionalUsd: makerNotional || null, feeUsd: makerFeeUsd, latencyMs: Date.now() - t0 };

    // 7. No fill → clean exit; no hedge ever opened.
    if (filledQty <= 0) return finish("no_fill", `maker order ended ${mFill.status} with no fill${cancelReason ? ` (cancelled: ${cancelReason})` : ""} — nothing traded, no hedge opened`, { makerLeg, projection: projInfo });

    // 8. CONFIRMED fill → hedge EXACTLY the filled quantity, bounded IOC.
    if (!liveLockOwned(lockGen)) {
      liveNeedsReconcile = `${makerVenue} maker ${makerId} filled ${filledQty.toFixed(8)} ${asset} but execution lock was evicted before the hedge`;
      await recordLedger({ asset, makerVenue, hedgeVenue, direction, note: `unhedged: lock evicted before hedge; unhedgedResidualQty ${filledQty.toFixed(8)}`, volume: filledQty, makerPx: mFill.avgPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
      return finish("unhedged", liveNeedsReconcile, { makerLeg, projection: projInfo, unhedgedResidualQty: filledQty });
    }
    const freshProj = projectVenueMakerHedge(asset, makerVenue, hedgeVenue, direction, sizeUsd, makerFeePct, hedgeFeePct, mFill.avgPrice || proj.makerPrice, filledQty);
    const hedgeSide: "buy" | "sell" = direction === "buy" ? "sell" : "buy";
    const refTop = freshProj?.hedgeTopPx ?? (mFill.avgPrice || proj.makerPrice);
    const collarPx = hedgeSide === "sell" ? refTop * 0.995 : refTop * 1.005;
    const hedgeStep = stepFor(hedgeVenue, meta);
    const hedgeTarget = quantVenueQty(hedgeVenue, filledQty, meta);
    // QUANTIZATION RESIDUAL — quantize-down can leave hedgeTarget < the confirmed
    // maker fill by any nonzero amount. That base quantity is UNHEDGED exposure;
    // it must NEVER be folded into a clean/completed P&L. If it is below the
    // hedge-venue minimum order size it still cannot be hedged this cycle, so it
    // is explicitly recorded as unhedged residual (never silently dropped).
    const quantResidualQty = Math.max(0, filledQty - hedgeTarget);
    const hedgeMinSize = hedgeVenue === "gemini" && meta.gemini ? meta.gemini.minOrderSize : 0;
    const t1 = Date.now();
    let hedgeFill: LegFill = { orderId: null, status: "unknown", filledQty: 0, avgPrice: 0, notionalUsd: 0, feeUsd: 0 };
    let hedgeError: string | null = null;
    let hedgeIndeterminate = false;
    if (hedgeTarget <= 0 || (hedgeMinSize > 0 && hedgeTarget < hedgeMinSize)) {
      liveNeedsReconcile = `${makerVenue} maker filled ${filledQty.toFixed(8)} ${asset} but hedge target ${hedgeTarget.toFixed(8)} on ${hedgeVenue} is ${hedgeTarget <= 0 ? "zero after quantize" : `below min order size ${hedgeMinSize}`} — full fill is UNHEDGED`;
      await recordLedger({ asset, makerVenue, hedgeVenue, direction, note: `unhedged: unhedgedResidualQty ${filledQty.toFixed(8)}`, volume: filledQty, makerPx: mFill.avgPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
      return finish("unhedged", liveNeedsReconcile, { makerLeg, projection: projInfo, unhedgedResidualQty: filledQty });
    }
    // HARD $10 CAP — worst-case HEDGE spend at the protective collar bound (the
    // most the IOC could pay), plus fee. Refuse before submission if > cap.
    const hedgeWorstNotional = hedgeTarget * collarPx;
    const hedgeWorstSpend = hedgeWorstNotional * (1 + hedgeFeePct / 100);
    if (hedgeWorstSpend > SIZE_USD_CAP + 1e-9) {
      // Maker already filled — we cannot spend beyond the cap to hedge, so the
      // position is left unhedged and latched for manual reconciliation.
      liveNeedsReconcile = `${makerVenue} maker filled ${filledQty.toFixed(8)} ${asset} but hedge worst-case spend $${hedgeWorstSpend.toFixed(4)} (qty ${hedgeTarget} × collar $${collarPx.toFixed(6)} + ${hedgeFeePct}% fee) exceeds $${SIZE_USD_CAP} hard cap — NOT hedging`;
      await recordLedger({ asset, makerVenue, hedgeVenue, direction, note: `unhedged: hedge over hard cap; unhedgedResidualQty ${filledQty.toFixed(8)}`, volume: filledQty, makerPx: mFill.avgPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, log);
      return finish("unhedged", liveNeedsReconcile, { makerLeg, projection: projInfo, unhedgedResidualQty: filledQty });
    }
    try {
      const hr = await placeHedgeIoc(hedgeVenue, hedgeSide, asset, hedgeTarget, collarPx, { kCreds, cbCreds, gCreds, kPairRaw, cbPair, gemSym, cbIncs: meta.coinbaseIncs, gemDetails: meta.gemini, feePct: hedgeFeePct });
      hedgeFill = hr.fill;
      hedgeIndeterminate = hr.indeterminate;
      hedgeError = hr.error;
      if (hr.indeterminate && !liveNeedsReconcile) liveNeedsReconcile = `${hedgeVenue} HEDGE ${hr.fill.orderId ?? "(id unknown)"} unconfirmed: ${hr.error ?? "not terminal"}`;
    } catch (e) {
      hedgeError = (e as Error).message;
      if (!explicitReject(hedgeVenue, hedgeError)) { hedgeIndeterminate = true; if (!liveNeedsReconcile) liveNeedsReconcile = `${hedgeVenue} HEDGE unconfirmed: ${hedgeError}`; }
    }

    const hedgedQty = hedgeFill.filledQty;
    // FULLY hedged only when: hedge terminal, filled ≥ target (within a step),
    // AND there is no quantization residual left over from the maker fill.
    const hedgeFilledTarget = !hedgeIndeterminate && hedgedQty >= hedgeTarget - hedgeStep;
    const noQuantResidual = quantResidualQty <= hedgeStep;
    const fullyHedged = hedgeFilledTarget && noQuantResidual;
    const hedgeShortfall = Math.max(0, hedgeTarget - hedgedQty); // qty targeted but not filled
    const unhedgedResidualQty = hedgeShortfall + quantResidualQty; // total unhedged base exposure
    const hedgeLeg = { venue: hedgeVenue, side: hedgeSide, orderId: hedgeFill.orderId, status: hedgeIndeterminate ? "indeterminate" : hedgeFill.status, filledQty: hedgedQty, avgPrice: hedgeFill.avgPrice || null, notionalUsd: hedgeFill.notionalUsd || null, feeUsd: hedgeFill.feeUsd || null, latencyMs: Date.now() - t1 };

    let realized: number | null = null;
    if (fullyHedged) {
      realized = direction === "buy"
        ? (hedgeFill.notionalUsd - hedgeFill.feeUsd) - (makerNotional + makerFeeUsd)   // sold on hedge, bought on maker
        : (makerNotional - makerFeeUsd) - (hedgeFill.notionalUsd + hedgeFill.feeUsd);  // sold on maker, bought back on hedge
    }
    const outcome = hedgeIndeterminate ? "indeterminate" : fullyHedged ? "completed" : "unhedged";
    if (outcome !== "completed" && !liveNeedsReconcile) {
      liveNeedsReconcile = `${makerVenue} maker filled ${filledQty.toFixed(8)} ${asset}, hedge ${hedgeLeg.status} — unhedged residual ${unhedgedResidualQty.toFixed(8)} ${asset}`;
    }
    const auditOk = await recordLedger({
      asset, makerVenue, hedgeVenue, direction,
      note: outcome === "completed" ? "" : `${outcome}: unhedgedResidualQty ${unhedgedResidualQty.toFixed(8)}`,
      volume: filledQty, makerPx: mFill.avgPrice, hedgePx: hedgeFill.avgPrice || 0,
      makerId, hedgeId: hedgeFill.orderId,
      status: outcome === "completed" ? "verified" : "unhedged",
      realized, expected: freshProj?.projectedNetUsd ?? proj.projectedNetUsd,
    }, log);
    // AUDIT-RECORD FAILURE — never report a clean/completed cycle if the ledger
    // write failed; latch for manual reconciliation and downgrade the outcome.
    if (!auditOk) {
      liveNeedsReconcile = liveNeedsReconcile ?? `audit record (ledger) write FAILED for ${makerVenue} maker ${makerId}/${hedgeVenue} hedge ${hedgeFill.orderId ?? "?"} — reconcile manually`;
      log.info({ ...base, outcome: "indeterminate", reason: "audit record failed" }, "[MM2] finished");
      return finish("indeterminate", `cycle executed (maker filled ${filledQty.toFixed(8)}) but the audit ledger write FAILED — verify both exchanges manually; live runs locked pending reconciliation.`, { makerLeg, hedgeLeg, realizedProfitUsd: null, projection: projInfo, unhedgedResidualQty });
    }
    log.info({ ...base, outcome, realized, filledQty, hedgedQty, unhedgedResidualQty }, "[MM2] finished");
    const geminiFeeNote = (makerVenue === "gemini" || hedgeVenue === "gemini")
      ? "Gemini leg fee computed from YOUR verified tier on the confirmed notional (order status API reports no per-order fee)" : undefined;
    return {
      ...base,
      outcome,
      reason: outcome === "completed"
        ? `maker filled ${filledQty.toFixed(8)} @ ${mFill.avgPrice}, hedged fully — realized $${realized!.toFixed(4)}`
        : `maker filled ${filledQty.toFixed(8)} but hedge ${hedgeLeg.status}${hedgeError ? `: ${hedgeError}` : ""} — unhedged residual ${unhedgedResidualQty.toFixed(8)} ${asset} exposure${liveNeedsReconcile ? "; live runs locked pending reconciliation" : ""}`,
      finishedAt: new Date().toISOString(),
      makerLeg, hedgeLeg, realizedProfitUsd: realized, projection: { ...projInfo, geminiFeeNote },
      unhedgedResidualQty: outcome === "completed" ? 0 : unhedgedResidualQty,
    };
  } catch (err) {
    const msg = (err as Error).message;
    if (ordersSubmitted) {
      // An order may exist and its state is unknown — never a clean skip.
      liveNeedsReconcile = liveNeedsReconcile ?? `unexpected error after order submission: ${msg}`;
      await recordLedger({ asset, makerVenue, hedgeVenue, direction: b.direction ?? "buy", note: `indeterminate: ${msg.slice(0, 80)}`, volume: 0, makerPx: 0, hedgePx: 0, makerId: null, hedgeId: null, status: "unhedged", realized: null, expected: 0 }, log);
      return finish("indeterminate", `${msg} — verify both exchanges manually; live runs locked pending reconciliation.`);
    }
    return finish("skipped", msg);
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
    execInFlight = false;
  }
}

// Per-venue maker order status (terminal + confirmed fill fields). Gemini has
// no per-order fee → fee = verified maker tier × confirmed notional.
async function makerStatus(
  venue: MmVenueId, orderId: string,
  ctx: { kCreds: { krakenKey: string; krakenSecret: string }; cbCreds: { coinbaseKey: string; coinbaseSecret: string }; gCreds: GeminiCreds | null; cbPair: Pair | null; gemSym: string; feePct: number },
): Promise<{ terminal: boolean; fill: LegFill }> {
  if (venue === "kraken") {
    const o = await krakenOrderInfo(ctx.kCreds, orderId);
    const terminal = ["closed", "canceled", "expired"].includes(o.status);
    return { terminal, fill: { orderId, status: o.status, filledQty: o.volExec || 0, avgPrice: o.price || 0, notionalUsd: o.cost || 0, feeUsd: o.fee || 0 } };
  }
  if (venue === "coinbase") {
    const x = await coinbaseOrderDetails(ctx.cbCreds, orderId);
    const terminal = ["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status);
    return { terminal, fill: { orderId, status: x.status, filledQty: x.filledSize || 0, avgPrice: x.avgPrice || 0, notionalUsd: x.filledValue || 0, feeUsd: x.totalFees || 0 } };
  }
  const g = await geminiOrderStatus(ctx.gCreds!, orderId);
  return { terminal: g.terminal, fill: { orderId, status: g.status, filledQty: g.filledQty, avgPrice: g.avgPrice, notionalUsd: g.notionalUsd, feeUsd: g.notionalUsd * (ctx.feePct / 100) } };
}

async function cancelMaker(
  venue: MmVenueId, orderId: string,
  ctx: { kCreds: { krakenKey: string; krakenSecret: string }; cbCreds: { coinbaseKey: string; coinbaseSecret: string }; gCreds: GeminiCreds | null },
): Promise<void> {
  if (venue === "kraken") return void await krakenCancelOrder(ctx.kCreds, orderId);
  if (venue === "coinbase") return void await coinbaseCancelOrder(ctx.cbCreds, orderId);
  await geminiCancelOrder(ctx.gCreds!, orderId);
}

// Bounded IOC hedge on any venue, polled to terminal (the ONLY truth = actual
// filled qty). Gemini fee from verified tier × confirmed notional.
async function placeHedgeIoc(
  venue: MmVenueId, side: "buy" | "sell", asset: MmAsset, qty: number, collarPx: number,
  ctx: {
    kCreds: { krakenKey: string; krakenSecret: string }; cbCreds: { coinbaseKey: string; coinbaseSecret: string }; gCreds: GeminiCreds | null;
    kPairRaw: string; cbPair: Pair | null; gemSym: string;
    cbIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>> | null; gemDetails: GeminiSymbolDetails | null; feePct: number;
  },
): Promise<{ fill: LegFill; indeterminate: boolean; error: string | null }> {
  if (venue === "kraken") {
    let txid: string | null = null;
    try {
      const r = await krakenRawIocLimitOrder(ctx.kCreds, side, qty, collarPx, ctx.kPairRaw);
      txid = r.txid?.[0] ?? null;
      if (!txid) throw new Error("Kraken returned no txid");
    } catch (e) {
      const msg = (e as Error).message;
      return { fill: { orderId: txid, status: "unknown", filledQty: 0, avgPrice: 0, notionalUsd: 0, feeUsd: 0 }, indeterminate: !isExplicitKrakenReject(msg), error: msg };
    }
    let info = { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
    const dl = Date.now() + TERMINAL_WAIT_MS;
    while (Date.now() < dl) {
      touchLiveLock();
      try { info = await krakenOrderInfo(ctx.kCreds, txid); } catch { /* poll again */ }
      if (["closed", "canceled", "expired"].includes(info.status)) break;
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    if (!["closed", "canceled", "expired"].includes(info.status)) {
      try {
        await krakenCancelOrder(ctx.kCreds, txid); const dl2 = Date.now() + 10_000;
        while (Date.now() < dl2) { touchLiveLock(); try { info = await krakenOrderInfo(ctx.kCreds, txid); } catch { /* */ } if (["closed", "canceled", "expired"].includes(info.status)) break; await new Promise(r => setTimeout(r, POLL_MS)); }
      } catch { /* fall through to indeterminate */ }
    }
    const terminal = ["closed", "canceled", "expired"].includes(info.status);
    return { fill: { orderId: txid, status: info.status, filledQty: info.volExec || 0, avgPrice: info.price || 0, notionalUsd: info.cost || 0, feeUsd: info.fee || 0 }, indeterminate: !terminal, error: terminal ? null : "hedge not terminal after wait + cancel" };
  }
  if (venue === "coinbase") {
    let orderId: string | null = null;
    try {
      const r = await coinbaseIocLimitOrder(ctx.cbCreds, side === "buy" ? "BUY" : "SELL", qty, collarPx, ctx.cbPair!, ctx.cbIncs ?? undefined);
      orderId = r.orderId ?? null;
      if (!orderId) throw new Error("Coinbase returned no order id");
      let det: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
      const dl = Date.now() + TERMINAL_WAIT_MS;
      while (Date.now() < dl) {
        touchLiveLock();
        try { const x = await coinbaseOrderDetails(ctx.cbCreds, orderId); if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status)) { det = x; break; } } catch { /* */ }
        await new Promise(r => setTimeout(r, POLL_MS));
      }
      if (!det) det = await coinbaseOrderDetails(ctx.cbCreds, orderId);
      const terminal = ["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(det.status);
      return { fill: { orderId, status: det.status, filledQty: det.filledSize || 0, avgPrice: det.avgPrice || 0, notionalUsd: det.filledValue || 0, feeUsd: det.totalFees || 0 }, indeterminate: !terminal, error: terminal ? null : "hedge not terminal after wait" };
    } catch (e) {
      const msg = (e as Error).message;
      return { fill: { orderId, status: "unknown", filledQty: 0, avgPrice: 0, notionalUsd: 0, feeUsd: 0 }, indeterminate: !/rejected/i.test(msg), error: msg };
    }
  }
  // gemini
  let orderId: string | null = null;
  try {
    const sub = await geminiIocLimitOrder(ctx.gCreds!, side, ctx.gemSym, qty, collarPx, ctx.gemDetails!);
    orderId = sub.orderId;
  } catch (e) {
    const msg = (e as Error).message;
    return { fill: { orderId, status: "unknown", filledQty: 0, avgPrice: 0, notionalUsd: 0, feeUsd: 0 }, indeterminate: !isExplicitGeminiReject(msg), error: msg };
  }
  let info: Awaited<ReturnType<typeof geminiOrderStatus>> | null = null;
  const dl = Date.now() + TERMINAL_WAIT_MS;
  while (Date.now() < dl) {
    touchLiveLock();
    try { const x = await geminiOrderStatus(ctx.gCreds!, orderId); if (x.terminal) { info = x; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  if (!info) { try { const x = await geminiOrderStatus(ctx.gCreds!, orderId); if (x.terminal) info = x; } catch { /* */ } }
  if (!info) return { fill: { orderId, status: "unknown", filledQty: 0, avgPrice: 0, notionalUsd: 0, feeUsd: 0 }, indeterminate: true, error: "hedge not terminal after wait" };
  return { fill: { orderId, status: info.status, filledQty: info.filledQty, avgPrice: info.avgPrice, notionalUsd: info.notionalUsd, feeUsd: info.notionalUsd * (ctx.feePct / 100) }, indeterminate: false, error: null };
}

// Ledger row for Gemini-inclusive structures (records both venues honestly).
// Returns TRUE only if the audit row was durably written; FALSE means the
// audit record FAILED and the caller MUST latch reconciliation (never report a
// clean/completed cycle after a failed audit write).
async function recordLedger(o: {
  asset: string; makerVenue: MmVenueId; hedgeVenue: MmVenueId; direction: MmDirection; note: string;
  volume: number; makerPx: number; hedgePx: number; makerId: string | null; hedgeId: string | null;
  status: string; realized: number | null; expected: number;
}, log: Logger): Promise<boolean> {
  try {
    await db.insert(tradesTable).values({
      pair: `MM2:${o.asset} ${o.makerVenue}(maker)→${o.hedgeVenue}(hedge)${o.note ? ` [${o.note.slice(0, 90)}]` : ""}`,
      // buy = maker buys / hedge sells; sell = maker sells / hedge buys.
      buyExchange: o.direction === "buy" ? o.makerVenue : o.hedgeVenue,
      sellExchange: o.direction === "buy" ? o.hedgeVenue : o.makerVenue,
      volume: o.volume.toFixed(8),
      estimatedProfitUsd: o.expected.toFixed(6), netEdgePct: "0", isDryRun: false,
      krakenPrice: o.hedgePx.toFixed(8), coinbasePrice: o.makerPx.toFixed(8),
      buyOrderId: o.direction === "buy" ? o.makerId : o.hedgeId,
      sellOrderId: o.direction === "buy" ? o.hedgeId : o.makerId,
      status: o.status,
      realizedProfitUsd: o.realized != null ? o.realized.toFixed(6) : null,
    });
    return true;
  } catch (e) { log.error({ err: e }, "[MM2] venue ledger write failed"); return false; }
}

// ── POST /arb/cb-mm-execute ──────────────────────────────────────────────────
router.post("/arb/cb-mm-execute", async (req, res): Promise<void> => {
  const parsed = ExecuteCbMmBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  if (!(MM_ASSETS as readonly string[]).includes(b.asset)) { res.status(400).json({ error: `asset must be one of ${MM_ASSETS.join(", ")}` }); return; }
  // Optional venue selection (read from the raw body — the generated schema
  // strips these). Only ABSENT venues take the legacy default; a PRESENT-but-
  // invalid venue is a hard 400 (never silently reroute to the CB→K executor).
  const rawBody = (req.body ?? {}) as Record<string, unknown>;
  const makerPresent = rawBody.makerVenue != null && rawBody.makerVenue !== "";
  const hedgePresent = rawBody.hedgeVenue != null && rawBody.hedgeVenue !== "";
  const makerVenue = makerPresent ? readRawVenue(req.body, "makerVenue") : null;
  const hedgeVenue = hedgePresent ? readRawVenue(req.body, "hedgeVenue") : null;
  if (makerPresent && makerVenue == null) { res.status(400).json({ error: `makerVenue must be one of ${MM_VENUES.join(", ")}` }); return; }
  if (hedgePresent && hedgeVenue == null) { res.status(400).json({ error: `hedgeVenue must be one of ${MM_VENUES.join(", ")}` }); return; }
  // Explicit selection requires BOTH venues; partial selection is a 400 (never
  // guess the missing leg).
  if (makerPresent !== hedgePresent) { res.status(400).json({ error: "makerVenue and hedgeVenue must be provided together (or both omitted for the legacy Coinbase→Kraken default)" }); return; }
  const gem = readRawGemini(req.body);
  if (makerPresent && hedgePresent) {
    // Explicit venue selection → the generalized cycle (covers Gemini-inclusive
    // AND explicit CB→K; identical hard-cap safety either way).
    if (makerVenue === hedgeVenue) { res.status(400).json({ error: "makerVenue and hedgeVenue must differ" }); return; }
    const result = await runVenueMmCycle({ ...b, ...gem, asset: b.asset as MmAsset, makerVenue: makerVenue!, hedgeVenue: hedgeVenue!, direction: b.direction as MmDirection | undefined }, req.log);
    res.json(result);
    return;
  }
  // Both venues omitted → unchanged legacy hardened Coinbase-maker → Kraken-hedge.
  const result = await runCbMmCycle({ ...b, asset: b.asset as MmAsset, direction: b.direction as MmDirection | undefined }, req.log);
  res.json(result);
});

// ── POST /arb/mm-scan ────────────────────────────────────────────────────────
// READ-ONLY inventory-aware scan of every asset × direction × structure with
// REAL detected fees. Never trades. The RUN verdict mirrors exactly the gate
// the executor enforces (floor + buffer + freshness + inventory).
router.post("/arb/mm-scan", async (req, res): Promise<void> => {
  const parsed = MmScanBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  const floorUsd = floorFor(b.minNetUsd);
  const bufferUsd = bufferFor(SIZE_USD_CAP, b.bufferUsd ?? undefined);
  let fees: Fees, bal: Balances;
  try { fees = await detectFees(b); }
  catch (e) { res.status(502).json({ error: `could not detect REAL fee tiers (never guessing): ${(e as Error).message}` }); return; }
  try { bal = await fetchBalances(b); }
  catch (e) { res.status(502).json({ error: `balance fetch failed: ${(e as Error).message}` }); return; }
  const rows = scanAll(fees, bal, floorUsd, bufferUsd, DEFAULT_MAX_QUOTE_AGE_MS);
  // Additively append Gemini-inclusive maker→hedge structures (K↔CB stay above,
  // byte-for-byte). Gemini creds are read from the raw body (schema strips them);
  // fees/balances are detected per venue and clearly labeled detected/assumed.
  try {
    const gem = readRawGemini(req.body);
    const vfb = await detectVenueFB({ ...b, ...gem });
    rows.push(...scanGeminiPairs(vfb, floorUsd, bufferUsd, DEFAULT_MAX_QUOTE_AGE_MS));
    rows.sort((a2, b2) => (b2.projectedNetUsd ?? -1e9) - (a2.projectedNetUsd ?? -1e9));
  } catch (e) { req.log.warn({ err: (e as Error).message }, "[MM2] gemini scan pairs skipped"); }
  // Gate summary — distinguish WHY nothing qualifies (honest taxonomy).
  const avail = rows.filter(r => r.available && r.projectedNetUsd != null);
  const positives = avail.filter(r => (r.projectedNetUsd ?? 0) > 0);
  const runnable = rows.filter(r => r.verdict === "RUN");
  let gateStatus: string, gateDetail: string;
  if (runnable.length > 0) {
    gateStatus = "EXECUTABLE";
    gateDetail = `${runnable.length} route(s) clear the full gate right now`;
  } else if (avail.length === 0) {
    gateStatus = "STALE_DATA";
    gateDetail = "no live books fresh enough to price any route";
  } else if (positives.length === 0) {
    const bestRow = avail[0];
    const feeUsd = (bestRow?.makerFeeUsd ?? 0) + (bestRow?.hedgeFeeUsd ?? 0);
    const gross = bestRow?.grossEdgeUsd ?? 0;
    gateStatus = gross > 0 && feeUsd > gross ? "BLOCKED_BY_FEES" : "NO_EDGE";
    gateDetail = gross > 0 && feeUsd > gross
      ? `best gross edge $${gross.toFixed(4)} exists but fees $${feeUsd.toFixed(4)} exceed it — fee tier is the blocker`
      : "no positive gross edge exists on current books — the market is simply too tight";
  } else {
    const inv = positives.filter(r => !r.inventoryReady);
    const stale = positives.filter(r => r.inventoryReady && (r.quoteAgeMs ?? 0) > DEFAULT_MAX_QUOTE_AGE_MS);
    if (inv.length === positives.length) { gateStatus = "INSUFFICIENT_INVENTORY"; gateDetail = `${inv.length} positive route(s) blocked only by inventory: ${inv[0]?.inventoryReason ?? ""}`; }
    else if (stale.length > 0) { gateStatus = "STALE_DATA"; gateDetail = `${stale.length} positive route(s) blocked by the 200ms freshness rule`; }
    else { gateStatus = "BELOW_FLOOR"; gateDetail = `positive nets exist but none clears floor $${floorUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}`; }
  }
  res.json({
    gateSummary: { status: gateStatus, detail: gateDetail, maxQuoteAgeMs: DEFAULT_MAX_QUOTE_AGE_MS },
    sizeUsd: SIZE_USD_CAP, floorUsd, bufferUsd, requiredNetUsd: floorUsd + bufferUsd,
    fees: { coinbaseMakerPct: fees.cbMakerPct, coinbaseTakerPct: fees.cbTakerPct, krakenTakerPct: fees.kTakerPct, krakenMakerPct: fees.kMakerPct, detectedAt: new Date(fees.detectedAt).toISOString() },
    balances: { krakenUsd: bal.kUsd, coinbaseUsd: bal.cbUsd, fetchedAt: new Date(bal.fetchedAt).toISOString() },
    at: new Date().toISOString(),
    best: rows.find(r => r.available) ?? null,
    rows: rows.slice(0, 40),
    runnable: rows.filter(r => r.verdict === "RUN").length,
  });
});

// ── AUTO mode ────────────────────────────────────────────────────────────────
// Watches continuously server-side and fires ONE hardened cb-maker cycle at a
// time, only when a route clears the FULL gate. Stops itself on any
// unhedged/indeterminate outcome. Credentials live in memory only.
type AutoEvent = { at: string; kind: string; detail: string };
const autoState = {
  running: false,
  startedAt: null as string | null,
  lastTickAt: null as string | null,
  ticks: 0, fires: 0, completed: 0,
  realizedUsd: 0,
  stopReason: null as string | null,
  config: { minNetUsd: MIN_FLOOR_USD, bufferUsd: 0.02, restWindowSec: DEFAULT_REST_WINDOW_SEC },
  lastBest: null as ScanRow | null,
  lastOutcome: null as { at: string; outcome: string; reason: string; realizedUsd: number | null } | null,
  events: [] as AutoEvent[],
};
let autoCreds: Creds | null = null;
let autoTimer: NodeJS.Timeout | null = null;
let autoTickRunning = false;
const AUTO_TICK_MS = 5_000;

function autoLog(kind: string, detail: string) {
  autoState.events.unshift({ at: new Date().toISOString(), kind, detail });
  if (autoState.events.length > 30) autoState.events.length = 30;
}

function stopAuto(reason: string) {
  autoState.running = false;
  autoState.stopReason = reason;
  autoCreds = null;
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  autoLog("stop", reason);
}

async function autoTick(log: Logger): Promise<void> {
  if (!autoState.running || autoTickRunning || !autoCreds) return;
  autoTickRunning = true;
  try {
    autoState.ticks++;
    autoState.lastTickAt = new Date().toISOString();
    if (liveNeedsReconcile) { stopAuto(`live runs latched: ${liveNeedsReconcile}`); return; }
    if (execInFlight) return; // another executor busy — wait
    let fees: Fees, bal: Balances;
    try { fees = await detectFees(autoCreds); bal = await fetchBalances(autoCreds); }
    catch (e) { autoLog("warn", `fee/balance fetch failed: ${(e as Error).message}`); return; }
    const { minNetUsd, bufferUsd } = autoState.config;
    const rows = scanAll(fees, bal, minNetUsd, bufferUsd, DEFAULT_MAX_QUOTE_AGE_MS);
    autoState.lastBest = rows.find(r => r.available) ?? null;
    const candidate = rows.find(r => r.verdict === "RUN" && r.autoExecutable);
    const reverseBetter = rows.find(r => r.verdict === "RUN" && !r.autoExecutable);
    if (reverseBetter && (!candidate || (reverseBetter.projectedNetUsd ?? -1) > (candidate.projectedNetUsd ?? -1))) {
      autoLog("info", `reverse structure (Kraken-maker) ${reverseBetter.asset} ${reverseBetter.direction} projects $${reverseBetter.projectedNetUsd?.toFixed(4)} — AUTO fires only the hardened Coinbase-maker executor; run the reverse manually from the diagnostics area if desired`);
    }
    if (!candidate) return;
    autoState.fires++;
    autoLog("fire", `${candidate.asset} ${candidate.direction} projected $${candidate.projectedNetUsd?.toFixed(4)} — placing post-only maker`);
    const r = await runCbMmCycle({
      ...autoCreds, asset: candidate.asset, direction: candidate.direction,
      minNetUsd, bufferUsd, restWindowSec: autoState.config.restWindowSec,
    }, log);
    autoState.lastOutcome = { at: new Date().toISOString(), outcome: r.outcome, reason: r.reason, realizedUsd: r.realizedProfitUsd };
    autoLog("result", `${r.outcome}: ${r.reason}`);
    if (r.outcome === "completed" && r.realizedProfitUsd != null) { autoState.completed++; autoState.realizedUsd += r.realizedProfitUsd; }
    if (r.outcome === "unhedged" || r.outcome === "indeterminate") {
      stopAuto(`cycle ended ${r.outcome} — manual attention required: ${r.reason}`);
    }
  } finally {
    autoTickRunning = false;
  }
}

router.post("/arb/mm-auto/start", async (req, res): Promise<void> => {
  const parsed = MmAutoStartBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  if (liveNeedsReconcile) { res.status(409).json({ error: `live runs locked pending manual reconciliation: ${liveNeedsReconcile}` }); return; }
  if (autoState.running) { res.status(409).json({ error: "AUTO mode is already running" }); return; }
  try { await detectFees(b); }
  catch (e) { res.status(502).json({ error: `refusing to start AUTO without REAL fee tiers: ${(e as Error).message}` }); return; }
  autoCreds = { krakenKey: b.krakenKey, krakenSecret: b.krakenSecret, coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret };
  autoState.running = true;
  autoState.startedAt = new Date().toISOString();
  autoState.stopReason = null;
  autoState.ticks = 0; autoState.fires = 0;
  autoState.config = {
    minNetUsd: floorFor(b.minNetUsd),
    bufferUsd: bufferFor(SIZE_USD_CAP, b.bufferUsd ?? undefined),
    restWindowSec: Math.min(MAX_REST_WINDOW_SEC, Math.max(5, b.restWindowSec ?? DEFAULT_REST_WINDOW_SEC)),
  };
  const log = req.log;
  autoTimer = setInterval(() => { void autoTick(log).catch(e => { autoLog("error", (e as Error).message); }); }, AUTO_TICK_MS);
  autoLog("start", `AUTO watching ${MM_ASSETS.length} assets, floor $${autoState.config.minNetUsd.toFixed(2)} + buffer $${autoState.config.bufferUsd.toFixed(2)}, $${SIZE_USD_CAP} size`);
  res.json({ ok: true, startedAt: autoState.startedAt, config: autoState.config });
});

router.post("/arb/mm-auto/stop", (_req, res) => {
  if (!autoState.running) { res.json({ ok: true, alreadyStopped: true, stopReason: autoState.stopReason }); return; }
  stopAuto("stopped by user");
  res.json({ ok: true });
});

router.get("/arb/mm-auto/status", (_req, res) => {
  res.json({
    running: autoState.running,
    startedAt: autoState.startedAt,
    lastTickAt: autoState.lastTickAt,
    ticks: autoState.ticks, fires: autoState.fires,
    completed: autoState.completed, realizedUsd: autoState.realizedUsd,
    stopReason: autoState.stopReason,
    config: autoState.config,
    sizeUsd: SIZE_USD_CAP,
    reconcileLatch: liveNeedsReconcile,
    lastBest: autoState.lastBest,
    lastOutcome: autoState.lastOutcome,
    events: autoState.events,
  });
});

// ── GET /arb/cb-mm-stats ─────────────────────────────────────────────────────
router.get("/arb/cb-mm-stats", async (_req, res) => {
  const strategyFilter = sql`${tradesTable.pair} LIKE 'MM2:%' AND ${tradesTable.isDryRun} = false`;
  const [agg] = await db.select({
    trades: sql<number>`count(*)::int`,
    completed: sql<number>`count(${tradesTable.realizedProfitUsd})::int`,
    realizedTotal: sql<string>`coalesce(sum(${tradesTable.realizedProfitUsd}::numeric), 0)::text`,
  }).from(tradesTable).where(strategyFilter);
  const recent = await db.select({
    pair: tradesTable.pair, realized: tradesTable.realizedProfitUsd,
    status: tradesTable.status, createdAt: tradesTable.createdAt,
  }).from(tradesTable).where(strategyFilter)
    .orderBy(sql`${tradesTable.createdAt} DESC`).limit(20);
  res.json({
    trades: agg?.trades ?? 0, completed: agg?.completed ?? 0,
    incomplete: (agg?.trades ?? 0) - (agg?.completed ?? 0),
    cumulativeRealizedUsd: parseFloat(agg?.realizedTotal ?? "0"),
    recent: recent.map(r => ({ pair: r.pair, realizedUsd: r.realized != null ? parseFloat(r.realized) : null, status: r.status, at: r.createdAt })),
  });
});

export default router;
