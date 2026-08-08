/**
 * CB-MAKER / KRAKEN-HEDGE — the inverted maker-hedge strategy.
 *
 * WHY: the live-fill audit proved this account pays ~1.20% taker on Coinbase
 * but only ~0.60% maker there and ~0.40% taker on Kraken. Posting the maker
 * leg on Coinbase and hedging taker on Kraken cuts the total fee stack from
 * ~1.60% (taker-taker) to ~1.00% AND earns the spread on the maker side.
 *
 * Flow (POST /arb/cb-mm-execute), one attempt, $10 hard cap:
 *  1. REAL fees only: Coinbase maker % + Kraken taker % detected from the
 *     account, or the run is refused. Never guesses.
 *  2. Projects both directions on live books (depth-walked Kraken hedge);
 *     picks the best; refuses unless projected net ≥ floor + safety buffer.
 *     Floor never below the maker-floor safeguard max($0.25, 2.5%·size).
 *  3. Inventory precheck for BOTH legs before any order.
 *  4. Posts a POST-ONLY limit on Coinbase joining the top of our side —
 *     post_only guarantees it can never take liquidity.
 *  5. While resting (≤ restWindowSec): re-projects the hedge for the resting
 *     price/remaining qty every tick; if it drops below floor + buffer, the
 *     maker order is CANCELLED (confirmed) — no hedge is ever opened for an
 *     unfilled order.
 *  6. Only after a CONFIRMED fill (full, or partial at terminal cancel) does
 *     the hedge fire on Kraken: bounded IOC limit (never unlimited market),
 *     exactly the confirmed quantity. Partial hedge ⇒ outcome "unhedged",
 *     realized P&L stays null — never counted as profit.
 *  7. Every ambiguity (unconfirmed submit/cancel, non-terminal order) latches
 *     live runs off until manually reconciled. Shared live-execution lock
 *     prevents double-fire with every other executor.
 *
 * Ledger prefix "MM2:". GET /arb/cb-mm-stats aggregates the FULL history.
 */
import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ExecuteCbMmBody } from "@workspace/api-zod";
import { projectCbMakerHedge, type MmProjection, type MmDirection } from "../lib/cross-mm";
import { OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
import {
  getKrakenBalances,
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
} from "../lib/exchange";
import { tryAcquireSharedLiveLock, releaseLiveLock, touchLiveLock, liveLockOwned } from "./arb";

const router: IRouter = Router();

const MM_ASSETS: ObAsset[] = ["ETH", "BTC", "SOL"];
const POLL_MS = 700;
const TERMINAL_WAIT_MS = 25_000;
const DEFAULT_REST_WINDOW_SEC = 30;
const MAX_REST_WINDOW_SEC = 120;
const DEFAULT_MAX_QUOTE_AGE_MS = 500;
// Maker-floor safeguard (audit-proven): thin maker fills lose money once the
// hedge moves. The floor can be raised by the caller but NEVER lowered below
// this. Applied on top of the safety buffer.
const makerFloorUsd = (sizeUsd: number) => Math.max(0.25, sizeUsd * 0.025);
const bufferFor = (sizeUsd: number, override?: number) =>
  override != null && override >= 0 ? override : Math.max(0.02, sizeUsd * 0.002);

function isExplicitKrakenReject(msg: string): boolean {
  return /EOrder:|EGeneral:Invalid|EAPI:Invalid|EFunding:|ETrade:/.test(msg);
}

let execInFlight = false;
let liveNeedsReconcile: string | null = null;

async function ledgerRow(o: {
  asset: string; direction: MmDirection; note: string; volume: number;
  makerPx: number; hedgePx: number; makerId: string | null; hedgeId: string | null;
  status: string; realized: number | null; expected: number;
}, log: { error: (x: object, m: string) => void }): Promise<void> {
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

// ── POST /arb/cb-mm-execute ──────────────────────────────────────────────────
router.post("/arb/cb-mm-execute", async (req, res): Promise<void> => {
  const parsed = ExecuteCbMmBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  const asset = b.asset as ObAsset;
  if (!MM_ASSETS.includes(asset)) { res.status(400).json({ error: `asset must be one of ${MM_ASSETS.join(", ")}` }); return; }
  const sizeUsd = Math.min(10, Math.max(1, b.sizeUsd ?? 10)); // HARD $10 cap — no auto-scaling
  // Floor: caller may RAISE it, never lower it below the maker-floor safeguard.
  const minNetUsd = Math.max(makerFloorUsd(sizeUsd), b.minNetUsd ?? 0);
  const bufferUsd = bufferFor(sizeUsd, b.bufferUsd ?? undefined);
  const maxQuoteAgeMs = b.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const restWindowSec = Math.min(MAX_REST_WINDOW_SEC, Math.max(5, b.restWindowSec ?? DEFAULT_REST_WINDOW_SEC));
  const startedAt = new Date().toISOString();
  const kCreds = { krakenKey: b.krakenKey, krakenSecret: b.krakenSecret };
  const cbCreds = { coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret };
  const kPairRaw = OB_USD_PAIRS[asset];
  const cbPair = `${asset}/USD` as "ETH/USD" | "BTC/USD" | "SOL/USD";

  const respond = (outcome: string, reason: string, extra?: object) => {
    req.log.info({ asset, outcome, reason }, "[MM2]");
    res.json({ outcome, reason, asset, startedAt, finishedAt: new Date().toISOString(), makerLeg: null, hedgeLeg: null, realizedProfitUsd: null, projection: null, ...extra });
  };

  if (!b.krakenKey || !b.krakenSecret || !b.coinbaseKey || !b.coinbaseSecret) { respond("skipped", "missing API credentials"); return; }
  if (liveNeedsReconcile) { respond("skipped", `live runs locked pending manual reconciliation: ${liveNeedsReconcile}. Verify on the exchanges, then restart the server.`); return; }
  if (execInFlight) { respond("skipped", "an execution is already in flight"); return; }
  execInFlight = true;
  let lockGen: number | null = null;
  try {
    // 1. REAL fees on both venues — refuse to guess.
    let cbMakerPct: number, kTakerPct: number;
    try {
      const [kTier, cbTier] = await Promise.all([krakenFeeTiers(kCreds, [kPairRaw]), getCoinbaseFeeTier(cbCreds)]);
      if (!kTier) throw new Error("Kraken fee tier unavailable");
      kTakerPct = kTier.takerFeePct; cbMakerPct = cbTier.makerFeePct;
    } catch (e) {
      respond("skipped", `could not detect REAL fee tiers (never guessing for live): ${(e as Error).message}`); return;
    }

    // 2. Best direction on CURRENT books with REAL fees.
    const projBuy = projectCbMakerHedge(asset, "buy", sizeUsd, cbMakerPct, kTakerPct);
    const projSell = projectCbMakerHedge(asset, "sell", sizeUsd, cbMakerPct, kTakerPct);
    const requested = b.direction as MmDirection | undefined;
    const candidates = (requested ? [requested === "buy" ? projBuy : projSell] : [projBuy, projSell]).filter((p): p is MmProjection => p != null);
    if (!candidates.length) { respond("skipped", "no live depth books on one/both venues (or depth cannot absorb the hedge)"); return; }
    const proj = candidates.reduce((a, c) => (c.projectedNetUsd > a.projectedNetUsd ? c : a));
    const projInfo = { direction: proj.direction, makerPrice: proj.makerPrice, makerQty: proj.makerQty, projectedNetUsd: proj.projectedNetUsd, makerFeeUsd: proj.makerFeeUsd, hedgeFeeUsd: proj.hedgeFeeUsd, hedgeVwapPx: proj.hedgeVwapPx, hedgeSlippageUsd: proj.hedgeSlippageUsd, quoteAgeMs: proj.quoteAgeMs, cbMakerPct, kTakerPct, minNetUsd, bufferUsd };
    if (proj.quoteAgeMs > maxQuoteAgeMs) { respond("skipped", `books stale: oldest leg ${proj.quoteAgeMs}ms > ${maxQuoteAgeMs}ms`, { projection: projInfo }); return; }
    if (proj.projectedNetUsd < minNetUsd + bufferUsd) {
      respond("skipped", `projected net $${proj.projectedNetUsd.toFixed(4)} below floor $${minNetUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)} (maker-floor safeguard active)`, { projection: projInfo }); return;
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
      const kCodes = asset === "BTC" ? ["XXBT", "XBT", "BTC"] : [`X${asset}`, asset];
      kAsset = kBals.filter(x => kCodes.includes(x.currency)).reduce((a, x) => a + x.amount, 0);
      cbUsd = cbUsdDetail.available; cbAsset = cbAssetDetail.available;
    } catch (e) { respond("skipped", `balance check failed: ${(e as Error).message}`); return; }
    if (direction === "buy") {
      if (cbUsd < sizeUsd * 1.02) { respond("skipped", `insufficient Coinbase USD for the maker buy: need ~$${(sizeUsd * 1.02).toFixed(2)}, have $${cbUsd.toFixed(2)}`, { projection: projInfo }); return; }
      if (kAsset < proj.makerQty * 1.02) { respond("skipped", `insufficient pre-positioned Kraken ${asset} for the hedge sell: need ~${(proj.makerQty * 1.02).toFixed(8)}, have ${kAsset.toFixed(8)}`, { projection: projInfo }); return; }
    } else {
      if (cbAsset < proj.makerQty * 1.02) { respond("skipped", `insufficient TRADABLE Coinbase ${asset} for the maker sell (staked/held balances don't count): need ~${(proj.makerQty * 1.02).toFixed(8)}, have ${cbAsset.toFixed(8)}`, { projection: projInfo }); return; }
      if (kUsd < sizeUsd * 1.02) { respond("skipped", `insufficient Kraken USD for the hedge buy: need ~$${(sizeUsd * 1.02).toFixed(2)}, have $${kUsd.toFixed(2)}`, { projection: projInfo }); return; }
    }

    // 3.5 Coinbase increments are MANDATORY — never guess precision.
    let cbIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>>;
    try { cbIncs = await getCoinbaseProductIncrements(cbPair); }
    catch (e) { respond("skipped", `Coinbase product increments unavailable — refusing to guess order precision: ${(e as Error).message}`, { projection: projInfo }); return; }
    const qBase = (v: number) => quantizeDown(v, cbIncs.baseIncrement).value;
    const baseTol = 2 * parseFloat(cbIncs.baseIncrement);

    // 4. Shared live lock — same lock every other executor gates on.
    lockGen = tryAcquireSharedLiveLock();
    if (lockGen == null) { respond("skipped", "another live executor holds the execution lock", { projection: projInfo }); return; }

    // 5. POST-ONLY maker on Coinbase, joining the top of our side.
    const t0 = Date.now();
    const makerQty = qBase(proj.makerQty);
    if (makerQty <= 0) { respond("skipped", "maker quantity quantized to zero", { projection: projInfo }); return; }
    let makerId: string | null = null;
    try {
      const r = await coinbaseLimitOrder(cbCreds, direction === "buy" ? "BUY" : "SELL", makerQty, proj.makerPrice, cbPair, cbIncs);
      if (r.success === false) { respond("post_rejected", "Coinbase rejected the post-only order (would have crossed) — nothing traded", { projection: projInfo }); return; }
      makerId = r.orderId ?? null;
      if (!makerId) throw new Error("Coinbase returned no order id");
    } catch (e) {
      // Post-submit ambiguity: the maker order MAY exist. Latch.
      liveNeedsReconcile = `Coinbase MAKER ${direction} (id unknown) unconfirmed: ${(e as Error).message}`;
      await ledgerRow({ asset, direction, note: `indeterminate: maker submit unconfirmed`, volume: 0, makerPx: proj.makerPrice, hedgePx: 0, makerId: null, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, req.log);
      respond("indeterminate", `Coinbase maker order UNCONFIRMED (${(e as Error).message}) — check Coinbase open orders before trading again. Live runs locked.`, { projection: projInfo });
      return;
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
        await ledgerRow({ asset, direction, note: "indeterminate: cancel unconfirmed", volume: 0, makerPx: proj.makerPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, req.log);
        respond("indeterminate", `cancel of maker order ${makerId} unconfirmed (${(e as Error).message}) — the order may still be live on Coinbase. Live runs locked.`, { projection: projInfo });
        return;
      }
      req.log.info({ makerId, why }, "[MM2] maker cancelled");
    }

    const filledQty = det.filledSize;
    const makerNotional = det.filledValue;
    const makerFeeUsd = det.totalFees;
    const makerLeg = { venue: "coinbase", side: direction, orderId: makerId, status: det.status, filledQty, avgPrice: det.avgPrice || null, notionalUsd: makerNotional || null, feeUsd: makerFeeUsd, latencyMs: Date.now() - t0 };

    // 7. No fill → clean exit, no hedge ever opened. ANY confirmed positive
    // fill — even dust — goes to the hedge path: deliberately ignoring a
    // small real fill would leave silent unhedged exposure.
    if (filledQty <= 0) {
      respond("no_fill", `maker order ended ${det.status} with no fill${cancelReason ? ` (cancelled: ${cancelReason})` : ""} — nothing traded, no hedge opened`, { makerLeg, projection: projInfo });
      return;
    }

    // 8. CONFIRMED fill → hedge EXACTLY the filled quantity on Kraken now.
    // Bounded IOC (0.5% collar), never an unbounded market order. Closing the
    // exposure takes priority; if the fresh hedge is now below floor we still
    // hedge (holding an unhedged position is strictly worse) and the realized
    // number tells the truth.
    if (!liveLockOwned(lockGen)) {
      liveNeedsReconcile = `Coinbase maker ${makerId} filled ${filledQty.toFixed(8)} ${asset} but execution was killed before the hedge`;
      await ledgerRow({ asset, direction, note: "unhedged: lock evicted before hedge", volume: filledQty, makerPx: det.avgPrice, hedgePx: 0, makerId, hedgeId: null, status: "unhedged", realized: null, expected: proj.projectedNetUsd }, req.log);
      respond("unhedged", liveNeedsReconcile, { makerLeg, projection: projInfo });
      return;
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
      } catch (e) { req.log.error({ err: e, hedgeTxid }, "[MM2] hedge cancel attempt failed"); }
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
    }, req.log);
    req.log.info({ asset, direction, outcome, realized, filledQty, hedgedQty }, "[MM2] finished");
    res.json({
      outcome,
      reason: outcome === "completed"
        ? `maker filled ${filledQty.toFixed(8)} @ ${det.avgPrice}, hedged fully — realized $${realized!.toFixed(4)}`
        : `maker filled ${filledQty.toFixed(8)} but hedge ${hedgeLeg.status}${hedgeError ? `: ${hedgeError}` : ""} — residual ${residual.toFixed(8)} ${asset} exposure${liveNeedsReconcile ? "; live runs locked pending reconciliation" : ""}`,
      asset, startedAt, finishedAt: new Date().toISOString(),
      makerLeg, hedgeLeg, realizedProfitUsd: realized, projection: projInfo,
    });
  } catch (err) {
    respond("skipped", (err as Error).message);
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
    execInFlight = false;
  }
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
