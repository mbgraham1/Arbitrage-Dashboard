import { Router, type IRouter } from "express";
import { desc, sql, sum, count, max, avg } from "drizzle-orm";
import { db, tradesTable, triScanTable } from "@workspace/db";
import {
  FetchPricesBody,
  FetchBalancesBody,
  TestKrakenBody,
  TestCoinbaseBody,
  ExecuteTradeBody,
  ExecuteTriangularBody,
  ObExecuteBody,
  ListTradesQueryParams,
} from "@workspace/api-zod";
import {
  getKrakenPrice,
  getKrakenBalances,
  krakenMarketOrder,
  krakenLimitOrder,
  krakenRawMarketOrder,
  krakenRawLimitOrder,
  krakenOrderFilled,
  krakenOrderInfo,
  krakenTakerFeePct,
  krakenFillPrice,
  krakenCancelOrder,
  getCoinbaseBalances,
  coinbaseMarketOrder,
  coinbaseLimitOrder,
  coinbaseOrderFilled,
  coinbaseFillPrice,
  coinbaseCancelOrder,
  PAIRS,
  type Pair,
} from "../lib/exchange";
import { getBestPairPrices, getTriPrices, getBtcTriPrices, scanAllPairs, getPairPrices, getAllPairSnapshots } from "../lib/price-cache";
import { scanOrderBookCycles, preflightObCycle, OB_ASSETS, OB_USD_PAIRS, CROSS_LOOKUP, type ObAsset } from "../lib/order-book";
import { scanGraphOpportunities } from "../lib/graph-engine";
import { createPairHistory, updatePairHistory, type PairHistory } from "../lib/kalman";
import { waitForTriLimitFill } from "../lib/tri-fill.js";

// ── Cointegration pairs-trading state (in-process memory) ─────────────────────
// Pairs: SOL/ETH, BTC/ETH, AVAX/DOT
// Prices are fetched from the multi-pair cache; no extra exchange calls needed.

interface CointPairConfig {
  label: string;   // display name e.g. "SOL/ETH"
  asset1: string;  // canonical pair key in pairCache, e.g. "SOL/USD"
  asset2: string;  // e.g. "ETH/USD"
  sym1: string;    // short symbol e.g. "SOL"
  sym2: string;    // e.g. "ETH"
}

const COINT_PAIRS: CointPairConfig[] = [
  { label: "SOL/ETH",  asset1: "SOL/USD",  asset2: "ETH/USD",  sym1: "SOL",  sym2: "ETH"  },
  { label: "BTC/ETH",  asset1: "BTC/USD",  asset2: "ETH/USD",  sym1: "BTC",  sym2: "ETH"  },
  { label: "AVAX/DOT", asset1: "AVAX/USD", asset2: "DOT/USD",  sym1: "AVAX", sym2: "DOT"  },
];

// Keyed by pair label — persists between requests in the same server process
const cointHistories = new Map<string, PairHistory>();

// Minimum |z-score| to surface a signal
const COINT_Z_THRESHOLD = 2.0;

// ── Triangular arb helpers ─────────────────────────────────────────────────────

// Fee model (matches Python v13 scan_triangular / FORCE TRIANGULAR):
// Gross profit is computed without fee adjustment in volumes.
// Net = Gross − TRI_TOTAL_FEES_PCT (flat deduction, 3 legs at maker rate).
// TRI_FEE_PER_LEG kept for the per-leg product formula used in ETH scanner.
const TRI_FEE_PER_LEG   = 0.0026;  // 0.26% taker fee per leg (ETH scanner, conservative)
const TRI_TOTAL_FEES_PCT = 0.50;   // 0.50% total for 3 limit-order legs (3 × 0.16% maker, Python default)
const TRI_MIN_PROFIT_PCT = 0.10;   // minimum net profit % to surface an opportunity

interface TriOpp {
  exchange: string;
  loop: string;
  profitPct: number;
  solUsd: number;
  ethUsd: number;   // for BTC variant: holds BTC/USD mid
  ethSol: number;   // for BTC variant: holds SOL/BTC mid
  variant?: "eth" | "btc";
  timestamp: string;
}

/**
 * For a single exchange with known bid/ask on all three pairs, compute the
 * profitability of both triangular loops after taker fees.
 *
 * Loop 1: USD → SOL → ETH → USD
 *   product1 = ethBid×(1–f) / (solAsk×ethSolAsk×(1+f)²)
 *
 * Loop 2: USD → ETH → SOL → USD
 *   product2 = ethSolBid×solBid×(1–f)² / (ethAsk×(1+f))
 */
function computeTriLoops(
  exchange: string,
  solBid: number, solAsk: number,
  ethBid: number, ethAsk: number,
  ethSolBid: number, ethSolAsk: number,
): TriOpp[] {
  const f = TRI_FEE_PER_LEG;
  const ts = new Date().toISOString();
  const solUsdMid = (solBid + solAsk) / 2;
  const ethUsdMid = (ethBid + ethAsk) / 2;
  const ethSolMid = (ethSolBid + ethSolAsk) / 2;
  const result: TriOpp[] = [];

  // Loop 1: USD → SOL → ETH → USD
  const product1 = (ethBid * (1 - f)) / (solAsk * (1 + f) * ethSolAsk * (1 + f));
  const profit1 = (product1 - 1) * 100;
  if (profit1 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange, loop: "USD→SOL→ETH→USD", profitPct: profit1, solUsd: solUsdMid, ethUsd: ethUsdMid, ethSol: ethSolMid, timestamp: ts });
  }

  // Loop 2: USD → ETH → SOL → USD
  const product2 = (ethSolBid * (1 - f) * solBid * (1 - f)) / (ethAsk * (1 + f));
  const profit2 = (product2 - 1) * 100;
  if (profit2 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange, loop: "USD→ETH→SOL→USD", profitPct: profit2, solUsd: solUsdMid, ethUsd: ethUsdMid, ethSol: ethSolMid, timestamp: ts });
  }

  return result;
}

/**
 * Port of Python v13 scan_triangular(): BTC/SOL/USD loops on Kraken.
 * Gross profit is computed with no per-leg fee adjustment in volumes —
 * fees are applied as a flat deduction (TRI_TOTAL_FEES_PCT), matching
 * the Python's `net = profit_pct - tri_fees` model.
 *
 * Loop 1: USD → BTC → SOL → USD
 *   gross = solBid / (btcAsk × solBtcAsk) − 1   (in %)
 *   net   = gross − TRI_TOTAL_FEES_PCT
 *
 * Loop 2: USD → SOL → BTC → USD
 *   gross = solBtcBid × btcBid / solAsk − 1   (in %)
 *   net   = gross − TRI_TOTAL_FEES_PCT
 */
function computeBtcTriLoops(
  solBid: number, solAsk: number,
  btcBid: number, btcAsk: number,
  solBtcBid: number, solBtcAsk: number,
): TriOpp[] {
  const ts = new Date().toISOString();
  const solUsdMid = (solBid + solAsk) / 2;
  const btcUsdMid = (btcBid + btcAsk) / 2;
  const solBtcMid = (solBtcBid + solBtcAsk) / 2;
  const result: TriOpp[] = [];

  // Loop 1: USD → BTC → SOL → USD
  const gross1 = (solBid / (btcAsk * solBtcAsk) - 1) * 100;
  const net1   = gross1 - TRI_TOTAL_FEES_PCT;
  if (net1 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange: "Kraken", loop: "USD→BTC→SOL→USD", profitPct: net1, solUsd: solUsdMid, ethUsd: btcUsdMid, ethSol: solBtcMid, variant: "btc", timestamp: ts });
  }

  // Loop 2: USD → SOL → BTC → USD
  const gross2 = (solBtcBid * btcBid / solAsk - 1) * 100;
  const net2   = gross2 - TRI_TOTAL_FEES_PCT;
  if (net2 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange: "Kraken", loop: "USD→SOL→BTC→USD", profitPct: net2, solUsd: solUsdMid, ethUsd: btcUsdMid, ethSol: solBtcMid, variant: "btc", timestamp: ts });
  }

  return result;
}

const router: IRouter = Router();

// ── GET /prices/all-pairs — cache snapshot, no REST fallbacks ─────────────────
router.get("/prices/all-pairs", (_req, res): void => {
  try {
    res.json(getAllPairSnapshots());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/scan — all 10 pairs ranked by gross spread ───────────────────────
router.get("/arb/scan", async (_req, res): Promise<void> => {
  try {
    const entries = await scanAllPairs();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/graph-scan ───────────────────────────────────────────────────────
// Multi-exchange graph opportunity engine: builds a directed graph over Kraken
// (34 assets + all verified cross pairs) and Coinbase (10 shared assets), then
// DFS-searches all USD→…→USD cycles up to 4 hops and ranks by net profit.
// Cross-exchange routes use an inventory bridge (no transfer lag assumed).
// Query params: tradeSizeUsd (default 10), krakenFeesPct (default 0.16),
//               coinbaseFeesPct (default 0.40), maxHops (default 4)
router.get("/arb/graph-scan", async (req, res): Promise<void> => {
  const tradeSizeUsd    = Math.max(1,  parseFloat(String(req.query["tradeSizeUsd"]    ?? "10"))   || 10);
  const krakenFeesPct   = Math.max(0,  parseFloat(String(req.query["krakenFeesPct"]   ?? "0.16")) || 0.16);
  const coinbaseFeesPct = Math.max(0,  parseFloat(String(req.query["coinbaseFeesPct"] ?? "0.40")) || 0.40);
  const maxHops         = Math.min(5, Math.max(2, parseInt(String(req.query["maxHops"] ?? "4"), 10) || 4));
  try {
    const result = await scanGraphOpportunities(tradeSizeUsd, krakenFeesPct, coinbaseFeesPct, maxHops);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "graph-scan error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/ob-scan ──────────────────────────────────────────────────────────
// Port of Python v18 "Scaling Analyzer" (34 assets; top route re-simulated at
// $10/$50/$100/$500/$1,000 with VIABLE / HIGH_SLIPPAGE / REJECTED statuses).
// Fetches L2 depth from Kraken, walks the book for all simulatable cycles,
// classifies each READY / HIGH_SLIPPAGE / LOW_PROFIT and scores liquidity
// confidence. Optional volatility filter scans only assets moving >1.5%/24h.
// Query params: tradeSizeUsd (default 10), feesPct (default 0.4, per-leg taker),
//               minProfitUsd (default 0.02, scaled by size/10), maxSlippagePct (default 0.5),
//               volatilityFilter (default true)
router.get("/arb/ob-scan", async (req, res): Promise<void> => {
  const tradeSizeUsd   = Math.max(1, parseFloat(String(req.query["tradeSizeUsd"]   ?? "10"))   || 10);
  const feesPct        = Math.max(0, parseFloat(String(req.query["feesPct"]        ?? "0.26")) || 0.26);
  const minProfitUsd   = Math.max(0, parseFloat(String(req.query["minProfitUsd"]   ?? "0.02")) || 0.02);
  const maxSlippagePct = Math.max(0, parseFloat(String(req.query["maxSlippagePct"] ?? "0.4"))  || 0.4);
  const volatilityFilter = String(req.query["volatilityFilter"] ?? "true") !== "false";
  try {
    const result = await scanOrderBookCycles(tradeSizeUsd, feesPct, minProfitUsd, maxSlippagePct, volatilityFilter);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "OB scan error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /arb/ob-execute ──────────────────────────────────────────────────────
// Port of Python v18 "MANUAL EXECUTION BUTTON": re-fetches FRESH order books
// for the top route, re-simulates (pre-flight), and only places orders when
// the edge survives (profit > minProfitUsd × size/10). Three sequential Kraken
// market orders with orientation-aware legs.
// NOTE: the Python's leg math is buggy (unconditional "sell" on the cross leg,
// nonsense leg-3 volume `vol × profit/size`) — we size all legs from the
// pre-flight simulation instead. On leg failure, previously filled legs are
// unwound with reverse market orders (best effort).
router.post("/arb/ob-execute", async (req, res): Promise<void> => {
  const parsed = ObExecuteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { krakenKey, krakenSecret, assetA, assetB, tradeSizeUsd, feesPct, minProfitUsd, isDryRun } = parsed.data;
  const creds = { krakenKey, krakenSecret };
  const route = `USD→${assetA}→${assetB}→USD`;

  if (!(OB_ASSETS as readonly string[]).includes(assetA) || !(OB_ASSETS as readonly string[]).includes(assetB)) {
    res.status(400).json({ error: `Unknown asset(s): ${assetA}/${assetB}` });
    return;
  }

  try {
    // 0. Use the account's ACTUAL taker fee tier when possible (advisor
    //    recommendation) instead of the caller's assumption. Falls back to the
    //    request's feesPct if the fee query fails (e.g. dry run with bad keys).
    const crossPair = CROSS_LOOKUP.get(`${assetA}-${assetB}`)?.pair;
    const feePairs = [OB_USD_PAIRS[assetA as ObAsset], OB_USD_PAIRS[assetB as ObAsset], crossPair].filter((p): p is string => !!p);
    const actualFeePct = await krakenTakerFeePct(creds, feePairs);
    const effectiveFeesPct = actualFeePct ?? feesPct;

    // 1. Fresh pre-flight (cache bypassed, depth 10)
    const pf = await preflightObCycle(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, effectiveFeesPct);
    if (!pf) {
      res.json({ success: false, isDryRun, executed: false, route, preflightProfitUsd: null, error: "Could not fetch fresh order books (or depth can't absorb the size)." });
      return;
    }
    // Execution gate: fresh profit AFTER FEES must clear the caller's
    // minProfitUsd floor (flat USD, not scaled by trade size).
    const threshold = minProfitUsd;
    if (pf.profitUsd <= threshold) {
      res.json({ success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: `Pre-flight failed — fresh profit after ${effectiveFeesPct.toFixed(2)}%/leg fees${actualFeePct != null ? " (your actual Kraken tier)" : ""} is $${pf.profitUsd.toFixed(4)} ≤ minimum $${threshold.toFixed(4)}.` });
      return;
    }

    // 2. Dry run — record a ledger row, no orders
    if (isDryRun) {
      await db.insert(tradesTable).values({
        pair: route,
        buyExchange: "kraken",
        sellExchange: "kraken",
        volumeSol: pf.volumeA.toFixed(8),
        estimatedProfitUsd: pf.profitUsd.toFixed(6),
        netEdgePct: ((pf.profitUsd / tradeSizeUsd) * 100).toFixed(4),
        isDryRun: true,
        krakenPrice: "0",
        coinbasePrice: "0",
      });
      req.log.info({ route, tradeSizeUsd, profit: pf.profitUsd }, "OB manual execute (dry run)");
      res.json({ success: true, isDryRun: true, executed: true, route, preflightProfitUsd: pf.profitUsd, leg1OrderId: null, leg2OrderId: null, leg3OrderId: null });
      return;
    }

    // 3. Live — three sequential market orders. Each leg must FULLY fill or
    //    the execution aborts and unwinds the ACTUAL residual positions
    //    (queried from the exchange, never assumed from the plan). Success is
    //    only reported when the position ends flat.
    const log = { info: (m: string) => req.log.info(m), error: (m: string) => req.log.error(m) };
    const [l1, l2, l3] = pf.legs;
    const cross = CROSS_LOOKUP.get(`${assetA}-${assetB}`)!; // validated by pre-flight
    const pairA = OB_USD_PAIRS[assetA as ObAsset];
    const pairB = OB_USD_PAIRS[assetB as ObAsset];
    const FILL_TOLERANCE = 0.999; // volExec must reach 99.9% of ordered volume

    // Never-throwing order info — used in recovery paths to learn actual fills.
    const safeInfo = async (txid: string) => {
      try { return await krakenOrderInfo(creds, txid); }
      catch { return { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 }; }
    };

    // Poll QueryOrders until closed. Limit (post-only) orders may rest in the
    // book a while; we poll for up to 90 s before cancelling and aborting.
    const LIMIT_POLL_ITERS = 180; // 180 × 500ms = 90 s
    const waitFill = async (txid: string, label: string) => {
      for (let i = 0; i < LIMIT_POLL_ITERS; i++) {
        await new Promise(r => setTimeout(r, 500));
        const info = await safeInfo(txid);
        if (info.status === "closed" || info.status === "canceled" || info.status === "expired") return info;
      }
      await tryCancel(creds, txid, label, log); // timed out — cancel, then read final state
      return safeInfo(txid);
    };

    let leg1Id = "", leg2Id = "", leg3Id = "";
    let usdSpent = 0, usdReceived = 0, totalFees = 0;

    // ── Leg 1: buy A with USD. Post-only limit at best bid → maker fee ────────
    let aHeld = 0;
    try {
      const r1 = await krakenRawLimitOrder(creds, l1.side, l1.volume, l1.limitPrice, l1.pair);
      leg1Id = r1.txid[0] ?? "";
    } catch (e) {
      throw new Error(`Leg 1 failed (no order placed): ${(e as Error).message}`);
    }
    {
      const f1 = await waitFill(leg1Id, "leg1");
      aHeld = f1.volExec;
      usdSpent = f1.cost + f1.fee;
      totalFees += f1.fee;
      if (aHeld < l1.volume * FILL_TOLERANCE) {
        if (aHeld > 0) await tryUnwindMarket(creds, "sell", aHeld, pairA, `sell ${assetA} (unwind partial leg1)`, log);
        throw new Error(`Leg 1 did not fully fill (${aHeld.toFixed(8)}/${l1.volume.toFixed(8)} ${assetA}); partial position unwound.`);
      }
    }

    // ── Leg 2: convert A → B on cross. Post-only limit at best bid/ask ───────
    const l2Volume = l2.volume * (aHeld / pf.volumeA); // scale to actual leg-1 fill
    let bHeld = 0;
    try {
      const r2 = await krakenRawLimitOrder(creds, l2.side, l2Volume, l2.limitPrice, l2.pair);
      leg2Id = r2.txid[0] ?? "";
    } catch (e) {
      // Order never placed — we hold all of A; sell it back.
      await tryUnwindMarket(creds, "sell", aHeld, pairA, `sell ${assetA} (unwind after leg2 rejection)`, log);
      throw new Error(`Leg 2 failed (${assetA} position sold back): ${(e as Error).message}`);
    }
    {
      const f2 = await waitFill(leg2Id, "leg2");
      // aIsQuote → bought base B: volExec = B acquired, cost+fee = A consumed.
      // else     → sold base A:   volExec = A consumed, cost−fee = B received.
      const aConsumed = cross.aIsQuote ? f2.cost + f2.fee : f2.volExec;
      bHeld = cross.aIsQuote ? f2.volExec : Math.max(0, f2.cost - f2.fee);
      const fullFill = f2.volExec >= l2Volume * FILL_TOLERANCE;
      if (!fullFill) {
        // Unwind BOTH residuals from actual fills: leftover A + acquired B.
        const aResidual = Math.max(0, aHeld - aConsumed);
        if (aResidual > 0) await tryUnwindMarket(creds, "sell", aResidual, pairA, `sell residual ${assetA} (partial leg2)`, log);
        if (bHeld > 0)     await tryUnwindMarket(creds, "sell", bHeld,     pairB, `sell acquired ${assetB} (partial leg2)`, log);
        throw new Error(`Leg 2 did not fully fill (${f2.volExec.toFixed(8)}/${l2Volume.toFixed(8)}); residual ${assetA} and acquired ${assetB} unwound.`);
      }
      // Cross-leg fee is charged in A or B units and is implicitly captured in
      // the final USD delta (less B acquired → less USD out), so it is not
      // added to totalFees (which tracks USD-denominated fees only).
      if (bHeld <= 0) {
        throw new Error("Leg 2 reported zero acquired volume despite full fill.");
      }
    }

    // ── Leg 3: sell B for USD. Post-only limit at best ask → maker fee ───────
    try {
      const r3 = await krakenRawLimitOrder(creds, l3.side, bHeld, l3.limitPrice, l3.pair);
      leg3Id = r3.txid[0] ?? "";
    } catch (e) {
      await tryUnwindMarket(creds, "sell", bHeld, pairB, `sell ${assetB} (unwind after leg3 rejection)`, log);
      throw new Error(`Leg 3 failed (${assetB} position sold via unwind): ${(e as Error).message}`);
    }
    {
      const f3 = await waitFill(leg3Id, "leg3");
      usdReceived = Math.max(0, f3.cost - f3.fee);
      totalFees += f3.fee;
      const bResidual = Math.max(0, bHeld - f3.volExec);
      if (f3.volExec < bHeld * FILL_TOLERANCE) {
        // Sell the residual B; report as a partial (failed) execution, not success.
        if (bResidual > 0) await tryUnwindMarket(creds, "sell", bResidual, pairB, `sell residual ${assetB} (partial leg3)`, log);
        throw new Error(`Leg 3 partially filled (${f3.volExec.toFixed(8)}/${bHeld.toFixed(8)} ${assetB}); residual sold via unwind. USD received so far: $${usdReceived.toFixed(4)}.`);
      }
    }

    // Realized P&L from actual fills, fee-inclusive (cost fields exclude fees;
    // usdSpent includes leg1 fee, usdReceived deducts leg3 fee).
    const realizedProfit = usdSpent > 0 && usdReceived > 0 ? usdReceived - usdSpent : pf.profitUsd;
    await db.insert(tradesTable).values({
      pair: route,
      buyExchange: "kraken",
      sellExchange: "kraken",
      volumeSol: aHeld.toFixed(8),
      estimatedProfitUsd: realizedProfit.toFixed(6),
      netEdgePct: usdSpent > 0 ? ((realizedProfit / usdSpent) * 100).toFixed(4) : ((pf.profitUsd / tradeSizeUsd) * 100).toFixed(4),
      isDryRun: false,
      krakenPrice: "0",
      coinbasePrice: "0",
      buyOrderId: leg1Id || null,
      sellOrderId: leg3Id || null,
    });
    req.log.info({ route, tradeSizeUsd, realizedProfit, usdSpent, usdReceived, totalFees, leg1Id, leg2Id, leg3Id }, "OB manual execute LIVE");
    res.json({ success: true, isDryRun: false, executed: true, route, preflightProfitUsd: realizedProfit, leg1OrderId: leg1Id, leg2OrderId: leg2Id, leg3OrderId: leg3Id });
  } catch (err) {
    req.log.error({ err, route }, "OB manual execute error");
    res.json({ success: false, isDryRun, executed: false, route, preflightProfitUsd: null, error: (err as Error).message });
  }
});

// ── GET /arb/triangular ────────────────────────────────────────────────────────
router.get("/arb/triangular", async (_req, res): Promise<void> => {
  try {
    const tri = getTriPrices();
    const opportunities: TriOpp[] = [];
    const prices: Record<string, unknown> = {};
    const priceSource: Record<string, "direct" | "synthetic"> = {};

    if (tri.kraken) {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk, ethSolSource } = tri.kraken;
      prices.kraken = { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk };
      priceSource.kraken = ethSolSource;
      opportunities.push(...computeTriLoops("Kraken", solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk));
    }

    if (tri.coinbase) {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk, ethSolSource } = tri.coinbase;
      prices.coinbase = { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk };
      priceSource.coinbase = ethSolSource;
      opportunities.push(...computeTriLoops("Coinbase", solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk));
    }

    // BTC triangular loops (v13 Python port — Kraken SOLXBT market)
    const btcPrices = getBtcTriPrices();
    if (btcPrices) {
      const { solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk } = btcPrices;
      prices.krakenBtc = { solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk };
      opportunities.push(...computeBtcTriLoops(solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk));
    }

    // Sort all opportunities by profitPct descending
    opportunities.sort((a, b) => b.profitPct - a.profitPct);

    // Persist detected opportunities to DB (fire-and-forget — never fail the scan response)
    if (opportunities.length > 0) {
      db.insert(triScanTable)
        .values(
          opportunities.map((opp) => ({
            exchange: opp.exchange,
            loop: opp.loop,
            profitPct: String(opp.profitPct.toFixed(6)),
            solUsd: String(opp.solUsd.toFixed(6)),
            ethUsd: String(opp.ethUsd.toFixed(6)),
            ethSol: String(opp.ethSol.toFixed(8)),
            variant: opp.variant ?? null,
            scannedAt: opp.timestamp,
          })),
        )
        .catch(() => {});
    }

    res.json({ opportunities, prices, priceSource, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/triangular/history ───────────────────────────────────────────────
router.get("/arb/triangular/history", async (req, res): Promise<void> => {
  try {
    const limit  = Math.min(200, Math.max(1, parseInt(String(req.query["limit"]  ?? "50"))  || 50));
    const offset = Math.max(0,               parseInt(String(req.query["offset"] ?? "0"))   || 0);

    const [items, [totalRow]] = await Promise.all([
      db.select().from(triScanTable).orderBy(desc(triScanTable.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(triScanTable),
    ]);

    res.json({
      items: items.map((r) => ({
        ...r,
        profitPct: parseFloat(r.profitPct),
        solUsd:    parseFloat(r.solUsd),
        ethUsd:    parseFloat(r.ethUsd),
        ethSol:    parseFloat(r.ethSol),
        createdAt: r.createdAt.toISOString(),
      })),
      total: Number(totalRow?.total ?? 0),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/triangular/history/summary ───────────────────────────────────────
// Returns aggregate stats across all recorded triangular scan rows.
// Query param: tradeSizeUsd (default 1000) — used for counterfactual P&L.
router.get("/arb/triangular/history/summary", async (req, res): Promise<void> => {
  const tradeSizeUsd = Math.max(1, parseFloat(String(req.query["tradeSizeUsd"] ?? "1000")) || 1000);
  try {
    const [row] = await db
      .select({
        total:        count(),
        avgProfitPct: sql<number>`AVG(CAST(${triScanTable.profitPct} AS NUMERIC))`,
        bestProfitPct: sql<number>`MAX(CAST(${triScanTable.profitPct} AS NUMERIC))`,
        sumProfitPct: sql<number>`SUM(CAST(${triScanTable.profitPct} AS NUMERIC))`,
      })
      .from(triScanTable);

    const total         = Number(row?.total          ?? 0);
    const avgProfitPct  = parseFloat(String(row?.avgProfitPct  ?? "0")) || 0;
    const bestProfitPct = parseFloat(String(row?.bestProfitPct ?? "0")) || 0;
    const sumProfitPct  = parseFloat(String(row?.sumProfitPct  ?? "0")) || 0;
    // Counterfactual P&L: if every detected opportunity had been traded at tradeSizeUsd
    const counterfactualPnlUsd = (sumProfitPct / 100) * tradeSizeUsd;

    res.json({ total, avgProfitPct, bestProfitPct, counterfactualPnlUsd, tradeSizeUsd });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Triangular execution helpers ───────────────────────────────────────────────

/** Attempt to cancel a limit order to unwind a partial triangular trade. */
async function tryCancel(
  creds: { krakenKey: string; krakenSecret: string },
  txid: string,
  label: string,
  log: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  if (!txid) return;
  try {
    await krakenCancelOrder(creds, txid);
    log.info(`[TRI·UNWIND] Cancelled ${label} (${txid})`);
  } catch (e) {
    log.error(`[TRI·UNWIND] Cancel ${label} (${txid}) failed — may be filled: ${(e as Error).message}`);
  }
}

// waitForTriLimitFill and TriFillResult live in lib/tri-fill.ts for testability.
export { waitForTriLimitFill, type TriFillResult } from "../lib/tri-fill.js";

/** Place a market counter-order to unwind an already-filled leg. */
async function tryUnwindMarket(
  creds: { krakenKey: string; krakenSecret: string },
  side: "buy" | "sell",
  volume: number,
  pair: string,
  label: string,
  log: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  if (volume <= 0) return;
  try {
    const r = await krakenRawMarketOrder(creds, side, volume, pair);
    log.info(`[TRI·UNWIND] Market ${side} ${volume.toFixed(6)} ${pair} — ${label} (${r.txid[0] ?? "?"})`);
  } catch (e) {
    log.error(`[TRI·UNWIND] Market ${side} ${pair} failed: ${(e as Error).message}`);
  }
}

// ── POST /arb/execute-triangular ──────────────────────────────────────────────
// Port of Python v13 FORCE TRIANGULAR + auto-loop execution.
// Supports both BTC loops (SOLXBT) and ETH loops (ETHSOL).
//
// Order types (matching Python v13 exactly):
//   orderType="market" (default) — FORCE button: market orders, $10 test size
//   orderType="limit"            — auto-loop: post-only limit orders, 20% USD / max $50
//
// Volume model (matching Python): raw division, no per-leg fee in volume.
// Profit estimate: (gross_pct − TRI_TOTAL_FEES_PCT) × tradeUsd / 100
//
// Failure handling: if any leg throws after a previous leg has been placed,
//   • limit orders — attempt cancel (may not be filled yet)
//   • market orders — attempt a reverse market order to unwind
router.post("/arb/execute-triangular", async (req, res): Promise<void> => {
  const parsed = ExecuteTriangularBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { krakenKey, krakenSecret, loop, tradeUsd: overrideUsd, isDryRun, orderType } = parsed.data;
  const useLimit = orderType === "limit"; // limit = post-only maker (auto-loop); market = force

  const BTC_LOOPS = ["USD→BTC→SOL→USD", "USD→SOL→BTC→USD"];
  const ETH_LOOPS = ["USD→SOL→ETH→USD", "USD→ETH→SOL→USD"];
  const VALID_LOOPS = [...BTC_LOOPS, ...ETH_LOOPS];
  if (!VALID_LOOPS.includes(loop)) {
    res.status(400).json({ error: `Invalid loop "${loop}". Valid: ${VALID_LOOPS.join(", ")}` });
    return;
  }

  const creds = { krakenKey, krakenSecret };
  const isBtc = BTC_LOOPS.includes(loop);

  // Simple log shim that delegates to pino request logger
  const log = {
    info:  (msg: string) => req.log.info(msg),
    error: (msg: string) => req.log.error(msg),
  };

  // 1a. BTC loops — get prices from WS cache or fresh REST fallback
  let btcPrices: { solBid: number; solAsk: number; btcBid: number; btcAsk: number; solBtcBid: number; solBtcAsk: number } | null = null;

  // 1b. ETH loops — get prices from WS tri cache or fresh REST fallback
  let ethPrices: { solBid: number; solAsk: number; ethBid: number; ethAsk: number; ethSolBid: number; ethSolAsk: number } | null = null;
  // Tracks whether the ETH/SOL leg used a direct market or a synthetic cross rate.
  // Carried to the response so the dashboard can warn the user.
  let ethSolSource: "direct" | "synthetic" = "synthetic";

  if (isBtc) {
    btcPrices = getBtcTriPrices();
    if (!btcPrices) {
      try {
        const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD,SOLUSD,SOLXBT", {
          signal: AbortSignal.timeout(5_000),
        });
        const data = await r.json() as { error?: string[]; result?: Record<string, { b: string[]; a: string[] }> };
        if (data.error?.length || !data.result) throw new Error("Kraken REST error");
        const res_ = data.result;
        const btcKey    = Object.keys(res_).find(k => k.includes("XBT") && k.includes("USD"));
        const solKey    = Object.keys(res_).find(k => k.startsWith("SOL") && k.endsWith("USD"));
        const solBtcKey = Object.keys(res_).find(k => k.startsWith("SOL") && k.includes("XBT"));
        if (!btcKey || !solKey || !solBtcKey) throw new Error("Missing pairs in Kraken response");
        btcPrices = {
          btcBid:    parseFloat(res_[btcKey].b[0]),    btcAsk:    parseFloat(res_[btcKey].a[0]),
          solBid:    parseFloat(res_[solKey].b[0]),     solAsk:    parseFloat(res_[solKey].a[0]),
          solBtcBid: parseFloat(res_[solBtcKey].b[0]), solBtcAsk: parseFloat(res_[solBtcKey].a[0]),
        };
      } catch (e) {
        res.status(500).json({ error: `BTC tri prices unavailable: ${(e as Error).message}` });
        return;
      }
    }
  } else {
    // ETH loops — try WS cache first, fall back to REST
    const cached = getTriPrices();
    const krakenTri = cached.kraken;
    if (krakenTri) {
      ethSolSource = krakenTri.ethSolSource;
      ethPrices = {
        solBid: krakenTri.solBid, solAsk: krakenTri.solAsk,
        ethBid: krakenTri.ethBid, ethAsk: krakenTri.ethAsk,
        ethSolBid: krakenTri.ethSolBid, ethSolAsk: krakenTri.ethSolAsk,
      };
    } else {
      // WS cache miss — fetch fresh prices from Kraken REST.
      // Request XETHZUSD + SOLUSD + ETHSOL together; ETHSOL may not exist
      // under that exact key (Kraken sometimes uses "XETHZSOL"), so we
      // search the result by content rather than by a hardcoded key.
      // If the direct ETH/SOL market is absent entirely, we compute a
      // synthetic cross rate from the two USD legs instead of erroring out.
      try {
        const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XETHZUSD,SOLUSD,ETHSOL", {
          signal: AbortSignal.timeout(5_000),
        });
        const data = await r.json() as { error?: string[]; result?: Record<string, { b: string[]; a: string[] }> };
        // A partial error (e.g. ETHSOL unknown) is fine — we fall back to synthetic.
        // A total failure (no result at all) is a hard error.
        if (!data.result) throw new Error(`Kraken REST error: ${(data.error ?? []).join(", ")}`);
        const res_ = data.result;
        const ethKey    = Object.keys(res_).find(k => k.includes("ETH") && k.includes("USD"));
        const solKey    = Object.keys(res_).find(k => k.startsWith("SOL") && k.endsWith("USD"));
        if (!ethKey || !solKey) throw new Error("Missing ETH/USD or SOL/USD in Kraken response");
        const ethBid = parseFloat(res_[ethKey].b[0]);
        const ethAsk = parseFloat(res_[ethKey].a[0]);
        const solBid = parseFloat(res_[solKey].b[0]);
        const solAsk = parseFloat(res_[solKey].a[0]);
        // Try to find the direct ETH/SOL pair under any key variant (ETHSOL, XETHZSOL, etc.)
        const ethSolKey = Object.keys(res_).find(k => k.includes("ETH") && k.includes("SOL"));
        let ethSolBid: number;
        let ethSolAsk: number;
        if (ethSolKey) {
          ethSolBid   = parseFloat(res_[ethSolKey].b[0]);
          ethSolAsk   = parseFloat(res_[ethSolKey].a[0]);
          ethSolSource = "direct";
        } else {
          // Direct market unavailable — synthesise from USD legs.
          // synthetic bid = ethBid / solAsk  (worst case: sell ETH cheap, pay high SOL)
          // synthetic ask = ethAsk / solBid  (worst case: buy ETH dear, receive low SOL)
          ethSolBid   = solAsk > 0 ? ethBid / solAsk : 0;
          ethSolAsk   = solBid > 0 ? ethAsk / solBid : 0;
          ethSolSource = "synthetic";
          req.log.warn({ ethKey, solKey }, "ETH/SOL direct market absent in REST response — using synthetic cross rate");
        }
        ethPrices = { ethBid, ethAsk, solBid, solAsk, ethSolBid, ethSolAsk };
      } catch (e) {
        res.status(500).json({ error: `ETH tri prices unavailable: ${(e as Error).message}` });
        return;
      }
    }

    // Guard: reject if the ETH/SOL rate (direct or synthetic) resolved to zero/NaN,
    // which would produce nonsense volumes and a silent profit miscalculation.
    if (!ethPrices || !(ethPrices.ethSolBid > 0) || !(ethPrices.ethSolAsk > 0)) {
      res.status(500).json({
        error: "ETH/SOL rate is zero or invalid — cannot compute triangular volumes safely. " +
               "The direct market may be unavailable and the synthetic cross rate produced unusable prices.",
      });
      return;
    }

    // Guard: synthetic cross rates are NOT executable order-book prices.
    // Leg 2 of every ETH loop places an order on the ETHSOL pair; if that market
    // is absent, the leg will be rejected by Kraken, leaving leg 1 open and
    // requiring an unwind. Block live execution proactively instead of gambling
    // on leg 2 succeeding with a price that does not reflect a real bid/ask.
    if (!isDryRun && ethSolSource === "synthetic") {
      req.log.warn({ loop, ethSolSource }, "Live ETH triangular execution blocked — ETHSOL market unavailable");
      res.status(500).json({
        error: "ETH/SOL direct market is currently unavailable on Kraken. " +
               "Live triangular execution requires a real ETHSOL order book — a synthetic cross rate cannot be submitted as a limit or market order. " +
               "Use dry-run mode to estimate profit, or wait for the direct market to come online.",
        priceSource: "synthetic",
        synthetic: true,
      });
      return;
    }
  }

  // 2. Determine trade size (USD)
  // Python: force = min(usd, 10); auto-loop = min(usd * 0.2, 50)
  let tradeUsd = overrideUsd;
  if (tradeUsd == null) {
    if (isDryRun || !useLimit) {
      tradeUsd = 10; // force / dry-run: $10 test
    } else {
      // auto-loop: 20% of USD balance, max $50
      const balances = await getKrakenBalances(creds);
      const usdBal = balances.find(b => ["ZUSD", "USD"].includes(b.currency))?.amount ?? 0;
      tradeUsd = Math.min(usdBal * 0.2, 50);
      if (tradeUsd < 1) {
        res.json({ success: false, isDryRun: false, estimatedProfitUsd: 0, error: "Insufficient USD balance (< $5)" });
        return;
      }
    }
  }

  // 3. Compute raw volumes (no per-leg fee in amounts — Python does the same).
  //    Profit estimate uses flat fee deduction: gross − TRI_TOTAL_FEES_PCT.
  let grossPct: number;
  let leg1Vol: number; // primary asset volume for leg1/leg3
  let leg2Vol: number; // intermediate asset volume for leg2

  if (isBtc) {
    const { solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk } = btcPrices!;
    if (loop === "USD→BTC→SOL→USD") {
      // USD → buy BTC → buy SOL with BTC → sell SOL for USD
      leg1Vol  = tradeUsd / btcAsk;           // BTC amount
      leg2Vol  = leg1Vol / solBtcAsk;          // SOL amount
      grossPct = (leg2Vol * solBid / tradeUsd - 1) * 100;
    } else {
      // USD → buy SOL → sell SOL for BTC → sell BTC for USD
      leg1Vol  = tradeUsd / solAsk;            // SOL amount
      leg2Vol  = leg1Vol * solBtcBid;          // BTC amount
      grossPct = (leg2Vol * btcBid / tradeUsd - 1) * 100;
    }
  } else {
    const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk } = ethPrices!;
    // ethSolBid/Ask = SOL per ETH on ETHSOL pair (ETH=base, SOL=quote)
    if (loop === "USD→SOL→ETH→USD") {
      // USD → buy SOL → buy ETH (pay SOL) → sell ETH for USD
      leg1Vol  = tradeUsd / solAsk;            // SOL amount purchased
      leg2Vol  = leg1Vol / ethSolAsk;          // ETH amount (solAmt / (SOL per ETH) = ETH)
      grossPct = (leg2Vol * ethBid / tradeUsd - 1) * 100;
    } else {
      // USD → buy ETH → sell ETH for SOL → sell SOL for USD
      leg1Vol  = tradeUsd / ethAsk;            // ETH amount purchased
      leg2Vol  = leg1Vol * ethSolBid;          // SOL amount (ethAmt × SOL/ETH at bid = SOL)
      grossPct = (leg2Vol * solBid / tradeUsd - 1) * 100;
    }
  }

  const estimatedProfitUsd = (grossPct - TRI_TOTAL_FEES_PCT) / 100 * tradeUsd;

  if (isDryRun) {
    const triPriceSource = isBtc ? "direct" : ethSolSource;
    req.log.info({ loop, tradeUsd, grossPct, estimatedProfitUsd, orderType, triPriceSource }, "Triangular dry run");
    res.json({
      success: true, isDryRun: true, estimatedProfitUsd,
      priceSource: triPriceSource, synthetic: triPriceSource === "synthetic",
      leg1OrderId: null, leg2OrderId: null, leg3OrderId: null,
    });
    return;
  }

  // 4. Execute 3 sequential orders.
  //    On failure: cancel unfilled limit orders or place reverse market orders to unwind.
  let leg1Id = "";
  let leg2Id = "";
  let leg3Id = "";

  try {
    // ── BTC loops ────────────────────────────────────────────────────────────
    if (isBtc) {
      const { solBid, solAsk, btcAsk, solBtcAsk, solBtcBid, btcBid } = btcPrices!;
      const plannedBtcAmt = leg1Vol;
      const plannedSolAmt = leg2Vol;

      if (loop === "USD→BTC→SOL→USD") {
        // USD → buy BTC → buy SOL with BTC → sell SOL for USD
        //
        // For limit orders we track actual filled amounts from krakenOrderInfo
        // and use them to size subsequent legs and any unwind orders.
        //
        // SOLXBT: SOL=base, BTC=quote
        //   buy: vol_exec=SOL acquired, cost=BTC spent, fee=BTC
        // SOLUSD: SOL=base, USD=quote
        //   sell: vol_exec=SOL sold, cost=USD received, fee=USD

        // Leg 1: buy BTC with USD (XXBTZUSD buy: vol_exec=BTC, cost=USD)
        let actualBtcAmt = plannedBtcAmt;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedBtcAmt, btcAsk, "XXBTZUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedBtcAmt,         "XXBTZUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 BTC buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "XXBTZUSD", `sell ${f1.volExec.toFixed(8)} BTC partial leg1`, log);
            throw new Error(`Leg 1 BTC buy timed out — cancelled. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} BTC unwound.` : "No fill."}`);
          }
          actualBtcAmt = f1.volExec; // actual BTC acquired; use for leg 2 sizing
        }

        // Leg 2: buy SOL with BTC (SOLXBT buy)
        // Scale plan to actual leg-1 fill; for market orders use planned vol.
        const leg2SolAmt = useLimit ? actualBtcAmt / solBtcAsk : plannedSolAmt;
        let actualSolAmt = leg2SolAmt;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", leg2SolAmt, solBtcAsk, "SOLXBT")
            : await krakenRawMarketOrder(creds, "buy", leg2SolAmt,            "SOLXBT");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualBtcAmt, "XXBTZUSD", "sell BTC (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 SOL buy", log);
          if (!f2.filled) {
            // SOLXBT buy: vol_exec=SOL acquired, cost+fee=BTC consumed
            const btcConsumed = f2.cost + f2.fee;
            const btcRemaining = Math.max(0, actualBtcAmt - btcConsumed);
            if (f2.volExec > 0) await tryUnwindMarket(creds, "sell", f2.volExec, "SOLUSD",    `sell ${f2.volExec.toFixed(8)} SOL partial leg2`, log);
            if (btcRemaining > 0) await tryUnwindMarket(creds, "sell", btcRemaining, "XXBTZUSD", `sell ${btcRemaining.toFixed(8)} BTC remaining leg1`, log);
            throw new Error(`Leg 2 SOL buy timed out. SOL ${f2.volExec.toFixed(8)} + BTC ${btcRemaining.toFixed(8)} unwound.`);
          }
          actualSolAmt = f2.volExec; // actual SOL acquired; use for leg 3
        }

        // Leg 3: sell SOL for USD (SOLUSD sell)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualSolAmt, solBid, "SOLUSD")
            : await krakenRawMarketOrder(creds, "sell", actualSolAmt,         "SOLUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt, "SOLUSD", "sell SOL (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (SOL unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 SOL sell", log);
          if (!f3.filled) {
            const solRemaining = Math.max(0, actualSolAmt - f3.volExec);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD", `sell ${solRemaining.toFixed(8)} SOL remaining leg3`, log);
            throw new Error(`Leg 3 SOL sell timed out. ${solRemaining.toFixed(8)} SOL remaining unwound.`);
          }
        }

      } else {
        // USD→SOL→BTC→USD
        // USD → buy SOL → sell SOL for BTC → sell BTC for USD
        //
        // SOLXBT: SOL=base, BTC=quote
        //   sell: vol_exec=SOL sold, cost=BTC received, fee=BTC → btcAcquired = cost - fee
        // XXBTZUSD: BTC=base, USD=quote
        //   sell: vol_exec=BTC sold, cost=USD received, fee=USD
        const plannedSolAmt2 = leg1Vol;
        const plannedBtcAmt2 = leg2Vol;

        // Leg 1: buy SOL with USD (SOLUSD buy: vol_exec=SOL, cost=USD)
        let actualSolAmt2 = plannedSolAmt2;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedSolAmt2, solAsk, "SOLUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedSolAmt2,         "SOLUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 SOL buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "SOLUSD", `sell ${f1.volExec.toFixed(8)} SOL partial leg1`, log);
            throw new Error(`Leg 1 SOL buy timed out. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} SOL unwound.` : "No fill."}`);
          }
          actualSolAmt2 = f1.volExec;
        }

        // Leg 2: sell SOL for BTC (SOLXBT sell)
        let actualBtcAmt2 = useLimit ? actualSolAmt2 * solBtcBid : plannedBtcAmt2;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualSolAmt2, solBtcBid, "SOLXBT")
            : await krakenRawMarketOrder(creds, "sell", actualSolAmt2,            "SOLXBT");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt2, "SOLUSD", "sell SOL (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 SOL sell", log);
          if (!f2.filled) {
            // SOLXBT sell: vol_exec=SOL sold, cost-fee=BTC acquired
            const btcAcquired = Math.max(0, f2.cost - f2.fee);
            const solRemaining = Math.max(0, actualSolAmt2 - f2.volExec);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD",    `sell ${solRemaining.toFixed(8)} SOL remaining leg2`, log);
            if (btcAcquired > 0) await tryUnwindMarket(creds, "sell", btcAcquired,  "XXBTZUSD", `sell ${btcAcquired.toFixed(8)} BTC partial leg2`, log);
            throw new Error(`Leg 2 SOL sell timed out. SOL ${solRemaining.toFixed(8)} + BTC ${btcAcquired.toFixed(8)} unwound.`);
          }
          actualBtcAmt2 = Math.max(0, f2.cost - f2.fee); // actual BTC received
        }

        // Leg 3: sell BTC for USD (XXBTZUSD sell)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualBtcAmt2, btcBid, "XXBTZUSD")
            : await krakenRawMarketOrder(creds, "sell", actualBtcAmt2,         "XXBTZUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualBtcAmt2, "XXBTZUSD", "sell BTC (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (BTC unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 BTC sell", log);
          if (!f3.filled) {
            const btcRemaining = Math.max(0, actualBtcAmt2 - f3.volExec);
            if (btcRemaining > 0) await tryUnwindMarket(creds, "sell", btcRemaining, "XXBTZUSD", `sell ${btcRemaining.toFixed(8)} BTC remaining leg3`, log);
            throw new Error(`Leg 3 BTC sell timed out. ${btcRemaining.toFixed(8)} BTC remaining unwound.`);
          }
        }
      }

    // ── ETH loops ────────────────────────────────────────────────────────────
    } else {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk } = ethPrices!;

      // ETHSOL on Kraken: ETH=base, SOL=quote.
      //   "buy"  ETHSOL → buy ETH, pay SOL  — vol_exec=ETH acquired, cost+fee=SOL spent
      //   "sell" ETHSOL → sell ETH, get SOL — vol_exec=ETH sold, cost-fee=SOL received

      if (loop === "USD→SOL→ETH→USD") {
        // USD → buy SOL → buy ETH (pay SOL) → sell ETH for USD
        const plannedSolAmt = leg1Vol;
        const plannedEthAmt = leg2Vol;

        // Leg 1: buy SOL with USD (SOLUSD buy: vol_exec=SOL, cost=USD)
        let actualSolAmt = plannedSolAmt;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedSolAmt, solAsk, "SOLUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedSolAmt,         "SOLUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 SOL buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "SOLUSD", `sell ${f1.volExec.toFixed(8)} SOL partial leg1`, log);
            throw new Error(`Leg 1 SOL buy timed out. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} SOL unwound.` : "No fill."}`);
          }
          actualSolAmt = f1.volExec;
        }

        // Leg 2: buy ETH on ETHSOL (pay SOL, receive ETH)
        // ETHSOL buy: vol_exec=ETH acquired, cost+fee=SOL spent
        const leg2EthAmt = useLimit ? actualSolAmt / ethSolAsk : plannedEthAmt;
        let actualEthAmt = leg2EthAmt;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", leg2EthAmt, ethSolAsk, "ETHSOL")
            : await krakenRawMarketOrder(creds, "buy", leg2EthAmt,            "ETHSOL");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt, "SOLUSD", "sell SOL (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 ETH buy", log);
          if (!f2.filled) {
            // ETHSOL buy: vol_exec=ETH acquired, cost+fee=SOL consumed
            const solConsumed = f2.cost + f2.fee;
            const solRemaining = Math.max(0, actualSolAmt - solConsumed);
            if (f2.volExec > 0) await tryUnwindMarket(creds, "sell", f2.volExec, "XETHZUSD", `sell ${f2.volExec.toFixed(8)} ETH partial leg2`, log);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD",  `sell ${solRemaining.toFixed(8)} SOL remaining leg1`, log);
            throw new Error(`Leg 2 ETH buy timed out. ETH ${f2.volExec.toFixed(8)} + SOL ${solRemaining.toFixed(8)} unwound.`);
          }
          actualEthAmt = f2.volExec;
        }

        // Leg 3: sell ETH for USD (XETHZUSD sell: vol_exec=ETH sold, cost=USD received)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualEthAmt, ethBid, "XETHZUSD")
            : await krakenRawMarketOrder(creds, "sell", actualEthAmt,         "XETHZUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualEthAmt, "XETHZUSD", "sell ETH for USD (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (ETH unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 ETH sell", log);
          if (!f3.filled) {
            const ethRemaining = Math.max(0, actualEthAmt - f3.volExec);
            if (ethRemaining > 0) await tryUnwindMarket(creds, "sell", ethRemaining, "XETHZUSD", `sell ${ethRemaining.toFixed(8)} ETH remaining leg3`, log);
            throw new Error(`Leg 3 ETH sell timed out. ${ethRemaining.toFixed(8)} ETH remaining unwound.`);
          }
        }

      } else {
        // USD→ETH→SOL→USD
        // USD → buy ETH → sell ETH for SOL → sell SOL for USD
        //
        // ETHSOL sell: vol_exec=ETH sold, cost-fee=SOL received
        const plannedEthAmt2 = leg1Vol;
        const plannedSolAmt2 = leg2Vol;

        // Leg 1: buy ETH with USD (XETHZUSD buy: vol_exec=ETH, cost=USD)
        let actualEthAmt2 = plannedEthAmt2;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedEthAmt2, ethAsk, "XETHZUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedEthAmt2,         "XETHZUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 ETH buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "XETHZUSD", `sell ${f1.volExec.toFixed(8)} ETH partial leg1`, log);
            throw new Error(`Leg 1 ETH buy timed out. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} ETH unwound.` : "No fill."}`);
          }
          actualEthAmt2 = f1.volExec;
        }

        // Leg 2: sell ETH on ETHSOL (receive SOL)
        // ETHSOL sell: vol_exec=ETH sold, cost-fee=SOL received
        let actualSolAmt2 = useLimit ? actualEthAmt2 * ethSolBid : plannedSolAmt2;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualEthAmt2, ethSolBid, "ETHSOL")
            : await krakenRawMarketOrder(creds, "sell", actualEthAmt2,            "ETHSOL");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualEthAmt2, "XETHZUSD", "sell ETH (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 ETH sell", log);
          if (!f2.filled) {
            // ETHSOL sell: vol_exec=ETH sold, cost-fee=SOL received
            const solAcquired = Math.max(0, f2.cost - f2.fee);
            const ethRemaining = Math.max(0, actualEthAmt2 - f2.volExec);
            if (ethRemaining > 0) await tryUnwindMarket(creds, "sell", ethRemaining, "XETHZUSD", `sell ${ethRemaining.toFixed(8)} ETH remaining leg2`, log);
            if (solAcquired > 0) await tryUnwindMarket(creds, "sell", solAcquired,   "SOLUSD",   `sell ${solAcquired.toFixed(8)} SOL partial leg2`, log);
            throw new Error(`Leg 2 ETH sell timed out. ETH ${ethRemaining.toFixed(8)} + SOL ${solAcquired.toFixed(8)} unwound.`);
          }
          actualSolAmt2 = Math.max(0, f2.cost - f2.fee); // actual SOL received
        }

        // Leg 3: sell SOL for USD (SOLUSD sell: vol_exec=SOL sold, cost=USD received)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualSolAmt2, solBid, "SOLUSD")
            : await krakenRawMarketOrder(creds, "sell", actualSolAmt2,         "SOLUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt2, "SOLUSD", "sell SOL (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (SOL unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 SOL sell", log);
          if (!f3.filled) {
            const solRemaining = Math.max(0, actualSolAmt2 - f3.volExec);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD", `sell ${solRemaining.toFixed(8)} SOL remaining leg3`, log);
            throw new Error(`Leg 3 SOL sell timed out. ${solRemaining.toFixed(8)} SOL remaining unwound.`);
          }
        }
      }
    }

    const triPriceSource = isBtc ? "direct" : ethSolSource;
    req.log.info({ loop, tradeUsd, estimatedProfitUsd, orderType, triPriceSource, leg1Id, leg2Id, leg3Id }, "Triangular executed");
    res.json({
      success: true, isDryRun: false, estimatedProfitUsd,
      priceSource: triPriceSource, synthetic: triPriceSource === "synthetic",
      leg1OrderId: leg1Id, leg2OrderId: leg2Id, leg3OrderId: leg3Id,
    });
  } catch (err) {
    req.log.error({ err, loop, orderType, leg1Id, leg2Id }, "Triangular execution error — partial state logged");
    res.status(500).json({ error: (err as Error).message, leg1OrderId: leg1Id || null, leg2OrderId: leg2Id || null });
  }
});

// ── GET /credentials/preloaded ────────────────────────────────────────────────
router.get("/credentials/preloaded", async (_req, res): Promise<void> => {
  const krakenKey = process.env["KRAKEN_API_KEY"] ?? "";
  const krakenSecret = process.env["KRAKEN_SECRET"] ?? "";
  const coinbaseKey = process.env["COINBASE_API_KEY"] ?? "";
  const coinbaseSecret = process.env["COINBASE_SECRET"] ?? "";
  const anyLoaded = !!(krakenKey || krakenSecret || coinbaseKey || coinbaseSecret);
  res.json({ krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, anyLoaded });
});

// ── POST /prices ──────────────────────────────────────────────────────────────
// Scans all 10 pairs and returns the best cross-exchange opportunity.
router.post("/prices", async (req, res): Promise<void> => {
  const parsed = FetchPricesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const enabledPairs = parsed.data.enabledPairs;
    const prices = await getBestPairPrices(enabledPairs);

    if (!prices) {
      res.status(500).json({ error: "Could not fetch prices from Kraken or Coinbase for any pair" });
      return;
    }

    const {
      pair,
      kraken: krakenMid, krakenBid, krakenAsk,
      coinbase: coinbaseMid, coinbaseBid, coinbaseAsk,
      binance: binancePrice, kucoin: kuCoinPrice,
      wsKraken, wsCoinbase,
    } = prices;

    const krakenPrice   = krakenMid;
    const coinbasePrice = coinbaseMid;

    if (!krakenMid || !coinbaseMid) {
      res.status(500).json({ error: `Could not fetch prices from Kraken or Coinbase for ${pair}` });
      return;
    }

    const kAsk = krakenAsk   ?? krakenMid;
    const kBid = krakenBid   ?? krakenMid;
    const cAsk = coinbaseAsk ?? coinbaseMid;
    const cBid = coinbaseBid ?? coinbaseMid;

    // Route 1: buy at Kraken ask, sell at Coinbase bid
    const kToCPct = ((cBid - kAsk) / kAsk) * 100;
    // Route 2: buy at Coinbase ask, sell at Kraken bid
    const cToKPct = ((kBid - cAsk) / cAsk) * 100;

    const useKraken = kToCPct >= cToKPct;
    const bestBuyExchange  = useKraken ? "Kraken"   : "Coinbase";
    const bestSellExchange = useKraken ? "Coinbase" : "Kraken";
    const buyPrice         = useKraken ? kAsk       : cAsk;
    const sellPrice        = useKraken ? cBid       : kBid;

    const grossSpreadPct = useKraken ? kToCPct : cToKPct;
    const route = `Buy ${bestBuyExchange} → Sell ${bestSellExchange}`;

    req.log.info({ pair, krakenPrice, coinbasePrice, grossSpreadPct, bestBuyExchange, bestSellExchange }, "Prices fetched");

    res.json({
      pair,
      krakenPrice,
      krakenBid:   kBid,
      krakenAsk:   kAsk,
      coinbasePrice,
      coinbaseBid:  cBid,
      coinbaseAsk:  cAsk,
      binancePrice: binancePrice ?? null,
      kuCoinPrice:  kuCoinPrice  ?? null,
      grossSpreadPct,
      netEdgePct: grossSpreadPct,
      route,
      buyExchange: bestBuyExchange,
      sellExchange: bestSellExchange,
      bestBuyExchange,
      bestSellExchange,
      buyPrice,
      sellPrice,
      executable: true,
      wsStatus: { kraken: wsKraken, coinbase: wsCoinbase },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch prices");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /balances ────────────────────────────────────────────────────────────
router.post("/balances", async (req, res): Promise<void> => {
  const parsed = FetchBalancesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } = parsed.data;
  try {
    const [krakenBalances, coinbaseBalances, krakenPrice] = await Promise.all([
      getKrakenBalances({ krakenKey, krakenSecret }),
      getCoinbaseBalances({ coinbaseKey, coinbaseSecret }),
      getKrakenPrice("SOL/USD"),
    ]);

    const solOnKraken = krakenBalances.find(b => b.currency === "SOL" || b.currency === "SOL.S")?.amount ?? 0;
    const solOnCoinbase = coinbaseBalances.find(b => b.currency === "SOL")?.amount ?? 0;
    const usdOnCoinbase = coinbaseBalances.find(b => b.currency === "USD" || b.currency === "USDC")?.amount ?? 0;

    const maxSol = Math.min(solOnKraken, solOnCoinbase, krakenPrice > 0 ? usdOnCoinbase / krakenPrice : 0);
    const suggestedVolume = Math.max(maxSol * 0.8, 0.01);

    res.json({ kraken: krakenBalances, coinbase: coinbaseBalances, solOnKraken, solOnCoinbase, usdOnCoinbase, suggestedVolume });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch balances");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /test-kraken ─────────────────────────────────────────────────────────
router.post("/test-kraken", async (req, res): Promise<void> => {
  const parsed = TestKrakenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const balances = await getKrakenBalances(parsed.data);
    res.json({ ok: true, message: "Kraken connection successful", balances });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message, balances: [] });
  }
});

// ── POST /test-coinbase ───────────────────────────────────────────────────────
router.post("/test-coinbase", async (req, res): Promise<void> => {
  const parsed = TestCoinbaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const balances = await getCoinbaseBalances(parsed.data);
    res.json({ ok: true, message: "Coinbase connection successful", balances });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message, balances: [] });
  }
});

// ── POST /execute-trade ───────────────────────────────────────────────────────
router.post("/execute-trade", async (req, res): Promise<void> => {
  const parsed = ExecuteTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    krakenKey, krakenSecret, coinbaseKey, coinbaseSecret,
    buyExchange, sellExchange, volume, krakenPrice, coinbasePrice, liveMode, netEdgePct,
    orderType, pair: rawPair,
  } = parsed.data;

  // Validate pair strictly — reject unrecognised symbols before any order path
  if (rawPair !== undefined && !(PAIRS as readonly string[]).includes(rawPair)) {
    res.status(400).json({ error: `Unsupported pair "${rawPair}". Supported: ${PAIRS.join(", ")}` });
    return;
  }
  const pair: Pair = (rawPair as Pair | undefined) ?? "SOL/USD";
  const useLimit = orderType === "limit";

  const buyPrice = Math.min(krakenPrice, coinbasePrice);
  const estimatedProfitUsd = Math.max(0, ((netEdgePct ?? 0) / 100) * buyPrice * volume);

  const [countRow] = await db.select({ n: count() }).from(tradesTable);
  const tradeNumber = Number(countRow?.n ?? 0) + 1;

  if (!liveMode) {
    await db.insert(tradesTable).values({
      pair,
      buyExchange,
      sellExchange,
      volumeSol: String(volume),
      estimatedProfitUsd: String(estimatedProfitUsd.toFixed(6)),
      netEdgePct: String((netEdgePct ?? 0).toFixed(4)),
      isDryRun: true,
      krakenPrice: String(krakenPrice),
      coinbasePrice: String(coinbasePrice),
    });
    req.log.info({ tradeNumber, volume, estimatedProfitUsd, orderType: orderType ?? "market", pair }, "Dry run trade logged");
    res.json({ success: true, isDryRun: true, estimatedProfitUsd, tradeNumber, buyOrderId: null, sellOrderId: null, error: null });
    return;
  }

  // Live trade — pre-check balances before placing any orders
  // Use the correct base asset for the active pair (e.g. BTC for BTC/USD, not always SOL).
  try {
    const [krakenBalances, coinbaseBalances] = await Promise.all([
      getKrakenBalances({ krakenKey, krakenSecret }),
      getCoinbaseBalances({ coinbaseKey, coinbaseSecret }),
    ]);

    // Derive base asset from the pair (e.g. "BTC" from "BTC/USD")
    const baseAsset = pair.split("/")[0] ?? "SOL";

    // Kraken uses non-standard currency codes for some assets
    const krakenBaseVariants = (asset: string): string[] => {
      if (asset === "BTC") return ["XXBT", "XBT"];
      if (asset === "ETH") return ["XETH", "ETH"];
      if (asset === "SOL") return ["SOL", "SOL.S"];
      return [asset];
    };

    const baseOnKraken   = krakenBalances.find(b => krakenBaseVariants(baseAsset).includes(b.currency))?.amount ?? 0;
    const baseOnCoinbase = coinbaseBalances.find(b => b.currency === baseAsset)?.amount ?? 0;
    const usdOnKraken    = krakenBalances.find(b => ["ZUSD", "USD"].includes(b.currency))?.amount ?? 0;
    const usdOnCoinbase  = coinbaseBalances.find(b => ["USD", "USDC"].includes(b.currency))?.amount ?? 0;

    // Sell exchange must hold the base asset; buy exchange must hold USD
    const baseOnSellExchange = sellExchange === "Kraken" ? baseOnKraken   : baseOnCoinbase;
    const usdOnBuyExchange   = buyExchange  === "Kraken" ? usdOnKraken    : usdOnCoinbase;
    const buyPriceForPair    = Math.min(krakenPrice, coinbasePrice);

    // Require at least $5 notional worth of base asset on the sell side
    const minNotionalUsd = 5;
    const minBaseVolume  = buyPriceForPair > 0 ? minNotionalUsd / buyPriceForPair : 0;

    if (baseOnSellExchange < minBaseVolume || usdOnBuyExchange < minNotionalUsd) {
      const reason = `Trade skipped: insufficient ${baseAsset} balance on ${sellExchange} or USD on ${buyExchange}.`;
      req.log.warn({ baseAsset, baseOnSellExchange, usdOnBuyExchange, minBaseVolume, minNotionalUsd }, reason);
      res.json({ success: false, skipped: true, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: reason });
      return;
    }
  } catch (balErr) {
    req.log.warn({ err: balErr }, "Balance pre-check failed — proceeding with requested volume");
  }

  const ORDER_TIMEOUT_MS = 10_000;
  const withOrderTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Order timed out after ${ORDER_TIMEOUT_MS / 1000}s: ${label}`)), ORDER_TIMEOUT_MS)
    );
    return Promise.race([promise, timeout]);
  };

  let buyOrderId: string | null = null;
  let sellOrderId: string | null = null;

  const waitForFill = async (checkFilled: () => Promise<boolean>): Promise<boolean> => {
    const deadline = Date.now() + ORDER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await checkFilled()) return true;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  };

  try {
    const orderTime = Date.now();

    if (useLimit) {
      // ── Limit orders ─────────────────────────────────────────────────────
      if (buyExchange === "Kraken") {
        const r = await withOrderTimeout(krakenLimitOrder({ krakenKey, krakenSecret }, "buy", volume, krakenPrice, pair), "Kraken buy");
        buyOrderId = r.txid?.[0] ?? null;
      } else {
        const r = await withOrderTimeout(coinbaseLimitOrder({ coinbaseKey, coinbaseSecret }, "BUY", volume, coinbasePrice, pair), "Coinbase BUY");
        buyOrderId = r.orderId ?? null;
      }

      if (buyOrderId) {
        const checkFilled = buyExchange === "Kraken"
          ? () => krakenOrderFilled({ krakenKey, krakenSecret }, buyOrderId!)
          : () => coinbaseOrderFilled({ coinbaseKey, coinbaseSecret }, buyOrderId!);

        const filled = await waitForFill(checkFilled);

        if (!filled) {
          if (buyExchange === "Kraken")   await krakenCancelOrder({ krakenKey, krakenSecret }, buyOrderId).catch(() => {});
          else                             await coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, buyOrderId).catch(() => {});
          req.log.warn({ tradeNumber, buyOrderId }, "Buy limit not filled in time — cancelled, skipping sell");
          res.json({ success: false, skipped: true, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: "Buy limit order not filled — cancelled." });
          return;
        }
      }

      if (sellExchange === "Kraken") {
        const r = await withOrderTimeout(krakenLimitOrder({ krakenKey, krakenSecret }, "sell", volume, krakenPrice, pair), "Kraken sell");
        sellOrderId = r.txid?.[0] ?? null;
      } else {
        const r = await withOrderTimeout(coinbaseLimitOrder({ coinbaseKey, coinbaseSecret }, "SELL", volume, coinbasePrice, pair), "Coinbase SELL");
        sellOrderId = r.orderId ?? null;
      }
    } else {
      // ── Market orders ─────────────────────────────────────────────────────
      if (sellExchange === "Coinbase") {
        const sellResult = await withOrderTimeout(coinbaseMarketOrder({ coinbaseKey, coinbaseSecret }, "SELL", volume, coinbasePrice, pair), "Coinbase SELL");
        sellOrderId = sellResult.orderId ?? null;
        const buyResult = await withOrderTimeout(krakenMarketOrder({ krakenKey, krakenSecret }, "buy", volume, pair), "Kraken buy");
        buyOrderId = buyResult.txid?.[0] ?? null;
      } else {
        const sellResult = await withOrderTimeout(krakenMarketOrder({ krakenKey, krakenSecret }, "sell", volume, pair), "Kraken sell");
        sellOrderId = sellResult.txid?.[0] ?? null;
        const buyResult = await withOrderTimeout(coinbaseMarketOrder({ coinbaseKey, coinbaseSecret }, "BUY", volume, coinbasePrice, pair), "Coinbase BUY");
        buyOrderId = buyResult.orderId ?? null;
      }
    }

    // ── Record real profit for limit orders ─────────────────────────────────
    let recordedProfitUsd = estimatedProfitUsd;
    if (useLimit && sellOrderId) {
      const sellCheckFilled = sellExchange === "Kraken"
        ? () => krakenOrderFilled({ krakenKey, krakenSecret }, sellOrderId!)
        : () => coinbaseOrderFilled({ coinbaseKey, coinbaseSecret }, sellOrderId!);

      const sellFilled = await waitForFill(sellCheckFilled);

      if (sellFilled) {
        const [actualBuyPrice, actualSellPrice] = await Promise.all([
          buyExchange === "Kraken" && buyOrderId
            ? krakenFillPrice({ krakenKey, krakenSecret }, buyOrderId)
            : buyOrderId
              ? coinbaseFillPrice({ coinbaseKey, coinbaseSecret }, buyOrderId)
              : Promise.resolve(0),
          sellExchange === "Kraken" && sellOrderId
            ? krakenFillPrice({ krakenKey, krakenSecret }, sellOrderId)
            : sellOrderId
              ? coinbaseFillPrice({ coinbaseKey, coinbaseSecret }, sellOrderId)
              : Promise.resolve(0),
        ]);

        if (actualBuyPrice > 0 && actualSellPrice > 0) {
          recordedProfitUsd = (actualSellPrice - actualBuyPrice) * volume;
          req.log.info({ actualBuyPrice, actualSellPrice, recordedProfitUsd }, "Real profit recorded");
        }
      } else {
        if (sellExchange === "Kraken"  && sellOrderId) await krakenCancelOrder({ krakenKey, krakenSecret }, sellOrderId).catch(() => {});
        if (sellExchange === "Coinbase" && sellOrderId) await coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, sellOrderId).catch(() => {});
        req.log.warn({ tradeNumber, sellOrderId }, "Sell limit not filled in time — cancelled");
      }
    }

    await db.insert(tradesTable).values({
      pair,
      buyExchange,
      sellExchange,
      volumeSol: String(volume),
      estimatedProfitUsd: String(recordedProfitUsd.toFixed(6)),
      netEdgePct: String((netEdgePct ?? 0).toFixed(4)),
      isDryRun: false,
      krakenPrice: String(krakenPrice),
      coinbasePrice: String(coinbasePrice),
      buyOrderId,
      sellOrderId,
    });

    const orderElapsedMs = Date.now() - orderTime;
    req.log.info({ tradeNumber, pair, buyOrderId, sellOrderId, recordedProfitUsd, orderType: orderType ?? "market", orderElapsedMs }, "Live trade executed");
    res.json({ success: true, isDryRun: false, estimatedProfitUsd: recordedProfitUsd, tradeNumber, buyOrderId, sellOrderId, error: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const isTimeout = msg.startsWith("Order timed out after");
    if (isTimeout) {
      const timedOutExchange = msg.includes("Kraken") ? "Kraken" : msg.includes("Coinbase") ? "Coinbase" : "Exchange";
      req.log.warn({ err, tradeNumber, buyOrderId, sellOrderId }, `${timedOutExchange} timeout — cancelling any placed legs`);
      const cancelOps: Promise<void>[] = [];
      if (buyExchange === "Kraken"   && buyOrderId)  cancelOps.push(krakenCancelOrder({ krakenKey, krakenSecret }, buyOrderId).catch((e) => req.log.error({ e }, "Kraken cancel failed")));
      if (buyExchange === "Coinbase" && buyOrderId)  cancelOps.push(coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, buyOrderId).catch((e) => req.log.error({ e }, "Coinbase cancel failed")));
      if (sellExchange === "Kraken"  && sellOrderId) cancelOps.push(krakenCancelOrder({ krakenKey, krakenSecret }, sellOrderId).catch((e) => req.log.error({ e }, "Kraken cancel failed")));
      if (sellExchange === "Coinbase" && sellOrderId) cancelOps.push(coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, sellOrderId).catch((e) => req.log.error({ e }, "Coinbase cancel failed")));
      await Promise.allSettled(cancelOps);
      const timedOutExchange2 = msg.includes("Kraken") ? "Kraken" : msg.includes("Coinbase") ? "Coinbase" : "Exchange";
      res.status(500).json({ success: false, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: `${timedOutExchange2} timeout.` });
    } else {
      req.log.error({ err }, "Trade execution failed");
      res.status(500).json({ success: false, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: msg });
    }
  }
});

// ── GET /trades ───────────────────────────────────────────────────────────────
router.get("/trades", async (req, res): Promise<void> => {
  const parsed = ListTradesQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const offset = parsed.success ? (parsed.data.offset ?? 0) : 0;

  const trades = await db
    .select()
    .from(tradesTable)
    .orderBy(desc(tradesTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json(trades.map(t => ({
    ...t,
    pair: t.pair ?? "SOL/USD",
    volumeSol: parseFloat(t.volumeSol),
    estimatedProfitUsd: parseFloat(t.estimatedProfitUsd),
    netEdgePct: parseFloat(t.netEdgePct),
    krakenPrice: parseFloat(t.krakenPrice),
    coinbasePrice: parseFloat(t.coinbasePrice),
    createdAt: t.createdAt.toISOString(),
  })));
});

// ── GET /trades/summary ───────────────────────────────────────────────────────
router.get("/trades/summary", async (req, res): Promise<void> => {
  const [statsRow] = await db
    .select({
      totalTrades: count(),
      liveTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.isDryRun} = false)`,
      dryRunTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.isDryRun} = true)`,
      totalProfitUsd: sum(tradesTable.estimatedProfitUsd),
      avgNetEdgePct: avg(tradesTable.netEdgePct),
      bestTradeProfitUsd: max(tradesTable.estimatedProfitUsd),
    })
    .from(tradesTable);

  const recentTrades = await db
    .select()
    .from(tradesTable)
    .orderBy(desc(tradesTable.createdAt))
    .limit(5);

  res.json({
    totalTrades: Number(statsRow?.totalTrades ?? 0),
    liveTrades: Number(statsRow?.liveTrades ?? 0),
    dryRunTrades: Number(statsRow?.dryRunTrades ?? 0),
    totalProfitUsd: parseFloat(String(statsRow?.totalProfitUsd ?? 0)),
    avgNetEdgePct: parseFloat(String(statsRow?.avgNetEdgePct ?? 0)),
    bestTradeProfitUsd: parseFloat(String(statsRow?.bestTradeProfitUsd ?? 0)),
    recentTrades: recentTrades.map(t => ({
      ...t,
      pair: t.pair ?? "SOL/USD",
      volumeSol: parseFloat(t.volumeSol),
      estimatedProfitUsd: parseFloat(t.estimatedProfitUsd),
      netEdgePct: parseFloat(t.netEdgePct),
      krakenPrice: parseFloat(t.krakenPrice),
      coinbasePrice: parseFloat(t.coinbasePrice),
      createdAt: t.createdAt.toISOString(),
    })),
  });
});

// ── GET /arb/cointegration ─────────────────────────────────────────────────────
router.get("/arb/cointegration", async (_req, res): Promise<void> => {
  try {
    const now = new Date().toISOString();

    // Fetch prices for all relevant assets from the multi-pair cache in parallel
    const assetKeys = ["SOL/USD", "ETH/USD", "BTC/USD", "AVAX/USD", "DOT/USD"] as Pair[];
    const priceResults = await Promise.all(assetKeys.map(p => getPairPrices(p)));
    const priceMap = new Map<string, { mid: number | null }>();
    for (const pr of priceResults) {
      const mid = pr.kraken ?? pr.coinbase ?? pr.binance ?? pr.kucoin ?? null;
      priceMap.set(pr.pair, { mid });
    }

    const signals: Array<{
      pair: string; asset1: string; asset2: string;
      price1: number; price2: number;
      hedgeRatio: number; spread: number; zScore: number;
      direction: "long_asset1" | "short_asset1";
      edgePct: number; observations: number; timestamp: string;
    }> = [];

    for (const cfg of COINT_PAIRS) {
      const p1 = priceMap.get(cfg.asset1)?.mid;
      const p2 = priceMap.get(cfg.asset2)?.mid;
      if (!p1 || !p2 || p1 <= 0 || p2 <= 0) continue;

      // Get or create in-memory Kalman history for this pair
      if (!cointHistories.has(cfg.label)) {
        cointHistories.set(cfg.label, createPairHistory(p1, p2));
      }
      const history = cointHistories.get(cfg.label)!;

      const zScore = updatePairHistory(history, p1, p2);
      if (isNaN(zScore)) continue;  // not enough observations yet

      const absZ = Math.abs(zScore);
      if (absZ < COINT_Z_THRESHOLD) continue;

      // Edge estimate: use z-score magnitude scaled conservatively
      const edgePct = Math.min((absZ - COINT_Z_THRESHOLD) * 0.05 + 0.05, 0.50);

      // Direction: if spread is above mean (z > 0), asset1 is expensive → short it
      const direction: "long_asset1" | "short_asset1" = zScore < 0 ? "long_asset1" : "short_asset1";

      signals.push({
        pair: cfg.label,
        asset1: cfg.sym1,
        asset2: cfg.sym2,
        price1: p1,
        price2: p2,
        hedgeRatio: history.kalman.beta,
        spread: history.spreads[history.spreads.length - 1] ?? 0,
        zScore,
        direction,
        edgePct,
        observations: history.spreads.length,
        timestamp: now,
      });
    }

    res.json({ signals, scannedAt: now });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
