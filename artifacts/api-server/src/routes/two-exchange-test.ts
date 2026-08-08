/**
 * TWO-EXCHANGE TEST — standalone one-shot diagnostic.
 *
 * Completely separate from the triangular/graph/cross-mm arbitrage code: it
 * imports only the shared exchange helpers and the DB, and NOTHING from
 * routes/arb.ts. One manual cycle per call, size hard-capped at $10, never
 * loops, never auto-scales.
 *
 * Flow:
 *   1. Verify BOTH venues' balances and credentials BEFORE any order:
 *      Kraken needs USD for the buy; Coinbase needs pre-positioned ETH for
 *      the sell. Any shortfall → no order placed, blocking reason returned.
 *   2. LIVE: market-buy ~$10 of ETH on Kraken (fee in quote, so cost/fee are
 *      exact USD), poll to a terminal state, take vol_exec as the ONLY truth.
 *   3. Sell the CONFIRMED filled quantity on Coinbase as a bounded IOC limit
 *      (exact base size, 0.5% price collar below the live bid — behaves like
 *      a taker but can never fill at a garbage price).
 *   4. Record exact fills, fees, order ids, timestamps, and realized P&L
 *      ((CB proceeds − CB fees) − (Kraken cost + Kraken fees)) to the trades
 *      ledger under the pair prefix "2XTEST:".
 */
import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { RunTwoExchangeTestBody } from "@workspace/api-zod";
import {
  getKrakenBidAsk,
  getCoinbaseBidAsk,
  getKrakenBalances,
  krakenRawMarketOrder,
  krakenOrderInfo,
  coinbaseIocLimitOrder,
  coinbaseOrderDetails,
  getCoinbaseProductIncrements,
  getCoinbaseAssetDetail,
  quantizeDown,
} from "../lib/exchange";

const router: IRouter = Router();

const PAIR_KRAKEN = "XETHZUSD"; // Kraken raw pair for ETH/USD
const POLL_MS = 700;
const TERMINAL_WAIT_MS = 25_000;

type Leg = {
  exchange: string; side: string; orderId: string | null; status: string | null;
  filledQty: number | null; avgPrice: number | null; notionalUsd: number | null;
  feeUsd: number | null; placedAt: string | null; terminalAt: string | null; error: string | null;
};

// One-shot guard: refuse concurrent runs of this diagnostic.
let testInFlight = false;

router.post("/arb/two-exchange-test", async (req, res): Promise<void> => {
  const parsed = RunTwoExchangeTestBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  const isDryRun = b.isDryRun ?? true;
  const sizeUsd = Math.min(10, Math.max(1, b.sizeUsd ?? 10)); // HARD $10 cap — diagnostic only
  const startedAt = new Date().toISOString();
  const kCreds = { krakenKey: b.krakenKey, krakenSecret: b.krakenSecret };
  const cbCreds = { coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret };

  let balancesSeen: {
    krakenUsd: number; coinbaseEth: number; coinbaseEthStaked: number; coinbaseEthHold: number; coinbaseEthTotal: number;
    coinbaseEthAccounts: Array<{ currency: string; name: string | null; type: string | null; available: number; hold: number; staked: boolean }>;
    coinbaseAccountsScanned: number;
    coinbaseUsd: number; krakenEth: number;
  } | null = null;
  const blocked = (reason: string) => {
    res.json({ success: false, isDryRun, outcome: "blocked", blockReason: reason, balances: balancesSeen, buyLeg: null, sellLeg: null, realizedProfitUsd: null, residualEthOpen: null, startedAt, finishedAt: new Date().toISOString(), error: null });
  };

  if (!b.krakenKey || !b.krakenSecret) { blocked("Kraken API credentials missing."); return; }
  if (!b.coinbaseKey || !b.coinbaseSecret) { blocked("Coinbase API credentials missing."); return; }
  if (testInFlight) { blocked("A two-exchange test is already running — one at a time."); return; }
  testInFlight = true;
  try {
    // ── 1. Pre-flight: prices + balances on BOTH venues, no orders yet ──────
    let kAsk: number, cbBid: number;
    try {
      const [k, c] = await Promise.all([getKrakenBidAsk("ETH/USD"), getCoinbaseBidAsk("ETH/USD")]);
      kAsk = k.ask; cbBid = c.bid;
      if (!(kAsk > 0) || !(cbBid > 0)) throw new Error("zero/invalid quotes");
    } catch (e) {
      blocked(`Could not fetch live ETH/USD quotes from both venues: ${(e as Error).message}`); return;
    }
    const estQty = sizeUsd / kAsk;
    let kUsd = 0, cbEth = 0;
    try {
      const [kBals, ethDetail, usdDetail] = await Promise.all([
        getKrakenBalances(kCreds, true),
        getCoinbaseAssetDetail(cbCreds, "ETH"),
        getCoinbaseAssetDetail(cbCreds, "USD"),
      ]);
      kUsd = kBals.filter(x => ["ZUSD", "USD"].includes(x.currency)).reduce((a, x) => a + x.amount, 0);
      // Kraken ETH (tradable) — needed for the REVERSE direction's sell leg.
      const kEth = kBals.filter(x => ["XETH", "ETH"].includes(x.currency)).reduce((a, x) => a + x.amount, 0);
      cbEth = ethDetail.available; // ONLY tradable ETH counts — staked/held ETH cannot fund a sell
      balancesSeen = {
        krakenUsd: kUsd, coinbaseEth: ethDetail.available, coinbaseEthStaked: ethDetail.staked,
        coinbaseEthHold: ethDetail.hold, coinbaseEthTotal: ethDetail.total,
        coinbaseEthAccounts: ethDetail.accounts, coinbaseAccountsScanned: ethDetail.accountsScanned,
        coinbaseUsd: usdDetail.available, krakenEth: kEth,
      };
      req.log.info({ eth: ethDetail, krakenUsd: kUsd }, "[2XTEST] balance check breakdown");
    } catch (e) {
      blocked(`Balance check failed (bad credentials or exchange error): ${(e as Error).message}`); return;
    }
    const needEth = estQty * 1.02; // cushion: a market buy can fill slightly more qty than the ask-based estimate
    if (kUsd < sizeUsd * 1.01) { blocked(`Insufficient USD on Kraken: need ~$${(sizeUsd * 1.01).toFixed(2)} incl. fees, have $${kUsd.toFixed(2)}.`); return; }
    if (cbEth < needEth) {
      const b = balancesSeen;
      const shortfall = needEth - cbEth;
      const stakedNote = b && b.coinbaseEthStaked > 0
        ? ` You hold ${b.coinbaseEthTotal.toFixed(8)} ETH total, but ${b.coinbaseEthStaked.toFixed(8)} is STAKED — staked ETH cannot be used for the sell leg until you unstake it (Coinbase unstaking can take hours to days).`
        : b && b.coinbaseEthHold > 0
          ? ` ${b.coinbaseEthHold.toFixed(8)} ETH is on hold (open orders or pending activity).`
          : b && b.coinbaseEthAccounts.length === 0
            ? ` The trading API found NO ETH account in the portfolio this API key can see (${b.coinbaseAccountsScanned} accounts scanned). Your ETH (and its staking) likely lives in a DIFFERENT Coinbase portfolio, or in staking that the trading API cannot see or sell. Either move/buy unstaked ETH in the portfolio this API key is scoped to, or create a key on the portfolio that holds the ETH.`
            : "";
      blocked(`Insufficient TRADABLE ETH on Coinbase: need ~${needEth.toFixed(8)} ETH (incl. 2% fill cushion), tradable is ${cbEth.toFixed(8)} — short by ${shortfall.toFixed(8)} ETH.${stakedNote} Only unstaked/tradable ETH counts. Fund with ~$${(sizeUsd + 1).toFixed(0)} of unstaked ETH to proceed.`);
      return;
    }

    if (isDryRun) {
      res.json({
        success: true, isDryRun, outcome: "dry_run_ok", blockReason: null, balances: balancesSeen,
        buyLeg: { exchange: "kraken", side: "buy", orderId: null, status: "not_placed", filledQty: estQty, avgPrice: kAsk, notionalUsd: sizeUsd, feeUsd: null, placedAt: null, terminalAt: null, error: null },
        sellLeg: { exchange: "coinbase", side: "sell", orderId: null, status: "not_placed", filledQty: estQty, avgPrice: cbBid, notionalUsd: estQty * cbBid, feeUsd: null, placedAt: null, terminalAt: null, error: null },
        realizedProfitUsd: null, residualEthOpen: null, startedAt, finishedAt: new Date().toISOString(),
        error: null,
      });
      return;
    }

    // ── 2. LIVE leg 1: Kraken market BUY ────────────────────────────────────
    const buyPlacedAt = new Date().toISOString();
    let buyTxid: string;
    try {
      const r = await krakenRawMarketOrder(kCreds, "buy", estQty, PAIR_KRAKEN);
      buyTxid = r.txid?.[0] ?? "";
      if (!buyTxid) throw new Error("Kraken returned no txid");
    } catch (e) {
      res.json({ success: false, isDryRun, outcome: "buy_failed", blockReason: null, balances: balancesSeen, buyLeg: { exchange: "kraken", side: "buy", orderId: null, status: "rejected", filledQty: 0, avgPrice: null, notionalUsd: null, feeUsd: null, placedAt: buyPlacedAt, terminalAt: new Date().toISOString(), error: (e as Error).message }, sellLeg: null, realizedProfitUsd: null, residualEthOpen: null, startedAt, finishedAt: new Date().toISOString(), error: `Kraken buy rejected — nothing was traded. ${(e as Error).message}` });
      return;
    }
    let info = { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
    const buyDeadline = Date.now() + TERMINAL_WAIT_MS;
    while (Date.now() < buyDeadline) {
      try { info = await krakenOrderInfo(kCreds, buyTxid); } catch { /* poll again */ }
      if (["closed", "canceled", "expired"].includes(info.status)) break;
      await new Promise(r => setTimeout(r, POLL_MS));
    }
    const buyTerminalAt = new Date().toISOString();
    const buyLeg: Leg = { exchange: "kraken", side: "buy", orderId: buyTxid, status: info.status, filledQty: info.volExec, avgPrice: info.price || null, notionalUsd: info.cost || null, feeUsd: info.fee || null, placedAt: buyPlacedAt, terminalAt: buyTerminalAt, error: null };
    if (!["closed", "canceled", "expired"].includes(info.status)) {
      // Market order not confirmed terminal — do NOT fire the sell against an unknown position.
      res.json({ success: false, isDryRun, outcome: "indeterminate", blockReason: null, balances: balancesSeen, buyLeg, sellLeg: null, realizedProfitUsd: null, residualEthOpen: info.volExec || null, startedAt, finishedAt: new Date().toISOString(), error: `Kraken order ${buyTxid} did not reach a terminal state within ${TERMINAL_WAIT_MS / 1000}s — check Kraken manually before selling anything. NOT selling on Coinbase.` });
      return;
    }
    const filledQty = info.volExec || 0;
    if (filledQty <= 1e-12) {
      res.json({ success: false, isDryRun, outcome: "buy_failed", blockReason: null, balances: balancesSeen, buyLeg, sellLeg: null, realizedProfitUsd: null, residualEthOpen: 0, startedAt, finishedAt: new Date().toISOString(), error: "Kraken buy reached a terminal state with zero fill — nothing was traded, nothing to sell." });
      return;
    }

    // ── 3. LIVE leg 2: Coinbase bounded IOC SELL of the CONFIRMED fill ──────
    // The sell target is the FULL confirmed Kraken fill, quantized to the
    // product's real base increment. If pre-positioned ETH can't cover it,
    // we sell what exists but the cycle is explicitly PARTIAL — never
    // silently shrunk into a "completed" result.
    const incs = await getCoinbaseProductIncrements("ETH/USD").catch(() => undefined);
    const qBase = (v: number) => incs ? quantizeDown(v, incs.baseIncrement).value : v;
    const targetQty = qBase(filledQty);            // full confirmed fill, exchange-quantized
    const sellQty = qBase(Math.min(filledQty, cbEth));
    const qtyTolerance = incs ? 2 * parseFloat(incs.baseIncrement) : 1e-6; // increment rounding only
    const inventoryShort = sellQty < targetQty - qtyTolerance;
    const sellPlacedAt = new Date().toISOString();
    let sellOrderId: string | null = null;
    let sell: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
    let sellError: string | null = null;
    try {
      const fresh = await getCoinbaseBidAsk("ETH/USD"); // re-quote at sell time
      const limitPx = fresh.bid * 0.995; // 0.5% collar — taker-like, price-bounded
      const r = await coinbaseIocLimitOrder(cbCreds, "SELL", sellQty, limitPx, "ETH/USD", incs);
      sellOrderId = r.orderId ?? null;
      if (!sellOrderId) throw new Error("Coinbase returned no order id");
      const sellDeadline = Date.now() + TERMINAL_WAIT_MS;
      while (Date.now() < sellDeadline) {
        try {
          const d = await coinbaseOrderDetails(cbCreds, sellOrderId);
          if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(d.status)) { sell = d; break; }
        } catch { /* poll again */ }
        await new Promise(r => setTimeout(r, POLL_MS));
      }
      if (!sell) sell = await coinbaseOrderDetails(cbCreds, sellOrderId);
    } catch (e) {
      sellError = (e as Error).message;
    }
    const sellTerminalAt = new Date().toISOString();
    const sellLeg: Leg = { exchange: "coinbase", side: "sell", orderId: sellOrderId, status: sell?.status ?? "failed", filledQty: sell?.filledSize ?? 0, avgPrice: sell?.avgPrice || null, notionalUsd: sell?.filledValue || null, feeUsd: sell?.totalFees ?? null, placedAt: sellPlacedAt, terminalAt: sellTerminalAt, error: sellError };

    const sellFilled = sell?.filledSize ?? 0;
    // "Completed" requires a terminal FILLED sell covering the FULL confirmed
    // Kraken fill within exchange-increment tolerance only — a Coinbase
    // inventory shortfall or any underfill is PARTIAL, with no realized P&L.
    const fullySold = !inventoryShort && sell?.status === "FILLED" && sellFilled >= targetQty - qtyTolerance;
    const realized = fullySold && sell ? (sell.filledValue - sell.totalFees) - (info.cost + info.fee) : null;
    const residual = Math.max(0, filledQty - sellFilled);
    const outcome = sellFilled <= 1e-12 ? "sell_failed" : fullySold ? "completed" : "partial_sell";

    // ── 4. Ledger row — separate "2XTEST:" prefix, never mixed with strategies ──
    try {
      await db.insert(tradesTable).values({
        pair: `2XTEST:ETH K-buy→CB-sell${outcome !== "completed" ? ` [${outcome}: residual ${residual.toFixed(8)} ETH]` : ""}`,
        buyExchange: "kraken", sellExchange: "coinbase",
        volume: filledQty.toFixed(8),
        estimatedProfitUsd: "0", netEdgePct: "0", isDryRun: false,
        krakenPrice: (info.price || 0).toFixed(8), coinbasePrice: (sell?.avgPrice ?? 0).toFixed(8),
        buyOrderId: buyTxid, sellOrderId,
        status: outcome === "completed" ? "verified" : "unhedged",
        realizedProfitUsd: realized != null ? realized.toFixed(6) : null,
      });
    } catch (e) {
      req.log.error({ err: e }, "[2XTEST] failed to write trades ledger row");
    }
    req.log.info({ buyTxid, sellOrderId, outcome, realized }, "[2XTEST] two-exchange test finished");
    res.json({
      success: outcome === "completed", isDryRun, outcome, blockReason: null, balances: balancesSeen, buyLeg, sellLeg,
      realizedProfitUsd: realized, residualEthOpen: residual > 1e-12 ? residual : 0,
      startedAt, finishedAt: new Date().toISOString(),
      error: outcome === "completed" ? null : outcome === "sell_failed"
        ? `Kraken buy FILLED ${filledQty.toFixed(8)} ETH but the Coinbase sell did not fill — you now hold that ETH on Kraken unsold. ${sellError ?? ""}`.trim()
        : `Coinbase sell filled ${sellFilled.toFixed(8)} of ${filledQty.toFixed(8)} ETH${inventoryShort ? " (pre-positioned ETH on Coinbase was short of the confirmed Kraken fill)" : ""} — residual ${residual.toFixed(8)} ETH remains long. P&L not realized.`,
    });
  } catch (err) {
    res.json({ success: false, isDryRun, outcome: "blocked", blockReason: (err as Error).message, buyLeg: null, sellLeg: null, realizedProfitUsd: null, residualEthOpen: null, startedAt, finishedAt: new Date().toISOString(), error: (err as Error).message });
  } finally {
    testInFlight = false;
  }
});

export default router;
