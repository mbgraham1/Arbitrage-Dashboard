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
import { projectCbMakerHedge, projectMakerHedge, projectTakerTaker, type MmProjection, type MmDirection } from "../lib/cross-mm";
import { OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
import {
  getKrakenBalances,
  getCoinbaseBalances,
  getCoinbaseAssetDetail,
  getCoinbaseFeeTier,
  krakenFeeTiers,
  krakenIocLimitOrder,
  krakenOrderInfo,
  coinbaseLimitOrder,
  coinbaseCancelOrder,
  krakenCancelOrder,
  coinbaseOrderDetails,
  getCoinbaseProductIncrements,
  quantizeDown,
  type Pair,
} from "../lib/exchange";
import { tryAcquireSharedLiveLock, releaseLiveLock, touchLiveLock, liveLockOwned } from "./arb";

const router: IRouter = Router();

/** Liquid spot assets available on BOTH venues' order paths with live books. */
const MM_ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "LINK", "DOGE", "AVAX", "LTC",
  "ADA", "DOT", "UNI", "AAVE", "ATOM", "BCH", "FIL",
] as const satisfies readonly ObAsset[];
type MmAsset = typeof MM_ASSETS[number];
const cbPairOf = (a: MmAsset): Pair => `${a}/USD` as Pair;

const POLL_MS = 700;
const TERMINAL_WAIT_MS = 25_000;
const DEFAULT_REST_WINDOW_SEC = 30;
const MAX_REST_WINDOW_SEC = 120;
const DEFAULT_MAX_QUOTE_AGE_MS = 500;
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
export type Fees = { cbMakerPct: number; cbTakerPct: number; kTakerPct: number; kMakerPct: number | null; detectedAt: number };
const feeCache = new Map<string, Fees>();
export type Balances = { kUsd: number; cbUsd: number; kAssets: Map<string, number>; cbAssets: Map<string, number>; fetchedAt: number };
const balCache = new Map<string, Balances>();
const credKey = (c: Creds) => `${c.krakenKey}:${c.coinbaseKey}`;

export async function detectFees(creds: Creds): Promise<Fees> {
  const k = credKey(creds);
  const hit = feeCache.get(k);
  if (hit && Date.now() - hit.detectedAt < FEE_CACHE_MS) return hit;
  const [kTier, cbTier] = await Promise.all([
    krakenFeeTiers(creds, [OB_USD_PAIRS.ETH, OB_USD_PAIRS.BTC]),
    getCoinbaseFeeTier(creds),
  ]);
  if (!kTier) throw new Error("Kraken fee tier unavailable");
  const f: Fees = { cbMakerPct: cbTier.makerFeePct, cbTakerPct: cbTier.takerFeePct, kTakerPct: kTier.takerFeePct, kMakerPct: kTier.makerFeePct, detectedAt: Date.now() };
  feeCache.set(k, f);
  return f;
}

export function krakenCodesFor(asset: string): string[] {
  if (asset === "BTC") return ["XXBT", "XBT", "BTC"];
  if (asset === "DOGE") return ["XXDG", "XDG", "DOGE"];
  return [`X${asset}`, asset];
}

export async function fetchBalances(creds: Creds): Promise<Balances> {
  const k = credKey(creds);
  const hit = balCache.get(k);
  if (hit && Date.now() - hit.fetchedAt < BAL_CACHE_MS) return hit;
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

// ── Scan: all assets × both directions × both structures ────────────────────
type MmStructure = "cbMaker" | "kMaker" | "takerKtoC" | "takerCtoK";
type ScanRow = {
  asset: MmAsset; structure: MmStructure; direction: MmDirection;
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
          rows.push({ asset, structure: s, direction, available: false, makerVenue, hedgeVenue, makerFeePct: makerPct, hedgeFeePct: hedgePct, grossEdgeUsd: null, projectedNetUsd: null, inventoryReady: false, inventoryReason: "no projection", requiredBalances: requiredBalancesText(s, direction, asset, 0, SIZE_USD_CAP), verdict: "WAIT", fire: "SKIP", reason: makerPct == null ? "maker fee tier not detected for this venue" : "no live books or hedge depth insufficient", autoExecutable: false });
          continue;
        }
        const inv = inventoryFor(s, direction, asset, p.makerQty, SIZE_USD_CAP, bal);
        const stale = p.quoteAgeMs > maxQuoteAgeMs;
        const clears = p.projectedNetUsd >= required;
        const run = clears && !stale && inv.ready;
        // Gross edge before any cost = net + all costs added back.
        const grossEdgeUsd = p.projectedNetUsd + p.makerFeeUsd + p.hedgeFeeUsd + p.hedgeSlippageUsd;
        rows.push({
          asset, structure: s, direction, available: true, makerVenue, hedgeVenue,
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
        rows.push({ asset, structure: ts, direction: "buy", available: false, makerVenue, hedgeVenue, makerFeePct: buyFee, hedgeFeePct: sellFee, grossEdgeUsd: null, projectedNetUsd: null, inventoryReady: false, inventoryReason: "no projection", requiredBalances: requiredBalancesText(ts, "buy", asset, 0, SIZE_USD_CAP), verdict: "WAIT", fire: "SKIP", reason: "no live books or depth insufficient", autoExecutable: false });
        continue;
      }
      const inv = inventoryFor(ts, "buy", asset, tp.qty, SIZE_USD_CAP, bal);
      const stale = tp.quoteAgeMs > maxQuoteAgeMs;
      const clears = tp.projectedNetUsd >= required;
      const run = clears && !stale && inv.ready;
      rows.push({
        asset, structure: ts, direction: "buy", available: true, makerVenue, hedgeVenue,
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
    if (proj.quoteAgeMs > maxQuoteAgeMs) return finish("skipped", `books stale: oldest leg ${proj.quoteAgeMs}ms > ${maxQuoteAgeMs}ms`, { projection: projInfo });
    if (proj.projectedNetUsd < minNetUsd + bufferUsd) {
      return finish("skipped", `projected net $${proj.projectedNetUsd.toFixed(4)} below floor $${minNetUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}`, { projection: projInfo });
    }
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

// ── POST /arb/cb-mm-execute ──────────────────────────────────────────────────
router.post("/arb/cb-mm-execute", async (req, res): Promise<void> => {
  const parsed = ExecuteCbMmBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  if (!(MM_ASSETS as readonly string[]).includes(b.asset)) { res.status(400).json({ error: `asset must be one of ${MM_ASSETS.join(", ")}` }); return; }
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
  res.json({
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
