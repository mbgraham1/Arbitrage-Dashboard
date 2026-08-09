/**
 * Per-leg fill diagnostics (execution_quality.legsFilled) — semantics proof.
 *
 * Drives POST /arb/graph-execute end-to-end on a Kraken triangle route (the
 * same runKrakenTriangle machinery ob-execute uses) and asserts the EXACT
 * legsFilled value written to the execution_quality table:
 *   1. Full 3-leg cycle → 3
 *   2. Leg-1 TERMINAL unfill (canceled, zero fill, taker fallback declined) → 0
 *   3. Confirmed leg 1, then leg-2 failure (order rejected + fallback fails) → 1
 *   4. IndeterminateOrderError on leg 1 (never a terminal status) → null, NOT 0
 *   5. Dry run → null
 * Plus: GET /arb/execution-quality leg1/2/3 rates exclude legsFilled=null rows
 * from the denominator (legsTracked).
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

// db mock: records every insert (table + values) and lets tests set the rows
// resolved by SELECT chains (used by the /arb/execution-quality aggregation).
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

vi.mock("../lib/order-book.js", () => {
  // v21: the executor pre-flights via the path-based preflightObPath; these
  // tests stub the triangle-shaped preflightObCycle, so this adapter delegates
  // and converts the result shape ({volumeA, volumeB} -> volumes[]).
  const preflightObCycle = vi.fn();
  const preflightObPath = vi.fn(async (path: string[], ...rest: unknown[]) => {
    const r = await (preflightObCycle as unknown as (...a: unknown[]) => Promise<Record<string, unknown> | null>)(path[0], path[1], ...rest);
    return r ? { ...r, volumes: [r["volumeA"], r["volumeB"]] } : r;
  });
  return {
  scanOrderBookCycles: vi.fn(() => Promise.resolve({ cycles: [] })),
  preflightObCycle,
  preflightObPath,
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
  };
});

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

import arbRouter from "./arb.js";
import * as dbModule from "@workspace/db";
import * as exchangeModule from "../lib/exchange.js";
import * as orderBookModule from "../lib/order-book.js";
import * as graphEngineModule from "../lib/graph-engine.js";

const inserts = (dbModule as unknown as { __inserts: Array<{ table: unknown; values: Record<string, unknown> }> }).__inserts;
const selectRows = (dbModule as unknown as { __selectRows: unknown[] }).__selectRows;
const qualityTableMock = dbModule.executionQualityTable as unknown;
/** Rows written to execution_quality since the last reset. */
const qualityRows = () => inserts.filter(i => i.table === qualityTableMock).map(i => i.values as Record<string, unknown>);

const scanGraphOpportunities = graphEngineModule.scanGraphOpportunities as ReturnType<typeof vi.fn>;
const preflightObCycle       = orderBookModule.preflightObCycle       as ReturnType<typeof vi.fn>;
const krakenRawLimitOrder    = exchangeModule.krakenRawLimitOrder     as ReturnType<typeof vi.fn>;
const krakenRawMarketOrder   = exchangeModule.krakenRawMarketOrder    as ReturnType<typeof vi.fn>;
const krakenRawIocLimitOrder = exchangeModule.krakenRawIocLimitOrder  as ReturnType<typeof vi.fn>;
const krakenOrderInfo        = exchangeModule.krakenOrderInfo         as ReturnType<typeof vi.fn>;
const krakenCancelOrder      = exchangeModule.krakenCancelOrder       as ReturnType<typeof vi.fn>;

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Kraken triangle route USD→ATOM→BTC→USD; distinct description per test so
 *  in-memory failure-streak state never blocks a later scenario. */
const triRoute = (description: string) => ({
  description,
  hops: [
    { from: "kraken:USD",  to: "kraken:ATOM", exchange: "kraken" },
    { from: "kraken:ATOM", to: "kraken:BTC",  exchange: "kraken" },
    { from: "kraken:BTC",  to: "kraken:USD",  exchange: "kraken" },
  ],
  netProfitUsd: 1.0, profitPct: 10, startUsd: 10, executable: true, slippagePct: 0.1,
});

/** Maker preflight: $1.00 edge (clears the $0.25 maker floor at $10). Fresh
 *  object per call — the executor mutates leg limit prices. */
const makerPf = () => ({
  // Kept under the canonical route-sanity cap (ROUTE_SANITY_MAX_NET_PCT,
  // default 5% of size): an implausible net now blocks execution by design.
  profitUsd: 0.30, slippagePct: 0, confidencePct: 90,
  legs: [
    { pair: "ATOMUSD",  side: "buy",  volume: 2,      limitPrice: 5 },
    { pair: "ATOMXBT",  side: "sell", volume: 2,      limitPrice: 0.0001 },
    { pair: "XXBTZUSD", side: "sell", volume: 0.0002, limitPrice: 50_000 },
  ],
  volumeA: 2, volumeB: 0.0002,
});

const kClosed = (volExec: number, cost: number, fee: number) => ({ status: "closed", volExec, price: 0, cost, fee });
const kCanceled0 = { status: "canceled", volExec: 0, price: 0, cost: 0, fee: 0 };
const kOpen = { status: "open", volExec: 0, price: 0, cost: 0, fee: 0 };

const KEYS = { krakenKey: "k-key", krakenSecret: "k-secret" };
const liveBody = (routeDescription: string, extra: Record<string, unknown> = {}) => ({
  ...KEYS, routeDescription, tradeSizeUsd: 10, minProfitUsd: 0, isDryRun: false,
  executionStyle: "maker", makerTimeoutMs: 1000, maxReprices: 1, ...extra,
});

// ── Test server ────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>)["log"] = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
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
  selectRows.length = 0;
  // Defaults restored after clearAllMocks
  preflightObCycle.mockImplementation((_a: string, _b: string, _s: number, _f: number, pricing?: string) =>
    Promise.resolve(pricing === "maker" ? makerPf() : null)); // taker fallback preflight: unavailable unless a test overrides
  krakenCancelOrder.mockResolvedValue(undefined);
});

async function graphExecute(body: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}/arb/graph-execute`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("legsFilled diagnostics — POST /arb/graph-execute (Kraken triangle)", () => {

  it("full 3-leg cycle → legsFilled 3, filled=true", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FULL")] });
    let n = 0;
    krakenRawLimitOrder.mockImplementation(() => Promise.resolve({ txid: [`T${++n}`] }));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => Promise.resolve(
      txid === "T1" ? kClosed(2, 10, 0.01)          // leg 1: buy 2 ATOM for $10
      : txid === "T2" ? kClosed(2, 0.0002, 0)       // leg 2: sell 2 ATOM → 0.0002 BTC
      : kClosed(0.0002, 11, 0.01)));                // leg 3: sell BTC → $11

    const { body } = await graphExecute(liveBody("TRI-FULL"));
    expect(body["success"]).toBe(true);

    const q = qualityRows();
    expect(q).toHaveLength(1);
    expect(q[0]!["legsFilled"]).toBe(3);
    expect(q[0]!["filled"]).toBe(true);
    expect(q[0]!["isDryRun"]).toBe(false);
  });

  it("leg-1 terminal unfill (canceled, zero fill; taker fallback declined) → legsFilled 0", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-L1-DEAD")] });
    krakenRawLimitOrder.mockResolvedValue({ txid: ["T-DEAD-1"] });
    krakenOrderInfo.mockResolvedValue(kCanceled0); // terminal, PROVEN zero fill

    const { body } = await graphExecute(liveBody("TRI-L1-DEAD"));
    expect(body["success"]).toBe(false);

    const q = qualityRows();
    expect(q).toHaveLength(1);
    expect(q[0]!["legsFilled"]).toBe(0); // proven: leg 1 never filled
    expect(q[0]!["filled"]).toBe(false);
  });

  it("confirmed leg 1, then leg-2 failure → legsFilled 1", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-L2-DEAD")] });
    let placed = 0;
    krakenRawLimitOrder.mockImplementation((_c: unknown, _s: string, _v: number, _p: number, pair: string) => {
      placed++;
      if (pair === "ATOMXBT") return Promise.reject(new Error("EOrder:Rejected"));
      return Promise.resolve({ txid: [`L${placed}`] });
    });
    // leg-2 taker completion + any market order on the cross pair also fails;
    // the residual-ATOM unwind (ATOMUSD) succeeds.
    krakenRawMarketOrder.mockImplementation((_c: unknown, _s: string, _v: number, pair: string) =>
      pair === "ATOMXBT" ? Promise.reject(new Error("EOrder:Rejected")) : Promise.resolve({ txid: ["UNWIND-1"] }));
    krakenRawIocLimitOrder.mockRejectedValue(new Error("EOrder:Rejected"));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => Promise.resolve(
      txid === "L1" ? kClosed(2, 10, 0.01) : kClosed(2, 10, 0))); // unwind fills

    const { body } = await graphExecute(liveBody("TRI-L2-DEAD"));
    expect(body["success"]).toBe(false);

    const q = qualityRows();
    expect(q).toHaveLength(1);
    expect(q[0]!["legsFilled"]).toBe(1); // leg 1 CONFIRMED, cycle died at leg 2
    expect(q[0]!["filled"]).toBe(false);
    // Unwind reconciled: quality row carries the MEASURED net USD (buy $10 +
    // $0.01 fee, unwind sold for $10) so routeLegRisk's avgUnwindLossUsd uses
    // the route's true unwind cost instead of the assumed 1.5% of size.
    expect(q[0]!["realizedProfitUsd"]).toBe("-0.010000");
  });

  it("IndeterminateOrderError on leg 1 (never terminal) → legsFilled null, NOT 0", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-L1-INDET")] });
    krakenRawLimitOrder.mockResolvedValue({ txid: ["T-STUCK-1"] });
    krakenOrderInfo.mockResolvedValue(kOpen); // never reaches a terminal status

    const { body } = await graphExecute(liveBody("TRI-L1-INDET"));
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/INDETERMINATE/i);

    const q = qualityRows();
    expect(q).toHaveLength(1);
    // The order may STILL fill — 0 would assert a failure Kraken never confirmed.
    expect(q[0]!["legsFilled"]).toBeNull();
    expect(q[0]!["filled"]).toBe(false);
  }, 30_000);

  it("dry run → legsFilled null (never skews leg-level fill rates)", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-DRY")] });

    const { body } = await graphExecute({ ...liveBody("TRI-DRY"), isDryRun: true });
    expect(body["success"]).toBe(true);
    expect(body["isDryRun"]).toBe(true);
    expect(krakenRawLimitOrder).not.toHaveBeenCalled();

    const q = qualityRows();
    expect(q).toHaveLength(1);
    expect(q[0]!["isDryRun"]).toBe(true);
    expect(q[0]!["legsFilled"]).toBeNull();
  });
});

describe("GET /arb/execution-quality — leg rates exclude legsFilled=null rows", () => {
  it("legsTracked counts only non-null rows; leg1/2/3 rates use that denominator", async () => {
    const mk = (over: Record<string, unknown>) => ({
      id: 1, createdAt: new Date("2026-08-08T00:00:00Z"), accountId: "acct",
      route: "R", style: "maker", isDryRun: false, filled: false,
      tradeSizeUsd: "10.00", expectedProfitUsd: "0.100000", realizedProfitUsd: null,
      slippagePct: null, legsFilled: null, note: null, ...over,
    });
    selectRows.push(
      mk({ legsFilled: 3, filled: true, realizedProfitUsd: "0.050000" }),
      mk({ legsFilled: 1 }),
      mk({ legsFilled: 0 }),
      mk({ legsFilled: null }),                 // live indeterminate / pre-tracking → excluded
      mk({ legsFilled: null, isDryRun: true }), // dry run → excluded (not even live)
    );

    const r = await fetch(`${baseUrl}/arb/execution-quality`);
    const body = await r.json() as { routes: Array<Record<string, unknown>> };
    const route = body.routes.find(x => x["route"] === "R")!;
    expect(route).toBeDefined();
    expect(route["liveAttempts"]).toBe(4);      // null live row still a live attempt
    expect(route["legsTracked"]).toBe(3);       // …but excluded from leg denominators
    expect(route["leg1FillRate"]).toBeCloseTo(2 / 3, 10);
    expect(route["leg2FillRate"]).toBeCloseTo(1 / 3, 10);
    expect(route["leg3FillRate"]).toBeCloseTo(1 / 3, 10);
  });

  it("no leg-tracked rows → rates are null, never 0 (absence of data ≠ 0% fills)", async () => {
    const now = new Date("2026-08-08T00:00:00Z");
    selectRows.push({
      id: 1, createdAt: now, accountId: "acct", route: "R2", style: "maker",
      isDryRun: false, filled: false, tradeSizeUsd: "10.00",
      expectedProfitUsd: "0.100000", realizedProfitUsd: null, slippagePct: null,
      legsFilled: null, note: null,
    });
    const r = await fetch(`${baseUrl}/arb/execution-quality`);
    const body = await r.json() as { routes: Array<Record<string, unknown>> };
    const route = body.routes.find(x => x["route"] === "R2")!;
    expect(route["legsTracked"]).toBe(0);
    expect(route["leg1FillRate"]).toBeNull();
    expect(route["leg2FillRate"]).toBeNull();
    expect(route["leg3FillRate"]).toBeNull();
  });
});
