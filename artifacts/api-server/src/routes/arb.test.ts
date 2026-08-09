/**
 * Trade-ledger `volume` column regression tests (post volumeSol → volume rename).
 *
 * Verifies that every tradesTable insertion site in arb.ts records the
 * base-asset quantity actually traded — for BTC, ATOM, and SOL — and never
 * zero/NaN:
 *   1. POST /execute-trade dry-run  (cross-exchange)  — BTC, ATOM, SOL
 *   2. POST /execute-trade live     (cross-exchange, market orders) — ATOM
 *   3. POST /arb/graph-execute dry-run (cross-exchange route) — SOL
 *   4. POST /arb/graph-execute live taker (cross-exchange) — SOL, ACTUAL fill
 *   5. POST /arb/ob-execute dry-run (Kraken triangle) — ATOM
 *   6. POST /arb/execute-triangular live market (BTC loop) — BTC leg-1 volume
 *
 * All exchange + db modules are mocked; no live credentials are needed.
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ── Mock all external dependencies BEFORE importing the router ─────────────────

vi.mock("../lib/price-cache.js", () => ({
  getTriPrices:        vi.fn(() => ({ kraken: null, coinbase: null })),
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
  getKrakenBalances:        vi.fn(() => Promise.resolve([
    { currency: "ZUSD", amount: 10_000 },
    { currency: "XXBT", amount: 1 },
    { currency: "SOL",  amount: 100 },
    { currency: "ATOM", amount: 500 },
  ])),
  krakenCancelAllOrders:    vi.fn(() => Promise.resolve(0)),
  setPrivateCallHeartbeat:  vi.fn(),
  bindLockHeartbeat:        vi.fn(),
  runWithLockHeartbeat:     vi.fn((_hb: unknown, fn: () => unknown) => fn()),
  krakenMarketOrder:        vi.fn(),
  krakenLimitOrder:         vi.fn(),
  krakenRawMarketOrder:     vi.fn(),
  krakenRawLimitOrder:      vi.fn(),
  krakenRawIocLimitOrder:   vi.fn(),
  krakenOrderFilled:        vi.fn(),
  krakenOrderInfo:          vi.fn(),
  krakenTakerFeePct:        vi.fn(() => Promise.resolve(null)),
  krakenFeeTiers:           vi.fn(() => Promise.resolve(null)),
  krakenFillPrice:          vi.fn(),
  krakenCancelOrder:        vi.fn(),
  krakenAccountValueUsd:    vi.fn(() => Promise.resolve({ totalUsd: 1000, usdBalance: 1000, holdingsUsd: 0, holdings: [], unpriced: [] })),
  krakenNetCashFlowUsd:     vi.fn(() => Promise.resolve({ netUsd: 0, entries: 0, approximated: false, complete: true })),
  coinbaseAccountValueUsd:  vi.fn(() => Promise.resolve({ totalUsd: 0, usdBalance: 0, holdingsUsd: 0, unpriced: [] })),
  getCoinbaseBalances:      vi.fn(() => Promise.resolve([
    { currency: "USD",  amount: 10_000 },
    { currency: "BTC",  amount: 1 },
    { currency: "SOL",  amount: 100 },
    { currency: "ATOM", amount: 500 },
  ])),
  coinbaseMarketOrder:      vi.fn(),
  coinbaseLimitOrder:       vi.fn(),
  coinbaseOrderFilled:      vi.fn(),
  coinbaseOrderDetails:     vi.fn(),
  coinbaseFillPrice:        vi.fn(),
  coinbaseCancelOrder:      vi.fn(),
  getKrakenBidAsk:          vi.fn(() => Promise.resolve({ bid: 150, ask: 150.5, mid: 150.25 })),
  getCoinbaseBidAsk:        vi.fn(() => Promise.resolve({ bid: 150.4, ask: 150.9, mid: 150.65 })),
  getCoinbaseProductIncrements: vi.fn(() => Promise.resolve({ baseIncrement: "0.00000001", quoteIncrement: "0.01" })),
  quantizeDown: (value: number, increment: string) => {
    const inc = parseFloat(increment);
    const norm = increment.includes(".") ? increment.replace(/0+$/, "").replace(/\.$/, "") : increment;
    const decimals = (norm.split(".")[1] ?? "").length;
    const text = (Math.floor(value / inc + 1e-9) * inc).toFixed(decimals);
    return { value: parseFloat(text), text };
  },
  PAIRS: ["SOL/USD", "BTC/USD", "ETH/USD", "ATOM/USD"] as string[],
}));

// db mock that RECORDS every insert's table + values so tests can assert the
// exact `volume` string written to the trades ledger.
vi.mock("@workspace/db", () => {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const makeChain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const f of ["from", "where", "orderBy", "limit", "offset", "groupBy", "values", "set", "returning", "leftJoin", "innerJoin", "onConflictDoNothing", "onConflictDoUpdate"]) {
      c[f] = vi.fn(() => c);
    }
    (c as { then: unknown }).then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return c;
  };
  const tradesTable = { __name: "trades" };
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
    tradesTable,
    triScanTable: { __name: "tri_scan" },
    executionQualityTable: { __name: "execution_quality" },
    accountSnapshotsTable: { __name: "account_snapshots" },
    __inserts: inserts,
  };
});

vi.mock("../lib/order-book.js", () => ({
  scanOrderBookCycles: vi.fn(() => Promise.resolve({ cycles: [] })),
  preflightObCycle:    vi.fn(),
  discoverCrossPairs:  vi.fn(() => Promise.resolve({ lookup: new Map(), crossMap: [], cachedAt: 0 })),
  freshJoinPrice:      vi.fn(),
  makerQuote:          vi.fn(),
  waitForBookTouch:    vi.fn(() => Promise.resolve(false)),
  formatLegAges:       vi.fn(() => "legs"),
  OB_ASSETS:           ["BTC", "ETH", "SOL", "ATOM"] as string[],
  OB_USD_PAIRS:        { BTC: "XXBTZUSD", ETH: "XETHZUSD", SOL: "SOLUSD", ATOM: "ATOMUSD" } as Record<string, string>,
  CROSS_LOOKUP:        new Map(),
}));

// Fresh, profitable, depth-walked cross breakdown: the executor-grade cross
// pre-fire requires live stream books on both venues before any order.
vi.mock("../lib/cross-pricing.js", () => ({
  crossTakerBreakdownRest: vi.fn(() => Promise.resolve(null)),
  crossTakerBreakdown: vi.fn(() => ({
    netProfitUsd: 0.05, rawEdgeUsd: 0.06, feesUsd: 0.01, slippageUsd: 0,
    baseQty: 0.0666,
    legDiag: [], legAges: [
      { pair: "SOLUSD[K]", ageMs: 10, recvAgeMs: 10 },
      { pair: "SOL-USD[C]", ageMs: 10, recvAgeMs: 10 },
    ],
    quoteAgeMs: 10, marketUpdateMs: 1_754_600_000_000,
  })),
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

import arbRouter from "./arb.js";
import * as dbModule from "@workspace/db";
import * as exchangeModule from "../lib/exchange.js";
import * as orderBookModule from "../lib/order-book.js";
import * as priceCacheModule from "../lib/price-cache.js";
import * as graphEngineModule from "../lib/graph-engine.js";

const inserts = (dbModule as unknown as { __inserts: Array<{ table: unknown; values: Record<string, unknown> }> }).__inserts;
const tradesTableMock = dbModule.tradesTable as unknown;
/** Rows written to the trades table since the last beforeEach reset. */
const tradeRows = () => inserts.filter(i => i.table === tradesTableMock).map(i => i.values as Record<string, string>);

const scanGraphOpportunities = graphEngineModule.scanGraphOpportunities as ReturnType<typeof vi.fn>;
const preflightObCycle       = orderBookModule.preflightObCycle       as ReturnType<typeof vi.fn>;
const discoverCrossPairs     = orderBookModule.discoverCrossPairs     as ReturnType<typeof vi.fn>;
const getBtcTriPrices        = priceCacheModule.getBtcTriPrices       as ReturnType<typeof vi.fn>;
const krakenMarketOrder      = exchangeModule.krakenMarketOrder       as ReturnType<typeof vi.fn>;
const krakenRawMarketOrder   = exchangeModule.krakenRawMarketOrder    as ReturnType<typeof vi.fn>;
const krakenOrderInfo        = exchangeModule.krakenOrderInfo         as ReturnType<typeof vi.fn>;
const coinbaseMarketOrder    = exchangeModule.coinbaseMarketOrder     as ReturnType<typeof vi.fn>;
const coinbaseOrderDetails   = exchangeModule.coinbaseOrderDetails    as ReturnType<typeof vi.fn>;

// ── Test server ────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>)["log"] = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    next();
  });
  app.use(arbRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
});

async function post(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

const KEYS = { krakenKey: "k-key", krakenSecret: "k-secret", coinbaseKey: "cb-key", coinbaseSecret: "cb-secret" };

/** Common sanity: volume string parses to a finite, positive number. */
function expectVolume(row: Record<string, string>, expected: number) {
  const v = Number(row["volume"]);
  expect(Number.isFinite(v)).toBe(true);
  expect(v).toBeGreaterThan(0);
  expect(v).toBeCloseTo(expected, 8);
}

// ── 1. POST /execute-trade dry-run — BTC, ATOM, SOL ────────────────────────────

describe("POST /execute-trade (dry-run) records volume as the base-asset quantity", () => {
  const cases: Array<{ pair: string; volume: number; price: number }> = [
    { pair: "BTC/USD",  volume: 0.00123456, price: 50_000 },
    { pair: "ATOM/USD", volume: 2.5,        price: 8.5 },
    { pair: "SOL/USD",  volume: 0.05,       price: 150 },
  ];

  for (const c of cases) {
    it(`${c.pair}: stores volume ${c.volume} (base units)`, async () => {
      const { body } = await post("/execute-trade", {
        ...KEYS,
        buyExchange: "Kraken", sellExchange: "Coinbase",
        volume: c.volume, krakenPrice: c.price, coinbasePrice: c.price * 1.001,
        liveMode: false, netEdgePct: 0.1, pair: c.pair,
      });
      expect(body["success"]).toBe(true);
      const rows = tradeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!["pair"]).toBe(c.pair);
      expect(rows[0]!["isDryRun"]).toBe(true);
      expectVolume(rows[0]!, c.volume);
    });
  }
});

// ── 2. POST /execute-trade live (market) — ATOM ────────────────────────────────

describe("POST /execute-trade (live, market) records volume as the base-asset quantity", () => {
  it("ATOM/USD: stores the requested ATOM volume with both order ids", async () => {
    coinbaseMarketOrder.mockResolvedValue({ orderId: "CB-ATOM-1", success: true });
    krakenMarketOrder.mockResolvedValue({ txid: ["K-ATOM-1"] });

    const { body } = await post("/execute-trade", {
      ...KEYS,
      buyExchange: "Kraken", sellExchange: "Coinbase",
      volume: 2.5, krakenPrice: 8.5, coinbasePrice: 8.52,
      liveMode: true, netEdgePct: 0.2, pair: "ATOM/USD", orderType: "market",
    });
    expect(body["success"]).toBe(true);
    const rows = tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["pair"]).toBe("ATOM/USD");
    expect(rows[0]!["isDryRun"]).toBe(false);
    expect(rows[0]!["buyOrderId"]).toBe("K-ATOM-1");
    expect(rows[0]!["sellOrderId"]).toBe("CB-ATOM-1");
    expectVolume(rows[0]!, 2.5);
  });
});

// ── 3+4. POST /arb/graph-execute — cross-exchange SOL route ───────────────────

const SOL_PLANNED = 0.0666;
function solCrossRoute() {
  return {
    description: "kraken: buy SOL → coinbase: sell SOL (inventory)",
    hops: [
      { exchange: "kraken", side: "buy", from: "kraken:USD", to: "kraken:SOL", pair: "SOLUSD", limitPrice: 150.0, amountOut: SOL_PLANNED },
      { exchange: "bridge", side: "sell", from: "kraken:SOL", to: "coinbase:SOL", pair: null, limitPrice: 0, amountOut: SOL_PLANNED },
      { exchange: "coinbase", side: "sell", from: "coinbase:SOL", to: "coinbase:USD", pair: "SOL/USD", limitPrice: 150.6, amountOut: 10.03 },
    ],
    netProfitUsd: 0.05, profitPct: 0.5, slippagePct: 0, executable: true,
  };
}

describe("POST /arb/graph-execute records volume in base units (SOL)", () => {
  it("dry-run: stores the planned SOL quantity from the route's buy hop", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [solCrossRoute()] });
    const { body } = await post("/arb/graph-execute", { ...KEYS, tradeSizeUsd: 10, minProfitUsd: 0, isDryRun: true });
    expect(body["success"]).toBe(true);
    const rows = tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["isDryRun"]).toBe(true);
    expect(rows[0]!["volume"]).toBe(SOL_PLANNED.toFixed(8));
    expectVolume(rows[0]!, SOL_PLANNED);
  });

  it("live taker: stores the ACTUAL filled SOL volume, not the planned size", async () => {
    const ACTUAL_FILL = 0.06012345; // ≠ planned 0.0666 — proves actual fill is recorded
    scanGraphOpportunities.mockResolvedValue({ routes: [solCrossRoute()] });
    krakenRawMarketOrder.mockResolvedValue({ txid: ["K-BUY-1"] });
    krakenOrderInfo.mockResolvedValue({ status: "closed", volExec: ACTUAL_FILL, price: 150, cost: ACTUAL_FILL * 150, fee: 0.014 });
    coinbaseMarketOrder.mockResolvedValue({ orderId: "CB-SELL-1", success: true });
    coinbaseOrderDetails.mockResolvedValue({ status: "FILLED", filledSize: ACTUAL_FILL, filledValue: ACTUAL_FILL * 150.6, avgPrice: 150.6, totalFees: 0.03 });

    const { body } = await post("/arb/graph-execute", { ...KEYS, tradeSizeUsd: 10, minProfitUsd: 0, isDryRun: false, executionStyle: "taker" });
    expect(body["success"]).toBe(true);
    const rows = tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["isDryRun"]).toBe(false);
    expect(rows[0]!["volume"]).toBe(ACTUAL_FILL.toFixed(8));
    expect(rows[0]!["volume"]).not.toBe(SOL_PLANNED.toFixed(8));
    expectVolume(rows[0]!, ACTUAL_FILL);
  }, 30_000);
});

// ── 5. POST /arb/ob-execute dry-run — ATOM triangle ────────────────────────────

describe("POST /arb/ob-execute (dry-run) records volume as asset-A base quantity", () => {
  it("USD→ATOM→BTC→USD: stores pre-flight volumeA (ATOM)", async () => {
    const VOLUME_A = 12.34567891; // ATOM bought in leg 1
    discoverCrossPairs.mockResolvedValue({
      lookup: new Map([["ATOM-BTC", { pair: "ATOMXBT", base: "ATOM", quote: "BTC" }]]),
      crossMap: [], cachedAt: Date.now(),
    });
    // profitUsd must clear the maker-floor safeguard (2.5% of the $100 size).
    preflightObCycle.mockResolvedValue({
      volumeA: VOLUME_A, profitUsd: 5,
      legs: [
        { pair: "ATOMUSD", side: "buy",  volume: VOLUME_A },
        { pair: "ATOMXBT", side: "sell", volume: VOLUME_A },
        { pair: "XXBTZUSD", side: "sell", volume: 0.0002 },
      ],
    });

    const { body } = await post("/arb/ob-execute", { ...KEYS, assetA: "ATOM", assetB: "BTC", tradeSizeUsd: 100, isDryRun: true });
    expect(body["success"]).toBe(true);
    const rows = tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["pair"]).toBe("USD→ATOM→BTC→USD");
    expect(rows[0]!["isDryRun"]).toBe(true);
    expect(rows[0]!["volume"]).toBe(VOLUME_A.toFixed(8));
    expectVolume(rows[0]!, VOLUME_A);
  });
});

// ── 6. POST /arb/execute-triangular live (market) — BTC loop ───────────────────

describe("POST /arb/execute-triangular (live, market) records leg-1 base volume (BTC)", () => {
  it("USD→BTC→SOL→USD: stores tradeUsd/btcAsk BTC", async () => {
    const BTC_ASK = 50_000;
    getBtcTriPrices.mockReturnValue({
      solBid: 150, solAsk: 150.5,
      btcBid: 49_990, btcAsk: BTC_ASK,
      solBtcBid: 0.003, solBtcAsk: 0.00301,
    });
    krakenRawMarketOrder
      .mockResolvedValueOnce({ txid: ["TRI-L1"] })
      .mockResolvedValueOnce({ txid: ["TRI-L2"] })
      .mockResolvedValueOnce({ txid: ["TRI-L3"] });

    const { body } = await post("/arb/execute-triangular", {
      krakenKey: KEYS.krakenKey, krakenSecret: KEYS.krakenSecret,
      loop: "USD→BTC→SOL→USD", isDryRun: false, orderType: "market", tradeUsd: 10,
    });
    expect(body["success"]).toBe(true);
    const rows = tradeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["pair"]).toBe("USD→BTC→SOL→USD");
    expect(rows[0]!["buyOrderId"]).toBe("TRI-L1");
    // Volume is the leg-1 BTC quantity: 10 USD / 50,000 = 0.0002 BTC
    expect(rows[0]!["volume"]).toBe((10 / BTC_ASK).toFixed(8));
    expectVolume(rows[0]!, 0.0002);
  });
});
