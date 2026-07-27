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
  krakenCancelOrder,
  getCoinbaseBalances,
  coinbaseMarketOrder,
  coinbaseLimitOrder,
  coinbaseCancelOrder,
} from "../lib/exchange";
import { getAllPrices } from "../lib/price-cache";

const router: IRouter = Router();

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
router.post("/prices", async (req, res): Promise<void> => {
  const parsed = FetchPricesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const prices = await getAllPrices();
    const { kraken: krakenMid, krakenBid, krakenAsk, coinbase: coinbaseMid, coinbaseBid, coinbaseAsk, binance: binancePrice, kucoin: kuCoinPrice, wsKraken, wsCoinbase } = prices;
    const krakenPrice   = krakenMid;   // alias for balance checks / order placement
    const coinbasePrice = coinbaseMid; // alias for balance checks / order placement

    if (!krakenMid || !coinbaseMid) {
      res.status(500).json({ error: "Could not fetch prices from Kraken or Coinbase" });
      return;
    }

    // Buy Kraken  = k_ask  (pay the ask to buy)
    // Sell Kraken = k_bid  (receive the bid when selling)
    // Buy Coinbase  = c_ask
    // Sell Coinbase = c_bid
    const kAsk = krakenAsk   ?? krakenMid;
    const kBid = krakenBid   ?? krakenMid;
    const cAsk = coinbaseAsk ?? coinbaseMid;
    const cBid = coinbaseBid ?? coinbaseMid;

    // Direction: cheaper ask = better buy side
    const krakenCheaperToBuy = kAsk < cAsk;
    const bestBuyExchange    = krakenCheaperToBuy ? "Kraken"   : "Coinbase";
    const bestSellExchange   = krakenCheaperToBuy ? "Coinbase" : "Kraken";
    const buyPrice  = krakenCheaperToBuy ? kAsk : cAsk;
    const sellPrice = krakenCheaperToBuy ? cBid : kBid;

    const grossSpreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
    const route = `Buy ${bestBuyExchange} → Sell ${bestSellExchange}`;

    req.log.info({ krakenPrice, coinbasePrice, grossSpreadPct, bestBuyExchange, bestSellExchange }, "Prices fetched");

    res.json({
      krakenPrice,
      coinbasePrice,
      binancePrice: binancePrice ?? null,   // reference only — not used for trading
      kuCoinPrice: kuCoinPrice ?? null,      // reference only — not used for trading
      grossSpreadPct,
      netEdgePct: grossSpreadPct,
      route,
      buyExchange: bestBuyExchange,
      sellExchange: bestSellExchange,
      bestBuyExchange,
      bestSellExchange,
      buyPrice,
      sellPrice,
      executable: true,                      // always executable — both sides are Kraken/Coinbase
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
      getKrakenPrice(),
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
    orderType,
  } = parsed.data;

  const useLimit = orderType === "limit";

  // Estimated net profit after fees + slippage, mirroring Python:
  //   gross_profit = (sell - buy) * vol
  //   estimated_fees  = buy * vol * (fees/100) + sell * vol * (fees/100)
  //   estimated_slippage = buy * vol * (slippage/100)
  //   estimated_net_profit = gross_profit - estimated_fees - estimated_slippage
  // netEdgePct = grossSpread% - totalFees% - slippage%, so:
  //   net_profit ≈ (netEdgePct / 100) * buyPrice * volume
  const buyPrice = Math.min(krakenPrice, coinbasePrice);
  const estimatedProfitUsd = Math.max(0, ((netEdgePct ?? 0) / 100) * buyPrice * volume);

  // Count trades to get trade number
  const [countRow] = await db.select({ n: count() }).from(tradesTable);
  const tradeNumber = Number(countRow?.n ?? 0) + 1;

  if (!liveMode) {
    // Dry run — just log it
    await db.insert(tradesTable).values({
      buyExchange,
      sellExchange,
      volumeSol: String(volume),
      estimatedProfitUsd: String(estimatedProfitUsd.toFixed(6)),
      netEdgePct: String((netEdgePct ?? 0).toFixed(4)),
      isDryRun: true,
      krakenPrice: String(krakenPrice),
      coinbasePrice: String(coinbasePrice),
    });
    req.log.info({ tradeNumber, volume, estimatedProfitUsd, orderType: orderType ?? "market" }, "Dry run trade logged");
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

  const ORDER_TIMEOUT_MS = 10_000; // 10 s — matches Python ORDER_TIMEOUT
  const withOrderTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Order timed out after ${ORDER_TIMEOUT_MS / 1000}s: ${label}`)), ORDER_TIMEOUT_MS)
    );
    return Promise.race([promise, timeout]);
  };

  // Hoisted so the catch block can cancel any partially-placed leg on timeout
  let buyOrderId: string | null = null;
  let sellOrderId: string | null = null;

  try {
    const orderTime = Date.now(); // mirrors Python's order_time = time.time()

    if (sellExchange === "Coinbase") {
      // Sell on Coinbase, buy on Kraken
      const sellResult = await withOrderTimeout(
        useLimit
          ? coinbaseLimitOrder({ coinbaseKey, coinbaseSecret }, "SELL", volume, coinbasePrice)
          : coinbaseMarketOrder({ coinbaseKey, coinbaseSecret }, "SELL", volume, coinbasePrice),
        "Coinbase SELL"
      );
      sellOrderId = sellResult.orderId ?? null;
      const buyResult = await withOrderTimeout(
        useLimit
          ? krakenLimitOrder({ krakenKey, krakenSecret }, "buy", volume, krakenPrice)
          : krakenMarketOrder({ krakenKey, krakenSecret }, "buy", volume),
        "Kraken buy"
      );
      buyOrderId = buyResult.txid?.[0] ?? null;
    } else {
      // Sell on Kraken, buy on Coinbase
      const sellResult = await withOrderTimeout(
        useLimit
          ? krakenLimitOrder({ krakenKey, krakenSecret }, "sell", volume, krakenPrice)
          : krakenMarketOrder({ krakenKey, krakenSecret }, "sell", volume),
        "Kraken sell"
      );
      sellOrderId = sellResult.txid?.[0] ?? null;
      const buyResult = await withOrderTimeout(
        useLimit
          ? coinbaseLimitOrder({ coinbaseKey, coinbaseSecret }, "BUY", volume, coinbasePrice)
          : coinbaseMarketOrder({ coinbaseKey, coinbaseSecret }, "BUY", volume, coinbasePrice),
        "Coinbase BUY"
      );
      buyOrderId = buyResult.orderId ?? null;
    }

    await db.insert(tradesTable).values({
      buyExchange,
      sellExchange,
      volumeSol: String(volume),
      estimatedProfitUsd: String(estimatedProfitUsd.toFixed(6)),
      netEdgePct: String((netEdgePct ?? 0).toFixed(4)),
      isDryRun: false,
      krakenPrice: String(krakenPrice),
      coinbasePrice: String(coinbasePrice),
      buyOrderId,
      sellOrderId,
    });

    const orderElapsedMs = Date.now() - orderTime;
    req.log.info({ tradeNumber, buyOrderId, sellOrderId, estimatedProfitUsd, orderType: orderType ?? "market", orderElapsedMs }, "Live trade executed");
    res.json({ success: true, isDryRun: false, estimatedProfitUsd, tradeNumber, buyOrderId, sellOrderId, error: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const isTimeout = msg.startsWith("Order timed out after");
    if (isTimeout) {
      const timedOutExchange = msg.includes("Kraken") ? "Kraken" : msg.includes("Coinbase") ? "Coinbase" : "Exchange";
      req.log.warn({ err, tradeNumber, buyOrderId, sellOrderId }, `${timedOutExchange} timeout — cancelling any placed legs`);
      const cancelOps: Promise<void>[] = [];
      if (buyExchange === "Kraken"  && buyOrderId)  cancelOps.push(krakenCancelOrder({ krakenKey, krakenSecret }, buyOrderId).catch((e) => req.log.error({ e }, "Kraken cancel failed")));
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
