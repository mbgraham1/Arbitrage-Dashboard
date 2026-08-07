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
import { getBestPairPrices, getTriPrices, getBtcTriPrices, scanAllPairs, getPairPrices } from "../lib/price-cache";
import { scanOrderBookCycles, OB_USD_PAIRS, CROSS_LOOKUP } from "../lib/order-book";
import { createPairHistory, updatePairHistory, type PairHistory } from "../lib/kalman";

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

// ── GET /arb/scan — all 10 pairs ranked by gross spread ───────────────────────
router.get("/arb/scan", async (_req, res): Promise<void> => {
  try {
    const entries = await scanAllPairs();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/ob-scan ──────────────────────────────────────────────────────────
// Port of Python v15 "Order Book Hunter (Conservative)".
// Fetches L2 depth from Kraken, walks the book for all 30 triangular cycles,
// and classifies each with a READY / HIGH_SLIPPAGE / LOW_PROFIT status.
// Query params: tradeSizeUsd (default 10), feesPct (default 0.5),
//               minProfitUsd (default 0.01), maxSlippagePct (default 0.5)
router.get("/arb/ob-scan", async (req, res): Promise<void> => {
  const tradeSizeUsd   = Math.max(1, parseFloat(String(req.query["tradeSizeUsd"]   ?? "10"))   || 10);
  const feesPct        = Math.max(0, parseFloat(String(req.query["feesPct"]        ?? "0.5"))  || 0.5);
  const minProfitUsd   = Math.max(0, parseFloat(String(req.query["minProfitUsd"]   ?? "0.01")) || 0.01);
  const maxSlippagePct = Math.max(0, parseFloat(String(req.query["maxSlippagePct"] ?? "0.5"))  || 0.5);
  try {
    const result = await scanOrderBookCycles(tradeSizeUsd, feesPct, minProfitUsd, maxSlippagePct);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "OB scan error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/triangular ────────────────────────────────────────────────────────
router.get("/arb/triangular", async (_req, res): Promise<void> => {
  try {
    const tri = getTriPrices();
    const opportunities: TriOpp[] = [];
    const prices: Record<string, unknown> = {};

    if (tri.kraken) {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk } = tri.kraken;
      prices.kraken = { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk };
      opportunities.push(...computeTriLoops("Kraken", solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk));
    }

    if (tri.coinbase) {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk } = tri.coinbase;
      prices.coinbase = { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk };
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

    res.json({ opportunities, prices, scannedAt: new Date().toISOString() });
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
      ethPrices = {
        solBid: krakenTri.solBid, solAsk: krakenTri.solAsk,
        ethBid: krakenTri.ethBid, ethAsk: krakenTri.ethAsk,
        ethSolBid: krakenTri.ethSolBid, ethSolAsk: krakenTri.ethSolAsk,
      };
    } else {
      try {
        const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XETHZUSD,SOLUSD,ETHSOL", {
          signal: AbortSignal.timeout(5_000),
        });
        const data = await r.json() as { error?: string[]; result?: Record<string, { b: string[]; a: string[] }> };
        if (data.error?.length || !data.result) throw new Error("Kraken REST error");
        const res_ = data.result;
        const ethKey    = Object.keys(res_).find(k => k.includes("ETH") && k.includes("USD"));
        const solKey    = Object.keys(res_).find(k => k.startsWith("SOL") && k.endsWith("USD"));
        const ethSolKey = Object.keys(res_).find(k => k.includes("ETH") && k.includes("SOL"));
        if (!ethKey || !solKey || !ethSolKey) throw new Error("Missing ETH pairs in Kraken response");
        ethPrices = {
          ethBid:    parseFloat(res_[ethKey].b[0]),    ethAsk:    parseFloat(res_[ethKey].a[0]),
          solBid:    parseFloat(res_[solKey].b[0]),     solAsk:    parseFloat(res_[solKey].a[0]),
          ethSolBid: parseFloat(res_[ethSolKey].b[0]), ethSolAsk: parseFloat(res_[ethSolKey].a[0]),
        };
      } catch (e) {
        res.status(500).json({ error: `ETH tri prices unavailable: ${(e as Error).message}` });
        return;
      }
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
    req.log.info({ loop, tradeUsd, grossPct, estimatedProfitUsd, orderType }, "Triangular dry run");
    res.json({ success: true, isDryRun: true, estimatedProfitUsd, leg1OrderId: null, leg2OrderId: null, leg3OrderId: null });
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
      const btcAmt = leg1Vol;
      const solAmt = leg2Vol;

      if (loop === "USD→BTC→SOL→USD") {
        // Leg 1: buy BTC with USD
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy",  btcAmt, btcAsk,    "XXBTZUSD")
            : await krakenRawMarketOrder(creds, "buy",  btcAmt,            "XXBTZUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }

        // Leg 2: buy SOL with BTC
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "buy",  solAmt, solBtcAsk, "SOLXBT")
            : await krakenRawMarketOrder(creds, "buy",  solAmt,            "SOLXBT");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          // Unwind leg 1: cancel if limit, else sell BTC back
          if (useLimit) await tryCancel(creds, leg1Id, "leg1 BTC buy", log);
          else await tryUnwindMarket(creds, "sell", btcAmt, "XXBTZUSD", "sell BTC (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }

        // Leg 3: sell SOL for USD
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", solAmt, solBid,    "SOLUSD")
            : await krakenRawMarketOrder(creds, "sell", solAmt,            "SOLUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          // Unwind legs 1+2: sell acquired SOL back
          if (useLimit) {
            await tryCancel(creds, leg2Id, "leg2 SOL buy", log);
            await tryCancel(creds, leg1Id, "leg1 BTC buy", log);
          } else {
            await tryUnwindMarket(creds, "sell", solAmt, "SOLXBT", "sell SOL→BTC (unwind leg2)", log);
            await tryUnwindMarket(creds, "sell", btcAmt, "XXBTZUSD", "sell BTC (unwind leg1)", log);
          }
          throw new Error(`Leg 3 failed (legs 1+2 unwound): ${(e as Error).message}`);
        }
      } else {
        // USD→SOL→BTC→USD
        const solAmt2 = leg1Vol;  // SOL
        const btcAmt2 = leg2Vol;  // BTC

        // Leg 1: buy SOL with USD
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy",  solAmt2, solAsk,    "SOLUSD")
            : await krakenRawMarketOrder(creds, "buy",  solAmt2,            "SOLUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }

        // Leg 2: sell SOL for BTC
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", solAmt2, solBtcBid, "SOLXBT")
            : await krakenRawMarketOrder(creds, "sell", solAmt2,            "SOLXBT");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          if (useLimit) await tryCancel(creds, leg1Id, "leg1 SOL buy", log);
          else await tryUnwindMarket(creds, "sell", solAmt2, "SOLUSD", "sell SOL (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }

        // Leg 3: sell BTC for USD
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", btcAmt2, btcBid,    "XXBTZUSD")
            : await krakenRawMarketOrder(creds, "sell", btcAmt2,            "XXBTZUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          if (useLimit) {
            await tryCancel(creds, leg2Id, "leg2 SOL sell", log);
            await tryCancel(creds, leg1Id, "leg1 SOL buy", log);
          } else {
            await tryUnwindMarket(creds, "buy", solAmt2, "SOLXBT", "buy SOL back (unwind leg2)", log);
            await tryUnwindMarket(creds, "sell", solAmt2, "SOLUSD", "sell SOL (unwind leg1)", log);
          }
          throw new Error(`Leg 3 failed (legs 1+2 unwound): ${(e as Error).message}`);
        }
      }

    // ── ETH loops ────────────────────────────────────────────────────────────
    } else {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk } = ethPrices!;

      // ETHSOL on Kraken: ETH = base, SOL = quote.
      //   "buy"  ETHSOL → buy ETH (base), pay SOL  — volume in ETH
      //   "sell" ETHSOL → sell ETH (base), receive SOL — volume in ETH
      // ethSolAsk = SOL per ETH (ask: cost to buy 1 ETH)
      // ethSolBid = SOL per ETH (bid: proceeds from selling 1 ETH)

      if (loop === "USD→SOL→ETH→USD") {
        // USD → buy SOL → buy ETH (pay SOL) → sell ETH for USD
        const solAmt = leg1Vol;   // SOL purchased in leg 1
        const ethAmt = leg2Vol;   // ETH purchased in leg 2

        // Leg 1: buy SOL with USD
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy",  solAmt, solAsk, "SOLUSD")
            : await krakenRawMarketOrder(creds, "buy",  solAmt,         "SOLUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }

        // Leg 2: buy ETH on ETHSOL (pay SOL, receive ETH)
        //   Order side = "buy" (buying base currency ETH); volume = ethAmt (base)
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", ethAmt, ethSolAsk, "ETHSOL")
            : await krakenRawMarketOrder(creds, "buy", ethAmt,            "ETHSOL");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          // Unwind leg 1: still have SOL — sell it back for USD
          if (useLimit) await tryCancel(creds, leg1Id, "leg1 SOL buy", log);
          else await tryUnwindMarket(creds, "sell", solAmt, "SOLUSD", "sell SOL (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }

        // Leg 3: sell ETH for USD
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", ethAmt, ethBid, "XETHZUSD")
            : await krakenRawMarketOrder(creds, "sell", ethAmt,         "XETHZUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          // Unwind legs 1+2: have ETH — sell directly for USD (skip SOL leg, fewer slippage steps)
          if (useLimit) {
            await tryCancel(creds, leg2Id, "leg2 ETH buy", log);
            await tryCancel(creds, leg1Id, "leg1 SOL buy", log);
          } else {
            await tryUnwindMarket(creds, "sell", ethAmt, "XETHZUSD", "sell ETH for USD (unwind legs 1+2)", log);
          }
          throw new Error(`Leg 3 failed (legs 1+2 unwound): ${(e as Error).message}`);
        }

      } else {
        // USD→ETH→SOL→USD
        // USD → buy ETH → sell ETH for SOL → sell SOL for USD
        const ethAmt2 = leg1Vol;  // ETH purchased in leg 1
        const solAmt2 = leg2Vol;  // SOL received in leg 2

        // Leg 1: buy ETH with USD
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy",  ethAmt2, ethAsk, "XETHZUSD")
            : await krakenRawMarketOrder(creds, "buy",  ethAmt2,         "XETHZUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }

        // Leg 2: sell ETH on ETHSOL (receive SOL)
        //   Order side = "sell" (selling base currency ETH); volume = ethAmt2 (base)
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", ethAmt2, ethSolBid, "ETHSOL")
            : await krakenRawMarketOrder(creds, "sell", ethAmt2,            "ETHSOL");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          // Unwind leg 1: still have ETH — sell back for USD
          if (useLimit) await tryCancel(creds, leg1Id, "leg1 ETH buy", log);
          else await tryUnwindMarket(creds, "sell", ethAmt2, "XETHZUSD", "sell ETH (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }

        // Leg 3: sell SOL for USD
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", solAmt2, solBid, "SOLUSD")
            : await krakenRawMarketOrder(creds, "sell", solAmt2,         "SOLUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          // Unwind legs 1+2: have SOL — sell for USD
          if (useLimit) {
            await tryCancel(creds, leg2Id, "leg2 ETH sell", log);
            await tryCancel(creds, leg1Id, "leg1 ETH buy", log);
          } else {
            await tryUnwindMarket(creds, "sell", solAmt2, "SOLUSD", "sell SOL for USD (unwind legs 1+2)", log);
          }
          throw new Error(`Leg 3 failed (legs 1+2 unwound): ${(e as Error).message}`);
        }
      }
    }

    req.log.info({ loop, tradeUsd, estimatedProfitUsd, orderType, leg1Id, leg2Id, leg3Id }, "Triangular executed");
    res.json({ success: true, isDryRun: false, estimatedProfitUsd, leg1OrderId: leg1Id, leg2OrderId: leg2Id, leg3OrderId: leg3Id });
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
    const prices = await getBestPairPrices();

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
  try {
    const [krakenBalances, coinbaseBalances] = await Promise.all([
      getKrakenBalances({ krakenKey, krakenSecret }),
      getCoinbaseBalances({ coinbaseKey, coinbaseSecret }),
    ]);
    const solOnKraken  = krakenBalances.find(b => b.currency === "SOL" || b.currency === "SOL.S")?.amount ?? 0;
    const solOnCoinbase = coinbaseBalances.find(b => b.currency === "SOL")?.amount ?? 0;
    const usdOnCoinbase = coinbaseBalances.find(b => b.currency === "USD" || b.currency === "USDC")?.amount ?? 0;
    const MAX_SOL = 1.0;
    const maxSol = Math.min(solOnKraken, solOnCoinbase, krakenPrice > 0 ? usdOnCoinbase / krakenPrice : 0, MAX_SOL / 0.8) * 0.8;

    if (maxSol < 0.05) {
      const reason = maxSol <= 0.01 ? "Trade skipped: insufficient balance." : "Trade skipped: volume too small.";
      req.log.warn({ solOnKraken, solOnCoinbase, usdOnCoinbase, maxSol }, reason);
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
