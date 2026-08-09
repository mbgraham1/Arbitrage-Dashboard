/**
 * Legacy trade verification backfill (verifyLegacyTrades) — proof rules.
 *
 * The backfill may upgrade an "estimated" row to "verified" ONLY when both
 * order IDs are Kraken txids proving a genuine two-order USD round trip:
 * both orders closed, sides buy/sell, SAME pair, USD-quoted, matching
 * executed volumes. Everything else must stay "estimated":
 *   - multi-leg triangular routes (pair contains "→") — two orders can never
 *     prove the middle conversion leg
 *   - missing/unknown/Coinbase order IDs
 *   - partial fills (status != closed)
 *   - non-USD quotes, pair mismatches, volume mismatches
 * Credential/API errors from Kraken must PROPAGATE (fail-closed), never be
 * swallowed as "order not found".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/price-cache.js", () => ({
  getTriPrices:        vi.fn(() => null),
  getBtcTriPrices:     vi.fn(() => null),
  getBestPairPrices:   vi.fn(),
  scanAllPairs:        vi.fn(() => Promise.resolve([])),
  getPairPrices:       vi.fn(),
  getAllPairSnapshots: vi.fn(() => []),
  initPriceFeeds:      vi.fn(),
  PAIRS: [] as string[],
}));

vi.mock("../lib/exchange.js", () => ({
  getKrakenPrice:           vi.fn(),
  getKrakenBalances:        vi.fn(() => Promise.resolve([{ currency: "ZUSD", amount: 10_000 }])),
  krakenCancelAllOrders:    vi.fn(() => Promise.resolve(0)),
  setPrivateCallHeartbeat:  vi.fn(),
  bindLockHeartbeat:        vi.fn(),
  runWithLockHeartbeat:     vi.fn((_hb: unknown, fn: () => unknown) => fn()),
  krakenPairMeta:           vi.fn(() => Promise.resolve({ ordermin: 0, pairDecimals: 8, lotDecimals: 8 })),
  armLatencyProbe:          vi.fn(() => null),
  disarmLatencyProbe:       vi.fn(),
  getKrakenNonceHealth:     vi.fn(() => ({ suspected: false })),
  krakenMarketOrder:        vi.fn(),
  krakenLimitOrder:         vi.fn(),
  krakenRawMarketOrder:     vi.fn(),
  krakenRawLimitOrder:      vi.fn(),
  krakenRawIocLimitOrder:   vi.fn(),
  krakenOrderFilled:        vi.fn(),
  krakenOrderInfo:          vi.fn(),
  krakenOrdersDetail:      vi.fn(() => Promise.resolve(new Map())),
  krakenTakerFeePct:        vi.fn(() => Promise.resolve(null)),
  krakenFeeTiers:           vi.fn(() => Promise.resolve(null)),
  krakenFillPrice:          vi.fn(),
  krakenCancelOrder:        vi.fn(() => Promise.resolve(undefined)),
  krakenAccountValueUsd:    vi.fn(() => Promise.resolve({ totalUsd: 1000, usdBalance: 1000, holdingsUsd: 0, holdings: [], unpriced: [] })),
  krakenNetCashFlowUsd:     vi.fn(() => Promise.resolve({ netUsd: 0, entries: 0, approximated: false, complete: true })),
  coinbaseAccountValueUsd:  vi.fn(() => Promise.resolve({ totalUsd: 0, usdBalance: 0, holdingsUsd: 0, unpriced: [] })),
  getCoinbaseBalances:      vi.fn(() => Promise.resolve([])),
  coinbaseMarketOrder:      vi.fn(),
  coinbaseLimitOrder:       vi.fn(),
  coinbaseOrderFilled:      vi.fn(),
  coinbaseOrderDetails:     vi.fn(),
  coinbaseFillPrice:        vi.fn(),
  coinbaseCancelOrder:      vi.fn(),
  getKrakenBidAsk:          vi.fn(),
  getCoinbaseBidAsk:        vi.fn(),
  getCoinbaseProductIncrements: vi.fn(() => Promise.resolve({ baseIncrement: "0.00000001", quoteIncrement: "0.01" })),
  quantizeDown: (value: number, increment: string) => {
    const inc = parseFloat(increment);
    const norm = increment.includes(".") ? increment.replace(/0+$/, "").replace(/\.$/, "") : increment;
    const decimals = (norm.split(".")[1] ?? "").length;
    const text = (Math.floor(value / inc + 1e-9) * inc).toFixed(decimals);
    return { value: parseFloat(text), text };
  },
  PAIRS: ["SOL/USD"] as string[],
}));

vi.mock("@workspace/db", () => {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const selectRows: unknown[] = [];
  const makeChain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const f of ["from", "where", "orderBy", "limit", "offset", "groupBy", "values", "set", "returning", "leftJoin", "innerJoin", "onConflictDoNothing", "onConflictDoUpdate"]) {
      c[f] = vi.fn(() => c);
    }
    (c as { then: unknown }).then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve([...selectRows]).then(resolve, reject);
    return c;
  };
  return {
    db: {
      select: vi.fn(() => makeChain()),
      insert: vi.fn((table: unknown) => {
        const c = makeChain();
        c["values"] = vi.fn((v: unknown) => { inserts.push({ table, values: v }); return c; });
        return c;
      }),
      update: vi.fn(() => makeChain()),
      delete: vi.fn(() => makeChain()),
    },
    tradesTable: { __name: "trades" },
    triScanTable: { __name: "tri_scan" },
    executionQualityTable: { __name: "execution_quality" },
    accountSnapshotsTable: { __name: "account_snapshots" },
    __inserts: inserts,
    __selectRows: selectRows,
  };
});

vi.mock("../lib/order-book.js", () => ({
  scanOrderBookCycles: vi.fn(() => Promise.resolve({ cycles: [] })),
  preflightObCycle:    vi.fn(),
  discoverCrossPairs:  vi.fn(() => Promise.resolve({
    lookup: new Map([["ATOM-BTC", { pair: "ATOMXBT", aIsQuote: false }]]),
    crossMap: [], cachedAt: 1,
  })),
  freshJoinPrice:      vi.fn(() => Promise.resolve(null)),
  makerQuote:          vi.fn(() => Promise.resolve(null)),
  takerCycleBreakdown: vi.fn(() => Promise.resolve(null)),
  cachedTakerCycleBreakdown: vi.fn(() => Promise.resolve(null)),
  getEventScan:        vi.fn(() => null),
  krakenStreamStats:   vi.fn(() => ({})),
  getStreamBook:       vi.fn(() => null),
  waitForBookTouch:    vi.fn(() => Promise.resolve(null)),
  formatLegAges:       vi.fn(() => ""),
  OB_ASSETS:           ["BTC", "ETH", "SOL", "ATOM"] as string[],
  OB_USD_PAIRS:        { BTC: "XXBTZUSD", ETH: "XETHZUSD", SOL: "SOLUSD", ATOM: "ATOMUSD" } as Record<string, string>,
  CROSS_LOOKUP:        new Map(),
}));

vi.mock("../lib/graph-engine.js", () => ({
  scanGraphOpportunities: vi.fn(),
}));

vi.mock("../lib/kalman.js", () => ({
  createPairHistory: vi.fn(),
  updatePairHistory: vi.fn(),
}));

vi.mock("../lib/tri-fill.js", () => ({
  waitForTriLimitFill: vi.fn(),
}));

vi.mock("../lib/cross-pricing.js", () => ({
  crossTakerBreakdown: vi.fn(() => null),
  crossTakerBreakdownRest: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../lib/book-stream.js", () => ({
  coinbaseBookKey: vi.fn(() => ""),
  coinbaseStreamStats: vi.fn(() => ({})),
  getCoinbaseStreamBook: vi.fn(() => null),
  getGeminiStreamBook: vi.fn(() => null),
  startGeminiBookStream: vi.fn(),
  geminiStreamStats: vi.fn(() => ({ connected: false, books: 0, tracked: 0 })),
}));

vi.mock("../lib/gemini-exec.js", () => ({
  geminiSymbols: vi.fn(() => Promise.resolve([])),
  geminiSymbolDetails: vi.fn(() => Promise.reject(new Error("no gemini in test"))),
}));

vi.mock("../lib/gemini.js", () => ({
  geminiVerify: vi.fn(() => Promise.reject(new Error("no gemini in test"))),
}));

import { verifyLegacyTrades } from "./arb.js";
import * as dbModule from "@workspace/db";
import * as exchangeModule from "../lib/exchange.js";

const selectRows = (dbModule as unknown as { __selectRows: unknown[] }).__selectRows;
const dbUpdate = (dbModule as unknown as { db: { update: ReturnType<typeof vi.fn> } }).db.update;
const krakenOrdersDetail = exchangeModule.krakenOrdersDetail as ReturnType<typeof vi.fn>;

const CREDS = { krakenKey: "k", krakenSecret: "s" };

interface Detail {
  txid: string; status: string; pair: string; side: string;
  vol: number; volExec: number; price: number; cost: number; fee: number;
}
const order = (o: Partial<Detail> & { txid: string }): Detail => ({
  status: "closed", pair: "SOLUSD", side: "buy",
  vol: 1, volExec: 1, price: 100, cost: 100, fee: 0.25,
  ...o,
});
const detailMap = (...orders: Detail[]) => new Map(orders.map(o => [o.txid, o]));

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, pair: "SOL/USD", buyExchange: "kraken", sellExchange: "kraken",
  buyOrderId: "OAAAAA-BBBBB-CCCCCC", sellOrderId: "ODDDDD-EEEEE-FFFFFF",
  status: "estimated", isDryRun: false,
  ...over,
});

beforeEach(() => {
  selectRows.length = 0;
  krakenOrdersDetail.mockReset();
  krakenOrdersDetail.mockResolvedValue(new Map());
  dbUpdate.mockClear();
});

describe("verifyLegacyTrades", () => {
  it("verifies a genuine two-order USD round trip with fee-inclusive realized P&L", async () => {
    selectRows.push(row());
    krakenOrdersDetail.mockResolvedValue(detailMap(
      order({ txid: "OAAAAA-BBBBB-CCCCCC", side: "buy",  cost: 100, fee: 0.25 }),
      order({ txid: "ODDDDD-EEEEE-FFFFFF", side: "sell", cost: 102, fee: 0.26 }),
    ));
    const res = await verifyLegacyTrades(CREDS, false);
    expect(res.verified).toBe(1);
    expect(res.skipped).toBe(0);
    const d = res.details.find(x => x.id === 1)!;
    expect(d.outcome).toBe("verified");
    // spend = 100 + 0.25, proceeds = 102 − 0.26 → realized = 1.49
    expect(d.realizedProfitUsd).toBeCloseTo(1.49, 6);
    expect(dbUpdate).toHaveBeenCalledTimes(1);
  });

  it("dryRun reports what would verify but writes nothing", async () => {
    selectRows.push(row());
    krakenOrdersDetail.mockResolvedValue(detailMap(
      order({ txid: "OAAAAA-BBBBB-CCCCCC", side: "buy" }),
      order({ txid: "ODDDDD-EEEEE-FFFFFF", side: "sell", cost: 101 }),
    ));
    const res = await verifyLegacyTrades(CREDS, true);
    expect(res.verified).toBe(1);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("excludes multi-leg triangular routes outright — even with two closed same-pair USD orders", async () => {
    selectRows.push(row({ pair: "USD→ETH→SOL→USD" }));
    krakenOrdersDetail.mockResolvedValue(detailMap(
      order({ txid: "OAAAAA-BBBBB-CCCCCC", side: "buy" }),
      order({ txid: "ODDDDD-EEEEE-FFFFFF", side: "sell" }),
    ));
    const res = await verifyLegacyTrades(CREDS, false);
    expect(res.verified).toBe(0);
    expect(res.candidates).toBe(0);
    expect(res.details[0]!.reason).toMatch(/multi-leg route/);
    expect(dbUpdate).not.toHaveBeenCalled();
    expect(krakenOrdersDetail).not.toHaveBeenCalled();
  });

  it("skips rows with missing or non-Kraken (Coinbase UUID) order IDs", async () => {
    selectRows.push(
      row({ id: 1, sellOrderId: null }),
      row({ id: 2, buyOrderId: "64cdb619-4fe5-4c4d-88ce-ea7344b969d2" }),
    );
    const res = await verifyLegacyTrades(CREDS, false);
    expect(res.verified).toBe(0);
    expect(res.details.find(d => d.id === 1)!.reason).toMatch(/missing order id/);
    expect(res.details.find(d => d.id === 2)!.reason).toMatch(/non-Kraken order id/);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("skips orders missing from Kraken history and partial fills (not closed)", async () => {
    selectRows.push(row({ id: 1 }), row({ id: 2, buyOrderId: "OGGGGG-HHHHH-IIIIII", sellOrderId: "OJJJJJ-KKKKK-LLLLLL" }));
    krakenOrdersDetail.mockResolvedValue(detailMap(
      // row 1: buy leg absent entirely
      order({ txid: "ODDDDD-EEEEE-FFFFFF", side: "sell" }),
      // row 2: buy IOC-cancelled after a partial fill — NOT provable
      order({ txid: "OGGGGG-HHHHH-IIIIII", side: "buy", status: "canceled", volExec: 0.4, cost: 40 }),
      order({ txid: "OJJJJJ-KKKKK-LLLLLL", side: "sell" }),
    ));
    const res = await verifyLegacyTrades(CREDS, false);
    expect(res.verified).toBe(0);
    expect(res.details.find(d => d.id === 1)!.reason).toMatch(/not found/);
    expect(res.details.find(d => d.id === 2)!.reason).toMatch(/not fully filled/);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("skips non-USD quotes, pair mismatches, and volume mismatches", async () => {
    selectRows.push(
      row({ id: 1 }),
      row({ id: 2, buyOrderId: "OGGGGG-HHHHH-IIIIII", sellOrderId: "OJJJJJ-KKKKK-LLLLLL" }),
      row({ id: 3, buyOrderId: "OMMMMM-NNNNN-OOOOOO", sellOrderId: "OPPPPP-QQQQQ-RRRRRR" }),
    );
    krakenOrdersDetail.mockResolvedValue(detailMap(
      // row 1: ETH/BTC quote — realized quote units are NOT USD
      order({ txid: "OAAAAA-BBBBB-CCCCCC", side: "buy",  pair: "XETHXXBT" }),
      order({ txid: "ODDDDD-EEEEE-FFFFFF", side: "sell", pair: "XETHXXBT" }),
      // row 2: different pairs — part of a longer route
      order({ txid: "OGGGGG-HHHHH-IIIIII", side: "buy",  pair: "XETHZUSD" }),
      order({ txid: "OJJJJJ-KKKKK-LLLLLL", side: "sell", pair: "SOLUSD" }),
      // row 3: same pair but executed volumes differ >2%
      order({ txid: "OMMMMM-NNNNN-OOOOOO", side: "buy",  volExec: 1 }),
      order({ txid: "OPPPPP-QQQQQ-RRRRRR", side: "sell", volExec: 0.9 }),
    ));
    const res = await verifyLegacyTrades(CREDS, false);
    expect(res.verified).toBe(0);
    expect(res.details.find(d => d.id === 1)!.reason).toMatch(/non-USD quote/);
    expect(res.details.find(d => d.id === 2)!.reason).toMatch(/pair mismatch/);
    expect(res.details.find(d => d.id === 3)!.reason).toMatch(/volume mismatch/);
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("propagates credential/API errors instead of masquerading them as unproven rows", async () => {
    selectRows.push(row());
    krakenOrdersDetail.mockRejectedValue(new Error("Kraken: EAPI:Invalid key"));
    await expect(verifyLegacyTrades(CREDS, false)).rejects.toThrow(/Invalid key/);
    expect(dbUpdate).not.toHaveBeenCalled();
  });
});
