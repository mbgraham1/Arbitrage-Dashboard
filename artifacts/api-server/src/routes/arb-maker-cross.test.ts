/**
 * Tests for LIVE maker execution of 2-leg cross-exchange inventory routes in
 * POST /arb/graph-execute (executionStyle="maker").
 *
 * Key assertions:
 * 1. Cancel-status outage (Kraken): when the maker order's cancel can never be
 *    confirmed terminal, the route errors EXPLICITLY with the resting order id,
 *    no hedge is placed, and ALL subsequent live execution stays blocked until
 *    that order is verified terminal.
 * 2. Coinbase indeterminate recovery: the gate demands Coinbase credentials to
 *    verify a Coinbase maker order and clears only on a confirmed terminal
 *    status.
 * 3. A PARTIAL maker fill hedges exactly the ACTUAL filled volume, never the
 *    planned size.
 * 4. A partial taker hedge fails the route and unwinds the residual — never
 *    reported as success with unhedged inventory.
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ── Mock all external dependencies BEFORE importing the router ─────────────────

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
  getKrakenBalances:        vi.fn(() => Promise.resolve([{ currency: "ZUSD", amount: 1000 }, { currency: "SOL", amount: 100 }])),
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
  krakenOrdersDetail:      vi.fn(() => Promise.resolve(new Map())),
  krakenTakerFeePct:        vi.fn(() => Promise.resolve(null)),
  krakenFeeTiers:           vi.fn(() => Promise.resolve(null)),
  krakenFillPrice:          vi.fn(),
  krakenCancelOrder:        vi.fn(),
  krakenAccountValueUsd:    vi.fn(() => Promise.resolve({ totalUsd: 1000, usdBalance: 1000, holdingsUsd: 0, holdings: [], unpriced: [] })),
  krakenNetCashFlowUsd:     vi.fn(() => Promise.resolve({ netUsd: 0, entries: 0, approximated: false, complete: true })),
  coinbaseAccountValueUsd:  vi.fn(() => Promise.resolve({ totalUsd: 0, usdBalance: 0, holdingsUsd: 0, unpriced: [] })),
  getCoinbaseBalances:      vi.fn(() => Promise.resolve([{ currency: "USD", amount: 1000 }, { currency: "SOL", amount: 100 }])),
  coinbaseMarketOrder:      vi.fn(),
  coinbaseLimitOrder:       vi.fn(),
  coinbaseOrderFilled:      vi.fn(),
  coinbaseOrderDetails:     vi.fn(),
  coinbaseFillPrice:        vi.fn(),
  coinbaseCancelOrder:      vi.fn(),
  getKrakenBidAsk:          vi.fn(() => Promise.resolve({ bid: 150, ask: 150.5, mid: 150.25 })),
  getCoinbaseBidAsk:        vi.fn(() => Promise.resolve({ bid: 150.4, ask: 150.9, mid: 150.65 })),
  getCoinbaseProductIncrements: vi.fn(() => Promise.resolve({ baseIncrement: "0.00000001", quoteIncrement: "0.01" })),
  // Real quantization logic — the maker path's tick safety depends on it.
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
  // Universal chainable, thenable query stub: any builder method returns the
  // chain; awaiting it resolves to [] (insert/select paths alike).
  const makeChain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const f of ["from", "where", "orderBy", "limit", "offset", "groupBy", "values", "set", "returning", "leftJoin", "innerJoin", "onConflictDoNothing", "onConflictDoUpdate"]) {
      c[f] = vi.fn(() => c);
    }
    (c as { then: unknown }).then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    return c;
  };
  return {
    db: { select: vi.fn(() => makeChain()), insert: vi.fn(() => makeChain()), update: vi.fn(() => makeChain()), delete: vi.fn(() => makeChain()) },
    tradesTable: {}, triScanTable: {}, executionQualityTable: {}, accountSnapshotsTable: {},
  };
});

vi.mock("../lib/order-book.js", () => ({
  scanOrderBookCycles: vi.fn(() => Promise.resolve({ cycles: [] })),
  preflightObCycle:    vi.fn(),
  discoverCrossPairs:  vi.fn(() => Promise.resolve({ lookup: new Map() })),
  freshJoinPrice:      vi.fn(() => Promise.resolve(150.0)),
  waitForBookTouch:    vi.fn(() => Promise.resolve(false)),
  formatLegAges:       vi.fn(() => "legs"),
  OB_ASSETS:           ["SOL"] as string[],
  OB_USD_PAIRS:        { SOL: "SOLUSD" } as Record<string, string>,
  CROSS_LOOKUP:        new Map(),
}));

// Executor-grade cross pre-fire dependency: LIVE stream books on both venues.
// Default fixture is FRESH and PROFITABLE so the containment tests below reach
// the order machinery; individual tests override it to prove the pre-fire
// blocks execution (stale or thin re-quotes place NO orders).
const FRESH_CROSS_BD = () => ({
  netProfitUsd: 0.05, rawEdgeUsd: 0.06, feesUsd: 0.01, slippageUsd: 0,
  baseQty: 0.0666,
  legDiag: [], legAges: [
    { pair: "SOLUSD[K]", ageMs: 10, recvAgeMs: 10 },
    { pair: "SOL-USD[C]", ageMs: 10, recvAgeMs: 10 },
  ],
  quoteAgeMs: 10, marketUpdateMs: 1_754_600_000_000,
});
vi.mock("../lib/cross-pricing.js", () => ({
  crossTakerBreakdown: vi.fn(),
  crossTakerBreakdownRest: vi.fn(() => Promise.resolve(null)),
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
import * as exchangeModule from "../lib/exchange.js";
import * as graphEngineModule from "../lib/graph-engine.js";
import * as crossPricingModule from "../lib/cross-pricing.js";

const crossTakerBreakdown = crossPricingModule.crossTakerBreakdown as ReturnType<typeof vi.fn>;

const scanGraphOpportunities = graphEngineModule.scanGraphOpportunities as ReturnType<typeof vi.fn>;
const krakenRawLimitOrder    = exchangeModule.krakenRawLimitOrder    as ReturnType<typeof vi.fn>;
const krakenRawMarketOrder   = exchangeModule.krakenRawMarketOrder   as ReturnType<typeof vi.fn>;
const krakenOrderInfo        = exchangeModule.krakenOrderInfo        as ReturnType<typeof vi.fn>;
const krakenCancelOrder      = exchangeModule.krakenCancelOrder      as ReturnType<typeof vi.fn>;
const coinbaseLimitOrder     = exchangeModule.coinbaseLimitOrder     as ReturnType<typeof vi.fn>;
const coinbaseMarketOrder    = exchangeModule.coinbaseMarketOrder    as ReturnType<typeof vi.fn>;
const coinbaseOrderDetails   = exchangeModule.coinbaseOrderDetails   as ReturnType<typeof vi.fn>;
const coinbaseCancelOrder    = exchangeModule.coinbaseCancelOrder    as ReturnType<typeof vi.fn>;

// ── Route fixtures ─────────────────────────────────────────────────────────────

const PLANNED_VOL = 0.0666;

/** 2-leg cross-inventory route: buy on `buyEx`, bridge, sell on the other. */
function crossRoute(buyEx: "kraken" | "coinbase") {
  const sellEx = buyEx === "kraken" ? "coinbase" : "kraken";
  return {
    description: `${buyEx}: buy SOL → ${sellEx}: sell SOL (inventory)`,
    hops: [
      { exchange: buyEx, side: "buy", from: `${buyEx}:USD`, to: `${buyEx}:SOL`,
        pair: buyEx === "kraken" ? "SOLUSD" : "SOL/USD", limitPrice: 150.0, amountOut: PLANNED_VOL },
      { exchange: "bridge", side: "sell", from: `${buyEx}:SOL`, to: `${sellEx}:SOL`, pair: null, limitPrice: 0, amountOut: PLANNED_VOL },
      { exchange: sellEx, side: "sell", from: `${sellEx}:SOL`, to: `${sellEx}:USD`,
        pair: sellEx === "kraken" ? "SOLUSD" : "SOL/USD", limitPrice: 150.6, amountOut: 10.03 },
    ],
    netProfitUsd: 0.05, profitPct: 0.5, slippagePct: 0, executable: true,
  };
}

const BASE_BODY = {
  krakenKey: "k-key", krakenSecret: "k-secret",
  coinbaseKey: "cb-key", coinbaseSecret: "cb-secret",
  tradeSizeUsd: 10, minProfitUsd: 0, isDryRun: false,
  executionStyle: "maker",
};

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
  // Default: fresh + profitable pre-fire so containment tests reach the order
  // machinery. Reset every test — overrides must never leak forward.
  crossTakerBreakdown.mockReset();
  crossTakerBreakdown.mockImplementation(FRESH_CROSS_BD);
});

async function graphExecute(body: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}/arb/graph-execute`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

// Helper: stock terminal/pending Kraken order infos
const kOpen   = { status: "open", volExec: 0, price: 0, cost: 0, fee: 0 };
const kClosed = (vol: number) => ({ status: "closed", volExec: vol, price: 150, cost: vol * 150, fee: 0.016 });

// ── Tests (order matters — the indeterminate gate is module state) ─────────────

describe("POST /arb/graph-execute — maker cross-exchange execution", () => {

  it("Kraken cancel-status outage: explicit error with the resting order id, no hedge, then ALL live execution blocked until verified terminal", async () => {
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    krakenRawLimitOrder.mockResolvedValue({ txid: ["MK-STUCK-1"] });
    // Order never reaches a terminal status — even after the cancel.
    krakenOrderInfo.mockResolvedValue(kOpen);
    krakenCancelOrder.mockResolvedValue(undefined);

    const { body } = await graphExecute(BASE_BODY);
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toContain("MK-STUCK-1");
    expect(String(body["error"])).toMatch(/INDETERMINATE/i);
    // CONTRACT: the Kraken maker buy must rest at the FRESH join bid (capped at
    // the approved hop price), never at hop.limitPrice (the taker-side ask).
    const submittedKrakenPx = krakenRawLimitOrder.mock.calls[0]![3] as number;
    expect(submittedKrakenPx).toBeCloseTo(150.0, 10);
    // No hedge of any kind was placed
    expect(coinbaseMarketOrder).not.toHaveBeenCalled();
    expect(krakenRawMarketOrder).not.toHaveBeenCalled();

    // A subsequent live request is BLOCKED while the order stays unverifiable
    vi.clearAllMocks();
    krakenOrderInfo.mockResolvedValue(kOpen);
    const second = await graphExecute(BASE_BODY);
    expect(second.body["success"]).toBe(false);
    expect(String(second.body["error"])).toContain("MK-STUCK-1");
    expect(scanGraphOpportunities).not.toHaveBeenCalled(); // blocked before any scan/order
    expect(krakenRawLimitOrder).not.toHaveBeenCalled();

    // Once Kraken confirms a terminal zero-fill cancel, the gate clears and
    // execution proceeds normally.
    vi.clearAllMocks();
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    krakenCancelOrder.mockResolvedValue(undefined);
    let resolvedTerminal = false;
    krakenOrderInfo.mockImplementation(async (_c: unknown, txid: string) => {
      if (txid === "MK-STUCK-1") { resolvedTerminal = true; return { status: "canceled", volExec: 0, price: 0, cost: 0, fee: 0 }; }
      return kClosed(PLANNED_VOL); // the NEW maker leg fills fully
    });
    krakenRawLimitOrder.mockResolvedValue({ txid: ["MK-NEW-1"] });
    coinbaseMarketOrder.mockResolvedValue({ orderId: "CB-SELL-1", success: true });
    coinbaseOrderDetails.mockResolvedValue({ status: "FILLED", filledSize: PLANNED_VOL, filledValue: 10.03, avgPrice: 150.6, totalFees: 0.04 });

    const third = await graphExecute(BASE_BODY);
    expect(resolvedTerminal).toBe(true);
    expect(third.body["success"]).toBe(true);
  });

  it("Coinbase indeterminate maker order: gate requires Coinbase credentials and clears only on confirmed terminal status", async () => {
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("coinbase")] }));
    coinbaseLimitOrder.mockResolvedValue({ orderId: "CB-MK-9", success: true });
    coinbaseOrderDetails.mockResolvedValue({ status: "OPEN", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 });
    coinbaseCancelOrder.mockResolvedValue(undefined);

    const { body } = await graphExecute(BASE_BODY);
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toContain("CB-MK-9");
    expect(String(body["error"])).toMatch(/INDETERMINATE/i);
    expect(krakenRawMarketOrder).not.toHaveBeenCalled(); // no hedge

    // Without Coinbase credentials the gate cannot be verified — stays blocked
    vi.clearAllMocks();
    const noCb = await graphExecute({ ...BASE_BODY, coinbaseKey: undefined, coinbaseSecret: undefined });
    expect(noCb.body["success"]).toBe(false);
    expect(String(noCb.body["error"])).toMatch(/Coinbase credentials/i);

    // With credentials and a confirmed CANCELLED zero-fill, the gate clears
    vi.clearAllMocks();
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("coinbase")] }));
    coinbaseCancelOrder.mockResolvedValue(undefined);
    coinbaseOrderDetails.mockImplementation(async (_c: unknown, orderId: string) => {
      if (orderId === "CB-MK-9")   return { status: "CANCELLED", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 };
      if (orderId === "CB-MK-10")  return { status: "FILLED", filledSize: PLANNED_VOL, filledValue: 10, avgPrice: 150.15, totalFees: 0.04 };
      return { status: "UNKNOWN", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 };
    });
    coinbaseLimitOrder.mockResolvedValue({ orderId: "CB-MK-10", success: true });
    krakenRawMarketOrder.mockResolvedValue({ txid: ["K-SELL-1"] });
    krakenOrderInfo.mockResolvedValue(kClosed(PLANNED_VOL));

    const third = await graphExecute(BASE_BODY);
    expect(third.body["success"]).toBe(true);
  });

  it("Coinbase maker buy price is floored to the tick and never crosses a sub-cent ask", async () => {
    // bid 150.009, ask 150.01 — naive cent-rounding of the bid would submit
    // 150.01 and cross the ask (taker). The maker path must floor to 150.00.
    (exchangeModule.getCoinbaseBidAsk as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ bid: 150.009, ask: 150.01, mid: 150.0095 });
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("coinbase")] }));
    coinbaseLimitOrder.mockResolvedValue({ orderId: "CB-TICK-1", success: true });
    coinbaseOrderDetails.mockImplementation(async (_c: unknown, orderId: string) =>
      orderId === "CB-TICK-1"
        ? { status: "FILLED", filledSize: PLANNED_VOL, filledValue: 10, avgPrice: 150.0, totalFees: 0.04 }
        : { status: "UNKNOWN", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 });
    krakenRawMarketOrder.mockResolvedValue({ txid: ["K-SELL-T1"] });
    krakenOrderInfo.mockResolvedValue(kClosed(PLANNED_VOL));

    const { body } = await graphExecute(BASE_BODY);
    expect(body["success"]).toBe(true);
    expect(coinbaseLimitOrder).toHaveBeenCalledTimes(1);
    const submittedPx = coinbaseLimitOrder.mock.calls[0]![3] as number;
    expect(submittedPx).toBeLessThan(150.01); // strictly below the ask — post-only safe
    expect(submittedPx).toBeCloseTo(150.00, 10);
  });

  it("partial maker fill hedges EXACTLY the actual filled volume, never the planned size", async () => {
    const PARTIAL = 0.03;
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    krakenRawLimitOrder.mockResolvedValue({ txid: ["MK-PART-1"] });
    let cancelled = false;
    krakenCancelOrder.mockImplementation(async () => { cancelled = true; });
    // Open until the cancel; then terminal "canceled" with a PARTIAL fill
    krakenOrderInfo.mockImplementation(async () =>
      cancelled ? { status: "canceled", volExec: PARTIAL, price: 150, cost: PARTIAL * 150, fee: 0.01 } : kOpen);
    coinbaseMarketOrder.mockResolvedValue({ orderId: "CB-SELL-2", success: true });
    coinbaseOrderDetails.mockResolvedValue({ status: "FILLED", filledSize: PARTIAL, filledValue: PARTIAL * 150.6, avgPrice: 150.6, totalFees: 0.02 });

    const { body } = await graphExecute(BASE_BODY);
    expect(body["success"]).toBe(true);
    expect(coinbaseMarketOrder).toHaveBeenCalledTimes(1);
    const hedgeVolume = coinbaseMarketOrder.mock.calls[0]![2] as number;
    expect(hedgeVolume).toBeCloseTo(PARTIAL, 10);
    expect(hedgeVolume).not.toBeCloseTo(PLANNED_VOL, 4);
  });

  it("non-cent products: maker price/size are quantized DOWN on the product's REAL increments and passed to order submission", async () => {
    // quote tick 0.001, base lot 0.000001 — neither matches the legacy 2/4-decimal assumptions.
    (exchangeModule.getCoinbaseProductIncrements as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ baseIncrement: "0.000001", quoteIncrement: "0.001" });
    (exchangeModule.getCoinbaseBidAsk as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ bid: 150.0095, ask: 150.0102, mid: 150.00985 });
    const route = crossRoute("coinbase");
    route.hops[0]!.amountOut = 0.066666666666; // more precision than any lot size
    route.hops[0]!.limitPrice = 151; // approved price above the live bid — the bid governs
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [route] }));
    coinbaseLimitOrder.mockResolvedValue({ orderId: "CB-INC-1", success: true });
    coinbaseOrderDetails.mockImplementation(async (_c: unknown, orderId: string) =>
      orderId === "CB-INC-1"
        ? { status: "FILLED", filledSize: 0.066666, filledValue: 10, avgPrice: 150.009, totalFees: 0.04 }
        : { status: "UNKNOWN", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 });
    krakenRawMarketOrder.mockResolvedValue({ txid: ["K-SELL-INC"] });
    krakenOrderInfo.mockResolvedValue(kClosed(0.066666));

    const { body } = await graphExecute(BASE_BODY);
    expect(body["success"]).toBe(true);
    const call = coinbaseLimitOrder.mock.calls[0]!;
    expect(call[2] as number).toBeCloseTo(0.066666, 12);          // size floored to base increment
    expect(call[3] as number).toBeCloseTo(150.009, 12);           // price floored to quote tick, below ask
    expect(call[3] as number).toBeLessThan(150.0102);
    expect(call[5]).toEqual({ baseIncrement: "0.000001", quoteIncrement: "0.001" }); // increments forwarded for exact serialization
    // Hedge sized from the ACTUAL fill (the quantized amount)
    const hedge = krakenRawMarketOrder.mock.calls.find(c => c[1] === "sell")!;
    expect(hedge[2] as number).toBeCloseTo(0.066666, 12);
  });

  it("indeterminate gate survives a server restart: persisted to disk and reloaded before any live execution", async () => {
    const stateFile = nodePath.join(process.cwd(), ".state", "pending-indeterminate-order.json");
    // Trigger a Kraken indeterminate state
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    krakenRawLimitOrder.mockResolvedValue({ txid: ["MK-RESTART-1"] });
    krakenOrderInfo.mockResolvedValue(kOpen);
    krakenCancelOrder.mockResolvedValue(undefined);
    const first = await graphExecute(BASE_BODY);
    expect(String(first.body["error"])).toContain("MK-RESTART-1");
    // Gate is on disk
    expect(nodeFs.existsSync(stateFile)).toBe(true);
    expect(JSON.parse(nodeFs.readFileSync(stateFile, "utf8")).orderId).toBe("MK-RESTART-1");

    // "Restart": a FRESH module instance must reload the gate from disk and
    // block live execution while the order stays unverifiable.
    vi.resetModules();
    const { default: freshRouter } = await import("./arb.js");
    const ex2 = await import("../lib/exchange.js");
    const ge2 = await import("../lib/graph-engine.js");
    vi.clearAllMocks(); // drop call records from the pre-"restart" request
    (ex2.krakenOrderInfo as ReturnType<typeof vi.fn>).mockResolvedValue(kOpen);
    (ex2.krakenCancelOrder as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const app2 = express();
    app2.use(express.json());
    app2.use((req, _res, next) => { (req as unknown as Record<string, unknown>)["log"] = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }; next(); });
    app2.use(freshRouter);
    const server2 = createServer(app2);
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const base2 = `http://localhost:${(server2.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${base2}/arb/graph-execute`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(BASE_BODY),
      });
      const blocked = await r.json() as Record<string, unknown>;
      expect(blocked["success"]).toBe(false);
      expect(String(blocked["error"])).toContain("MK-RESTART-1");
      expect(ge2.scanGraphOpportunities).not.toHaveBeenCalled();

      // Once terminal, the fresh instance clears the gate AND the state file
      (ex2.krakenOrderInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "canceled", volExec: 0, price: 0, cost: 0, fee: 0 });
      (ge2.scanGraphOpportunities as ReturnType<typeof vi.fn>).mockResolvedValue({ routes: [] });
      const r2 = await fetch(`${base2}/arb/graph-execute`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(BASE_BODY),
      });
      await r2.json();
      expect(nodeFs.existsSync(stateFile)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      nodeFs.rmSync(stateFile, { force: true });
      // The ORIGINAL router instance (used by later tests) also holds the
      // gate in memory — resolve it there too so state can't leak across tests.
      krakenCancelOrder.mockResolvedValue(undefined);
      krakenOrderInfo.mockResolvedValue({ status: "canceled", volExec: 0, price: 0, cost: 0, fee: 0 });
      scanGraphOpportunities.mockResolvedValue({ routes: [] });
      await graphExecute(BASE_BODY);
    }
    // Restore the original module registry for any later tests
    vi.resetModules();
  });

  it("partial taker hedge fails the route and unwinds the residual — never silent success with unhedged inventory", async () => {
    const HEDGED = 0.05;
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    krakenRawLimitOrder.mockResolvedValue({ txid: ["MK-FULL-1"] });
    krakenOrderInfo.mockResolvedValue(kClosed(PLANNED_VOL)); // maker leg fills fully
    coinbaseMarketOrder.mockResolvedValue({ orderId: "CB-SELL-3", success: true });
    // Hedge ends terminal but PARTIAL — only 0.05 of 0.0666 sold
    coinbaseOrderDetails.mockResolvedValue({ status: "CANCELLED", filledSize: HEDGED, filledValue: HEDGED * 150.6, avgPrice: 150.6, totalFees: 0.02 });
    krakenRawMarketOrder.mockResolvedValue({ txid: ["K-UNWIND-1"] });

    const { body } = await graphExecute(BASE_BODY);
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/Sell leg failed/i);
    // Residual unwound on the BUY venue (Kraken) with the exact unsold amount
    expect(krakenRawMarketOrder).toHaveBeenCalled();
    const unwindCall = krakenRawMarketOrder.mock.calls.find(c => c[1] === "sell");
    expect(unwindCall).toBeTruthy();
    expect(unwindCall![2] as number).toBeCloseTo(PLANNED_VOL - HEDGED, 10);
  });

});

// ── Cross pre-fire gating: bypasses never authorize without a fresh re-quote ──
// Big-edge bypass, probes, the profitable override, and FORCE MODE only skip
// HISTORY gates. The executor-grade cross pre-fire (fresh stream books, per-leg
// freshness, floor + safety buffer) still runs after them — a stale or thin
// re-quote must place NO orders even when every history gate is bypassed.

describe("POST /arb/graph-execute — cross pre-fire gates bypassed shapes", () => {

  const NO_ORDERS = () => {
    expect(krakenRawLimitOrder).not.toHaveBeenCalled();
    expect(krakenRawMarketOrder).not.toHaveBeenCalled();
    expect(coinbaseLimitOrder).not.toHaveBeenCalled();
    expect(coinbaseMarketOrder).not.toHaveBeenCalled();
  };

  it("FORCE MODE with STALE quotes: skips with no orders — force bypasses history, never freshness", async () => {
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    crossTakerBreakdown.mockImplementation(() => ({ ...FRESH_CROSS_BD(), quoteAgeMs: 5_000 }));

    const { body } = await graphExecute({ ...BASE_BODY, forceMode: true });
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/cross SKIP: quotes are still 5000ms old/);
    NO_ORDERS();
  });

  it("FORCE MODE with a THIN fresh re-quote: net below buffer+floor places no orders", async () => {
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    // Fresh but thin: $0.015 executable net ≤ $0.02 safety buffer on a $10 trade.
    crossTakerBreakdown.mockImplementation(() => ({ ...FRESH_CROSS_BD(), netProfitUsd: 0.015 }));

    const { body } = await graphExecute({ ...BASE_BODY, forceMode: true });
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/cross executable net \$0\.0150/);
    NO_ORDERS();
  });

  it("stream books unavailable: refuses to fire on the graph estimate, no orders", async () => {
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    crossTakerBreakdown.mockImplementation(() => null);

    const { body } = await graphExecute({ ...BASE_BODY, forceMode: true });
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/depth books unavailable/);
    NO_ORDERS();
  });

  it("fresh profitable re-quote after bypassed history gates: taker cross fires and confirms actual fills", async () => {
    // FORCE MODE (all history gates bypassed) + a fresh pre-fire that clears
    // the floor: execution proceeds and sells the ACTUAL confirmed buy fill.
    scanGraphOpportunities.mockImplementation(() => Promise.resolve({ routes: [crossRoute("kraken")] }));
    krakenRawMarketOrder.mockResolvedValue({ txid: ["K-BUY-9"] });
    krakenOrderInfo.mockResolvedValue(kClosed(PLANNED_VOL));
    coinbaseMarketOrder.mockResolvedValue({ orderId: "CB-SELL-9", success: true });
    coinbaseOrderDetails.mockResolvedValue({ status: "FILLED", filledSize: PLANNED_VOL, filledValue: 10.03, avgPrice: 150.6, totalFees: 0.04 });

    const { body } = await graphExecute({ ...BASE_BODY, executionStyle: "taker", forceMode: true });
    expect(body["success"]).toBe(true);
    // Hedge sized from the ACTUAL confirmed buy fill.
    const sell = coinbaseMarketOrder.mock.calls[0]!;
    expect(sell[1]).toBe("SELL");
    expect(sell[2] as number).toBeCloseTo(PLANNED_VOL, 10);
  }, 30_000);

});

// ── Operator-proof gates (task: strangers must not flip safety overrides) ──────

const getKrakenBalances = exchangeModule.getKrakenBalances as ReturnType<typeof vi.fn>;

describe("operator proof on safety-loosening controls", () => {

  it("forceMode with FAILING Kraken credential check: 403, no scan, no orders", async () => {
    getKrakenBalances.mockRejectedValueOnce(new Error("EAPI:Invalid key"));
    const { status, body } = await graphExecute({
      ...BASE_BODY, krakenKey: "bogus-key-403", krakenSecret: "bogus-secret-403", forceMode: true,
    });
    expect(status).toBe(403);
    expect(String(body["error"])).toMatch(/FORCE MODE requires valid Kraken credentials/);
    expect(scanGraphOpportunities).not.toHaveBeenCalled();
    expect(krakenRawMarketOrder).not.toHaveBeenCalled();
    expect(krakenRawLimitOrder).not.toHaveBeenCalled();
  });

  it("route-history/clear without credentials: 400, nothing cleared", async () => {
    const r = await fetch(`${baseUrl}/arb/route-history/clear`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as Record<string, unknown>;
    expect(String(body["error"])).toMatch(/Kraken credentials required/);
  });

  it("route-history/clear with FAILING credential check: 403, nothing cleared", async () => {
    getKrakenBalances.mockRejectedValueOnce(new Error("EAPI:Invalid key"));
    const r = await fetch(`${baseUrl}/arb/route-history/clear`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ krakenKey: "bogus-key-bl", krakenSecret: "bogus-secret-bl" }),
    });
    expect(r.status).toBe(403);
    const body = await r.json() as Record<string, unknown>;
    expect(String(body["error"])).toMatch(/credential check failed/);
  });

  it("route-history/clear with VALID credentials: succeeds", async () => {
    const r = await fetch(`${baseUrl}/arb/route-history/clear`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ krakenKey: "good-key-bl", krakenSecret: "good-secret-bl" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(typeof body["clearedRoutes"]).toBe("number");
  });

});
