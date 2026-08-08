/**
 * TWO-EXCHANGE SCANNER/EXECUTOR — profitability-gated Kraken↔Coinbase
 * inventory arbitrage for a small set of liquid assets (ETH, BTC, SOL).
 *
 * Scan (GET /arb/2x-scan): prices BOTH directions per asset with
 * crossTakerBreakdown — live stream books on both venues, depth-walked VWAP
 * for the intended size, per-venue taker fees on notional, slippage vs
 * top-of-book, per-leg quote ages. Each route gets an explicit FIRE/SKIP
 * decision with the exact reason (stale books, no depth, fees exceed edge,
 * below floor+buffer, …). The scan NEVER trades.
 *
 * Execute (POST /arb/2x-execute): one cycle, $10 hard cap, and only when the
 * route re-projected on CURRENT books clears minNet + safety buffer using
 * REAL detected fee tiers on both venues (refuses to guess fees). Takes the
 * SAME shared live-execution lock as every other executor (no double-fire).
 * Legs run as close together as safely possible: first leg placed and
 * CONFIRMED (actual fill qty is the only truth), second leg fires
 * immediately for exactly the confirmed quantity against pre-positioned
 * inventory. Post-submit ambiguity latches live runs off. "completed"
 * requires a full terminal second-leg fill; realized P&L only then.
 *
 * Ledger prefix "2X:". Stats (GET /arb/2x-stats) aggregate realized P&L for
 * this strategy (2X: and 2XTEST: rows) — the ONLY evidence of profitability.
 */
import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { Execute2xBody, Detect2xFeesBody } from "@workspace/api-zod";
import { crossTakerBreakdown, type CrossBreakdown } from "../lib/cross-pricing";
import { OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
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
  quantizeDown, type Pair } from "../lib/exchange";
import { tryAcquireSharedLiveLock, releaseLiveLock, touchLiveLock, liveLockOwned } from "./arb";

const router: IRouter = Router();

// Full shared Kraken∩Coinbase liquid universe (same list the hunter tracks) —
// every asset here has verified order routing on both venues via PAIRS.
const SCAN_ASSETS: ObAsset[] = ["ETH", "BTC", "SOL", "XRP", "LINK", "DOGE", "AVAX", "LTC", "ADA", "DOT", "UNI", "AAVE", "ATOM", "BCH", "FIL"];
const POLL_MS = 600;
const TERMINAL_WAIT_MS = 25_000;
const DEFAULT_MIN_NET_USD = 0.01;     // profit floor AFTER all costs
const DEFAULT_MAX_QUOTE_AGE_MS = 200; // unified hard freshness rule: any leg older than 200ms → route stale, no execution
// Safety buffer: protects against book movement between projection and fills.
const bufferFor = (sizeUsd: number, override?: number) =>
  override != null && override >= 0 ? override : Math.max(0.02, sizeUsd * 0.002);

// Assumed fees for CREDENTIAL-LESS scanning only (labelled in the response).
// Live execution NEVER uses these — it detects real tiers or refuses.
const ASSUMED_KRAKEN_TAKER_PCT = 0.4;
const ASSUMED_COINBASE_TAKER_PCT = 1.2; // conservative entry tier — matches discovery; never optimistic

type Decision = {
  asset: ObAsset;
  buyVenue: "kraken" | "coinbase";
  direction: string;
  decision: "FIRE" | "SKIP";
  reason: string;
  grossSpreadUsd: number | null;
  feesUsd: number | null;
  slippageUsd: number | null;
  bufferUsd: number;
  netProfitUsd: number | null;
  baseQty: number | null;
  quoteAgeMs: number | null;
  legs: CrossBreakdown["legDiag"] | null;
};

function decide(
  asset: ObAsset,
  buyVenue: "kraken" | "coinbase",
  sizeUsd: number,
  kFeePct: number,
  cbFeePct: number,
  minNetUsd: number,
  bufferUsd: number,
  maxQuoteAgeMs: number,
): Decision {
  const direction = buyVenue === "coinbase" ? "Coinbase buy → Kraken sell" : "Kraken buy → Coinbase sell";
  const base = { asset, buyVenue, direction, bufferUsd };
  const bd = crossTakerBreakdown(asset, buyVenue, sizeUsd, kFeePct, cbFeePct);
  if (!bd) {
    return { ...base, decision: "SKIP", reason: "no live depth book on one/both venues (or depth cannot absorb the size)", grossSpreadUsd: null, feesUsd: null, slippageUsd: null, netProfitUsd: null, baseQty: null, quoteAgeMs: null, legs: null };
  }
  const common = {
    grossSpreadUsd: bd.rawEdgeUsd, feesUsd: bd.feesUsd, slippageUsd: bd.slippageUsd,
    netProfitUsd: bd.netProfitUsd, netAfterBufferUsd: bd.netProfitUsd - bufferUsd, baseQty: bd.baseQty, quoteAgeMs: bd.quoteAgeMs, legs: bd.legDiag,
  };
  if (bd.quoteAgeMs > maxQuoteAgeMs) {
    return { ...base, ...common, decision: "SKIP", reason: `books stale: oldest leg ${bd.quoteAgeMs}ms > ${maxQuoteAgeMs}ms limit` };
  }
  if (bd.netProfitUsd <= 0) {
    const why = bd.rawEdgeUsd <= 0 ? "no gross spread in this direction" : `fees+slippage ($${(bd.feesUsd + bd.slippageUsd).toFixed(4)}) exceed gross spread ($${bd.rawEdgeUsd.toFixed(4)})`;
    return { ...base, ...common, decision: "SKIP", reason: `net negative after costs: ${why}` };
  }
  if (bd.netProfitUsd < minNetUsd + bufferUsd) {
    return { ...base, ...common, decision: "SKIP", reason: `net $${bd.netProfitUsd.toFixed(4)} below floor $${minNetUsd.toFixed(2)} + buffer $${bufferUsd.toFixed(2)}` };
  }
  return { ...base, ...common, decision: "FIRE", reason: `net $${bd.netProfitUsd.toFixed(4)} clears floor + buffer` };
}

// ── GET /arb/2x-scan ─────────────────────────────────────────────────────────
router.get("/arb/2x-scan", (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const sizeUsd = Math.min(10, Math.max(1, parseFloat(q.sizeUsd ?? "") || 10));
  const kFeePct = parseFloat(q.krakenFeePct ?? "") || ASSUMED_KRAKEN_TAKER_PCT;
  const cbFeePct = parseFloat(q.coinbaseFeePct ?? "") || ASSUMED_COINBASE_TAKER_PCT;
  const minNetUsd = parseFloat(q.minNetUsd ?? "") || DEFAULT_MIN_NET_USD;
  const maxQuoteAgeMs = parseFloat(q.maxQuoteAgeMs ?? "") || DEFAULT_MAX_QUOTE_AGE_MS;
  const bufferUsd = bufferFor(sizeUsd, q.bufferUsd != null ? parseFloat(q.bufferUsd) : undefined);
  const feesAssumed = !q.krakenFeePct || !q.coinbaseFeePct;

  const routes: Decision[] = [];
  for (const asset of SCAN_ASSETS) {
    for (const buyVenue of ["coinbase", "kraken"] as const) {
      routes.push(decide(asset, buyVenue, sizeUsd, kFeePct, cbFeePct, minNetUsd, bufferUsd, maxQuoteAgeMs));
    }
  }
  const priced = routes.filter(r => r.netProfitUsd != null);
  const best = priced.length ? priced.reduce((a, b) => (b.netProfitUsd! > a.netProfitUsd! ? b : a)) : null;
  res.json({
    scannedAt: new Date().toISOString(),
    params: { sizeUsd, krakenFeePct: kFeePct, coinbaseFeePct: cbFeePct, minNetUsd, bufferUsd, maxQuoteAgeMs, feesAssumed },
    best, routes,
  });
});

// ── POST /arb/2x-fees ────────────────────────────────────────────────────────
// Detects the account's REAL fee tiers on both venues so the scanner DISPLAY
// uses the same fee inputs as the executor and the realized P&L. Refuses to
// guess: any failure is an explicit error, never a silent fallback.
router.post("/arb/2x-fees", async (req, res): Promise<void> => {
  const parsed = Detect2xFeesBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  try {
    const [kTier, cbTier] = await Promise.all([
      krakenFeeTiers({ krakenKey: b.krakenKey, krakenSecret: b.krakenSecret }, SCAN_ASSETS.map(a => OB_USD_PAIRS[a])),
      getCoinbaseFeeTier({ coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret }),
    ]);
    if (!kTier) throw new Error("Kraken fee tier unavailable");
    res.json({
      detected: true,
      krakenTakerPct: kTier.takerFeePct, krakenMakerPct: kTier.makerFeePct,
      coinbaseTakerPct: cbTier.takerFeePct, coinbaseMakerPct: cbTier.makerFeePct,
      detectedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: `fee tier detection failed: ${(e as Error).message}` });
  }
});

// ── GET /arb/2x-stats ────────────────────────────────────────────────────────
router.get("/arb/2x-stats", async (_req, res) => {
  const strategyFilter = sql`(${tradesTable.pair} LIKE '2X:%' OR ${tradesTable.pair} LIKE '2XTEST:%') AND ${tradesTable.isDryRun} = false`;
  // FULL-history aggregates — a row limit here would silently falsify the
  // cumulative track record once enough trades exist.
  const [agg] = await db.select({
    trades: sql<number>`count(*)::int`,
    completed: sql<number>`count(${tradesTable.realizedProfitUsd})::int`,
    realizedTotal: sql<string>`coalesce(sum(${tradesTable.realizedProfitUsd}::numeric), 0)::text`,
  }).from(tradesTable).where(strategyFilter);
  const recent = await db.select({
    pair: tradesTable.pair,
    realized: tradesTable.realizedProfitUsd,
    status: tradesTable.status,
    createdAt: tradesTable.createdAt,
  }).from(tradesTable).where(strategyFilter)
    .orderBy(sql`${tradesTable.createdAt} DESC`)
    .limit(20);
  res.json({
    trades: agg?.trades ?? 0, completed: agg?.completed ?? 0,
    incomplete: (agg?.trades ?? 0) - (agg?.completed ?? 0),
    cumulativeRealizedUsd: parseFloat(agg?.realizedTotal ?? "0"),
    recent: recent.map(r => ({ pair: r.pair, realizedUsd: r.realized != null ? parseFloat(r.realized) : null, status: r.status, at: r.createdAt })),
  });
});

// ── POST /arb/2x-execute ─────────────────────────────────────────────────────
let execInFlight = false;
let liveNeedsReconcile: string | null = null;

function dirTagFor(buyVenue: "kraken" | "coinbase"): string {
  return buyVenue === "coinbase" ? "CB-buy→K-sell" : "K-buy→CB-sell";
}

/** True only for Kraken's EXPLICIT API-level rejections (the exchange
 *  answered and refused — order definitively does not exist). Anything else
 *  (timeout, network, parse) is ambiguous: the order MAY have been accepted. */
function isExplicitKrakenReject(msg: string): boolean {
  return /EOrder:|EGeneral:Invalid|EAPI:Invalid|EFunding:|ETrade:/.test(msg);
}

/** Auditable ledger row for an execution whose outcome is unknown. */
async function ledgerIndeterminate(asset: string, dirTag: string, note: string, buyId: string | null, log: { error: (o: object, m: string) => void }): Promise<void> {
  try {
    await db.insert(tradesTable).values({
      pair: `2X:${asset} ${dirTag} [indeterminate: ${note.slice(0, 120)}]`,
      buyExchange: "-", sellExchange: "-", volume: "0",
      estimatedProfitUsd: "0", netEdgePct: "0", isDryRun: false,
      krakenPrice: "0", coinbasePrice: "0",
      buyOrderId: buyId, sellOrderId: null,
      status: "unhedged", realizedProfitUsd: null,
    });
  } catch (e) { log.error({ err: e }, "[2X] indeterminate ledger write failed"); }
}

router.post("/arb/2x-execute", async (req, res): Promise<void> => {
  const parsed = Execute2xBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  const asset = b.asset as ObAsset;
  if (!SCAN_ASSETS.includes(asset)) { res.status(400).json({ error: `asset must be one of ${SCAN_ASSETS.join(", ")}` }); return; }
  const buyVenue = b.buyVenue as "kraken" | "coinbase";
  const sizeUsd = Math.min(10, Math.max(1, b.sizeUsd ?? 10)); // HARD $10 cap until realized track record is positive
  const minNetUsd = b.minNetUsd ?? DEFAULT_MIN_NET_USD;
  const maxQuoteAgeMs = b.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
  const bufferUsd = bufferFor(sizeUsd, b.bufferUsd ?? undefined);
  const startedAt = new Date().toISOString();
  const kCreds = { krakenKey: b.krakenKey, krakenSecret: b.krakenSecret };
  const cbCreds = { coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret };
  const kPairRaw = OB_USD_PAIRS[asset];
  const cbPair = `${asset}/USD` as Pair; // every SCAN_ASSETS entry is in PAIRS

  const skip = (reason: string, extra?: object) => {
    req.log.info({ asset, buyVenue, reason }, "[2X] SKIP");
    res.json({ executed: false, outcome: "skipped", reason, asset, buyVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: null, sellLeg: null, realizedProfitUsd: null, projection: null, ...extra });
  };

  if (!b.krakenKey || !b.krakenSecret || !b.coinbaseKey || !b.coinbaseSecret) { skip("missing API credentials"); return; }
  if (liveNeedsReconcile) { skip(`live runs locked pending manual reconciliation: ${liveNeedsReconcile}. Verify on the exchange, then restart the server.`); return; }
  if (execInFlight) { skip("an execution is already in flight"); return; }
  execInFlight = true;
  let lockGen: number | null = null;
  try {
    // 1. REAL fees on both venues — refuse to guess for live gating.
    let kFeePct: number, cbFeePct: number;
    try {
      const [kTier, cbTier] = await Promise.all([krakenFeeTiers(kCreds, [kPairRaw]), getCoinbaseFeeTier(cbCreds)]);
      if (!kTier) throw new Error("Kraken fee tier unavailable");
      kFeePct = kTier.takerFeePct; cbFeePct = cbTier.takerFeePct;
    } catch (e) {
      skip(`could not detect REAL fee tiers (never guessing for live): ${(e as Error).message}`); return;
    }

    // 2. Inventory precheck on both venues BEFORE locking anything.
    const sellVenue = buyVenue === "kraken" ? "coinbase" : "kraken";
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
    } catch (e) {
      skip(`balance check failed: ${(e as Error).message}`); return;
    }
    const buyUsdAvail = buyVenue === "kraken" ? kUsd : cbUsd;
    const sellAssetAvail = sellVenue === "kraken" ? kAsset : cbAsset;
    if (buyUsdAvail < sizeUsd * 1.01) { skip(`insufficient USD on ${buyVenue}: need ~$${(sizeUsd * 1.01).toFixed(2)}, have $${buyUsdAvail.toFixed(2)}`); return; }

    // 3. Re-project on CURRENT books with REAL fees; all gates re-checked.
    const d = decide(asset, buyVenue, sizeUsd, kFeePct, cbFeePct, minNetUsd, bufferUsd, maxQuoteAgeMs);
    if (d.decision !== "FIRE") { skip(d.reason, { projection: d }); return; }
    const estQty = d.baseQty!;
    if (sellAssetAvail < estQty * 1.02) { skip(`insufficient pre-positioned ${asset} on ${sellVenue} for the sell leg: need ~${(estQty * 1.02).toFixed(8)}, tradable ${sellAssetAvail.toFixed(8)}`, { projection: d }); return; }

    // 3.5 Coinbase increment metadata is MANDATORY before any order — never
    // fall back to guessed precision on a live venue.
    let cbIncs: Awaited<ReturnType<typeof getCoinbaseProductIncrements>>;
    try {
      cbIncs = await getCoinbaseProductIncrements(cbPair);
    } catch (e) {
      skip(`Coinbase product increments unavailable — refusing to guess order precision: ${(e as Error).message}`, { projection: d }); return;
    }

    // 4. Shared live lock — same lock every other executor gates on.
    lockGen = tryAcquireSharedLiveLock();
    if (lockGen == null) { skip("another live executor holds the execution lock", { projection: d }); return; }

    // 5. Leg 1: BUY on the cheap venue. Confirmed actual fill = only truth.
    const t0 = Date.now();
    const buyPlacedAt = new Date().toISOString();
    let buyId: string | null = null;
    let buyQty = 0, buyCostUsd = 0, buyFeeUsd = 0, buyAvgPx = 0, buyStatus = "unknown";
    if (buyVenue === "kraken") {
      try {
        const r = await krakenRawMarketOrder(kCreds, "buy", estQty, kPairRaw);
        buyId = r.txid?.[0] ?? null;
        if (!buyId) throw new Error("Kraken returned no txid");
      } catch (e) {
        const msg = (e as Error).message;
        if (isExplicitKrakenReject(msg)) { skip(`Kraken buy rejected by the exchange — nothing traded: ${msg}`); return; }
        // Transport/response ambiguity AFTER submission — the order may exist.
        liveNeedsReconcile = `Kraken BUY (txid unknown) unconfirmed: ${msg}`;
        await ledgerIndeterminate(asset, "K-buy→CB-sell", `buy submit unconfirmed: ${msg}`, null, req.log);
        res.json({ executed: true, outcome: "indeterminate", reason: `Kraken buy outcome UNCONFIRMED (${msg}) — check Kraken order history before trading again. Live runs locked.`, asset, buyVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: { venue: "kraken", orderId: null, status: "unknown", filledQty: null, avgPrice: null, notionalUsd: null, feeUsd: null, latencyMs: Date.now() - t0 }, sellLeg: null, realizedProfitUsd: null, projection: d });
        return;
      }
      let info = { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
      const dl = Date.now() + TERMINAL_WAIT_MS;
      while (Date.now() < dl) {
        touchLiveLock();
        try { info = await krakenOrderInfo(kCreds, buyId); } catch { /* poll again */ }
        if (["closed", "canceled", "expired"].includes(info.status)) break;
        await new Promise(r => setTimeout(r, POLL_MS));
      }
      if (!["closed", "canceled", "expired"].includes(info.status)) {
        liveNeedsReconcile = `Kraken BUY ${buyId} not terminal after ${TERMINAL_WAIT_MS / 1000}s`;
        await ledgerIndeterminate(asset, "K-buy→CB-sell", liveNeedsReconcile, buyId, req.log);
        res.json({ executed: true, outcome: "indeterminate", reason: liveNeedsReconcile, asset, buyVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: { venue: "kraken", orderId: buyId, status: info.status, filledQty: info.volExec, avgPrice: info.price || null, notionalUsd: info.cost || null, feeUsd: info.fee || null, latencyMs: Date.now() - t0 }, sellLeg: null, realizedProfitUsd: null, projection: d });
        return;
      }
      buyQty = info.volExec || 0; buyCostUsd = info.cost || 0; buyFeeUsd = info.fee || 0; buyAvgPx = info.price || 0; buyStatus = info.status;
    } else {
      const q = (v: number) => quantizeDown(v, cbIncs.baseIncrement).value;
      try {
        const fresh = await getCoinbaseBidAsk(cbPair);
        const r = await coinbaseIocLimitOrder(cbCreds, "BUY", q(estQty), fresh.ask * 1.005, cbPair, cbIncs);
        buyId = r.orderId ?? null;
        if (!buyId) throw new Error("Coinbase returned no order id");
        let det: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
        const dl = Date.now() + TERMINAL_WAIT_MS;
        while (Date.now() < dl) {
          touchLiveLock();
          try {
            const x = await coinbaseOrderDetails(cbCreds, buyId);
            if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status)) { det = x; break; }
          } catch { /* poll again */ }
          await new Promise(r => setTimeout(r, POLL_MS));
        }
        if (!det) det = await coinbaseOrderDetails(cbCreds, buyId);
        if (!["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(det.status)) {
          liveNeedsReconcile = `Coinbase BUY ${buyId} not terminal after ${TERMINAL_WAIT_MS / 1000}s`;
          await ledgerIndeterminate(asset, "CB-buy→K-sell", liveNeedsReconcile, buyId, req.log);
          res.json({ executed: true, outcome: "indeterminate", reason: liveNeedsReconcile, asset, buyVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: { venue: "coinbase", orderId: buyId, status: det.status, filledQty: det.filledSize, avgPrice: det.avgPrice || null, notionalUsd: det.filledValue || null, feeUsd: det.totalFees, latencyMs: Date.now() - t0 }, sellLeg: null, realizedProfitUsd: null, projection: d });
          return;
        }
        buyQty = det.filledSize; buyCostUsd = det.filledValue; buyFeeUsd = det.totalFees; buyAvgPx = det.avgPrice; buyStatus = det.status;
      } catch (e) {
        // Post-submit ambiguity: order may exist. Latch; never claim untraded.
        liveNeedsReconcile = `Coinbase BUY ${buyId ?? "(id unknown)"} unconfirmed: ${(e as Error).message}`;
        await ledgerIndeterminate(asset, "CB-buy→K-sell", liveNeedsReconcile, buyId, req.log);
        res.json({ executed: true, outcome: "indeterminate", reason: liveNeedsReconcile, asset, buyVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: { venue: "coinbase", orderId: buyId, status: "unknown", filledQty: null, avgPrice: null, notionalUsd: null, feeUsd: null, latencyMs: Date.now() - t0 }, sellLeg: null, realizedProfitUsd: null, projection: d });
        return;
      }
    }
    const buyLatencyMs = Date.now() - t0;
    const buyLeg = { venue: buyVenue, orderId: buyId, status: buyStatus, filledQty: buyQty, avgPrice: buyAvgPx || null, notionalUsd: buyCostUsd || null, feeUsd: buyFeeUsd, latencyMs: buyLatencyMs };
    if (buyQty <= 1e-12) { skip(`buy leg terminal with zero fill (${buyStatus}) — nothing traded`, { projection: d, buyLeg }); return; }
    if (!liveLockOwned(lockGen)) {
      // Evicted mid-flight (KILL/HARD RESET) — do not place the sell.
      liveNeedsReconcile = `${buyVenue} BUY ${buyId} filled ${buyQty.toFixed(8)} ${asset} but execution was killed before the sell`;
      res.json({ executed: true, outcome: "unhedged", reason: liveNeedsReconcile, asset, buyVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg, sellLeg: null, realizedProfitUsd: null, projection: d });
      return;
    }

    // 6. Leg 2: SELL the CONFIRMED quantity on the other venue, immediately.
    const t1 = Date.now();
    let sellLeg: { venue: string; orderId: string | null; status: string; filledQty: number; avgPrice: number | null; notionalUsd: number | null; feeUsd: number | null; latencyMs: number };
    let sellProceedsNet: number | null = null; // (proceeds − fees) when fully sold
    let fullySold = false;
    let sellError: string | null = null;
    if (sellVenue === "kraken") {
      const KRAKEN_LOT_STEP = 1e-8;
      const target = Math.floor(Math.min(buyQty, kAsset) / KRAKEN_LOT_STEP) * KRAKEN_LOT_STEP;
      let txid: string | null = null;
      let info = { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
      try {
        const r = await krakenRawMarketOrder(kCreds, "sell", target, kPairRaw);
        txid = r.txid?.[0] ?? "";
        if (!txid) throw new Error("Kraken returned no txid");
        const dl = Date.now() + TERMINAL_WAIT_MS;
        while (Date.now() < dl) {
          touchLiveLock();
          try { info = await krakenOrderInfo(kCreds, txid); } catch { /* poll again */ }
          if (["closed", "canceled", "expired"].includes(info.status)) break;
          await new Promise(r => setTimeout(r, POLL_MS));
        }
      } catch (e) {
        sellError = (e as Error).message;
        if (!isExplicitKrakenReject(sellError)) {
          // Ambiguous submit — the sell may exist. Latch; audit.
          liveNeedsReconcile = `Kraken SELL ${txid ?? "(txid unknown)"} unconfirmed: ${sellError}`;
          await ledgerIndeterminate(asset, dirTagFor(buyVenue), liveNeedsReconcile, buyId, req.log);
        }
      }
      const indeterminate = (txid && !sellError && !["closed", "canceled", "expired"].includes(info.status)) || (!!sellError && !isExplicitKrakenReject(sellError));
      if (indeterminate && !liveNeedsReconcile) liveNeedsReconcile = `Kraken SELL ${txid} not terminal after ${TERMINAL_WAIT_MS / 1000}s`;
      fullySold = !indeterminate && info.status === "closed" && info.volExec >= target - KRAKEN_LOT_STEP && target >= buyQty - Math.max(KRAKEN_LOT_STEP, buyQty * 1e-6);
      if (fullySold) sellProceedsNet = info.cost - info.fee;
      sellLeg = { venue: "kraken", orderId: txid, status: indeterminate ? "indeterminate" : info.status, filledQty: info.volExec, avgPrice: info.price || null, notionalUsd: info.cost || null, feeUsd: info.fee || null, latencyMs: Date.now() - t1 };
    } else {
      const q = (v: number) => quantizeDown(v, cbIncs.baseIncrement).value;
      const target = q(Math.min(buyQty, cbAsset));
      const tol = 2 * parseFloat(cbIncs.baseIncrement);
      let orderId: string | null = null;
      let det: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
      try {
        const fresh = await getCoinbaseBidAsk(cbPair);
        const r = await coinbaseIocLimitOrder(cbCreds, "SELL", target, fresh.bid * 0.995, cbPair, cbIncs);
        orderId = r.orderId ?? null;
        if (!orderId) throw new Error("Coinbase returned no order id");
        const dl = Date.now() + TERMINAL_WAIT_MS;
        while (Date.now() < dl) {
          touchLiveLock();
          try {
            const x = await coinbaseOrderDetails(cbCreds, orderId);
            if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(x.status)) { det = x; break; }
          } catch { /* poll again */ }
          await new Promise(r => setTimeout(r, POLL_MS));
        }
        if (!det && orderId) det = await coinbaseOrderDetails(cbCreds, orderId);
      } catch (e) {
        sellError = (e as Error).message;
        if (orderId) liveNeedsReconcile = `Coinbase SELL ${orderId} unconfirmed: ${sellError}`;
      }
      fullySold = det?.status === "FILLED" && det.filledSize >= target - tol && target >= q(buyQty) - tol;
      if (fullySold && det) sellProceedsNet = det.filledValue - det.totalFees;
      sellLeg = { venue: "coinbase", orderId, status: det?.status ?? (sellError ? "failed" : "unknown"), filledQty: det?.filledSize ?? 0, avgPrice: det?.avgPrice || null, notionalUsd: det?.filledValue || null, feeUsd: det?.totalFees ?? null, latencyMs: Date.now() - t1 };
    }

    const realized = fullySold && sellProceedsNet != null ? sellProceedsNet - (buyCostUsd + buyFeeUsd) : null;
    const residual = Math.max(0, buyQty - sellLeg.filledQty);
    const outcome = sellLeg.status === "indeterminate" || (liveNeedsReconcile && !fullySold) ? "indeterminate"
      : fullySold ? "completed" : sellLeg.filledQty <= 1e-12 ? "sell_failed" : "partial_sell";
    const dirTag = dirTagFor(buyVenue);
    try {
      await db.insert(tradesTable).values({
        pair: `2X:${asset} ${dirTag}${outcome !== "completed" ? ` [${outcome}: residual ${residual.toFixed(8)}]` : ""}`,
        buyExchange: buyVenue, sellExchange: sellVenue,
        volume: buyQty.toFixed(8),
        estimatedProfitUsd: (d.netProfitUsd ?? 0).toFixed(6), netEdgePct: "0", isDryRun: false,
        krakenPrice: (buyVenue === "kraken" ? buyAvgPx : sellLeg.avgPrice ?? 0).toFixed(8),
        coinbasePrice: (buyVenue === "coinbase" ? buyAvgPx : sellLeg.avgPrice ?? 0).toFixed(8),
        buyOrderId: buyId, sellOrderId: sellLeg.orderId,
        status: outcome === "completed" ? "verified" : "unhedged",
        realizedProfitUsd: realized != null ? realized.toFixed(6) : null,
      });
    } catch (e) {
      req.log.error({ err: e }, "[2X] ledger write failed");
    }
    req.log.info({ asset, buyVenue, outcome, realized, expected: d.netProfitUsd, buyLatencyMs, sellLatencyMs: sellLeg.latencyMs }, "[2X] execution finished");
    res.json({
      executed: true, outcome, reason: outcome === "completed" ? `expected $${d.netProfitUsd!.toFixed(4)}, realized $${realized!.toFixed(4)}` : `sell leg ${sellLeg.status}${sellError ? `: ${sellError}` : ""} — residual ${residual.toFixed(8)} ${asset} remains long${liveNeedsReconcile ? `; live runs locked pending reconciliation` : ""}`,
      asset, buyVenue, startedAt, finishedAt: new Date().toISOString(),
      buyLeg, sellLeg, realizedProfitUsd: realized, projection: d,
    });
  } catch (err) {
    res.json({ executed: false, outcome: "skipped", reason: (err as Error).message, asset, buyVenue, startedAt, finishedAt: new Date().toISOString(), buyLeg: null, sellLeg: null, realizedProfitUsd: null, projection: null });
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
    execInFlight = false;
  }
});

export default router;
