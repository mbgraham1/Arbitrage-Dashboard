import { Router, type IRouter } from "express";
import { desc, sql, sum, count, max, avg } from "drizzle-orm";
import { db, tradesTable } from "@workspace/db";
import {
  FetchPricesBody,
  FetchBalancesBody,
  TestKrakenBody,
  TestCoinbaseBody,
  ExecuteTradeBody,
  ListTradesQueryParams,
} from "@workspace/api-zod";
import {
  getKrakenPrice,
  getKrakenBalances,
  krakenMarketOrder,
  krakenLimitOrder,
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
import { getBestPairPrices, getTriPrices, scanAllPairs } from "../lib/price-cache";

// ── Triangular arb helpers ─────────────────────────────────────────────────────

const TRI_FEE_PER_LEG = 0.0026;   // 0.26% taker fee per leg (conservative)
const TRI_MIN_PROFIT_PCT = 0.10;  // minimum net profit % to surface an opportunity

interface TriOpp {
  exchange: string;
  loop: string;
  profitPct: number;
  solUsd: number;
  ethUsd: number;
  ethSol: number;
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

    res.json({ opportunities, prices, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
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

export default router;
