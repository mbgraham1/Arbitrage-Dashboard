/**
 * FAILED-ledger invariant (task: money-critical) — a live triangle that placed
 * ANY order but did not complete MUST leave exactly one trades row with
 * status="failed" and MUST NEVER produce a "verified" row or a non-null
 * realizedProfitUsd (except the provable $0 when NOTHING filled). Failed rows
 * are excluded from Realized P&L by /trades/summary's hard SQL gate
 * (status='verified' AND realized_profit_usd IS NOT NULL) — proven
 * behaviorally in trades-summary-failed.test.ts against a real scratch-schema
 * database; this file proves the WRITE side via POST /arb/graph-execute:
 *   1. Leg-2 failure after a confirmed leg-1 fill with a CONFIRMED USD unwind
 *      → failed row, realized = MEASURED net USD (unwind reconciled)
 *   2. Leg-3 failure after confirmed legs 1+2 (cross-pair leg-2 fill —
 *      not USD-reconcilable) → failed row, realized NULL
 *   3. Lock revocation (HARD RESET) while leg 1 rests with a partial fill,
 *      fully unwound → failed row, realized = measured net USD, evidence kept
 *   4. Leg-1 accepted but PROVEN zero fill → failed row, realized exactly "0"
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


// ── Helpers ────────────────────────────────────────────────────────────────────

const tradesTableMock = dbModule.tradesTable as unknown;
/** Rows written to the trades ledger since the last reset. */
const tradesRows = () => inserts.filter(i => i.table === tradesTableMock).map(i => i.values as Record<string, unknown>);
const failedRows = () => tradesRows().filter(r => r["status"] === "failed");

const kCanceled = (volExec: number, cost: number, fee: number) => ({ status: "canceled", volExec, price: 0, cost, fee });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await sleep(25);
  }
}
async function hardReset() {
  const r = await fetch(`${baseUrl}/arb/exec-lock/clear`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(KEYS),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

/** The invariant every failure scenario must satisfy. */
function expectSingleFailedRow(opts: { realized: string | null }) {
  const trades = tradesRows();
  // NEVER a verified (or legacy-estimated) row out of a failed run.
  expect(trades.filter(r => r["status"] === "verified")).toHaveLength(0);
  expect(trades.filter(r => r["status"] === "estimated")).toHaveLength(0);
  const failed = failedRows();
  expect(failed).toHaveLength(1);
  const row = failed[0]!;
  expect(row["status"]).toBe("failed");
  expect(row["isDryRun"]).toBe(false);
  expect(String(row["pair"])).toMatch(/\[FAILED: /);
  // Money gate: realized is only ever a MEASURED number — the reconciled net
  // USD when every fill is confirmed on a USD pair and inventory nets to zero,
  // exactly "0" for provably zero fills, otherwise NULL (never an estimate).
  if (opts.realized === null) expect(row["realizedProfitUsd"]).toBeNull();
  else expect(row["realizedProfitUsd"]).toBe(opts.realized);
  return row;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("FAILED ledger rows — POST /arb/graph-execute (Kraken triangle)", () => {

  it("leg-2 failure after confirmed leg-1 fill with confirmed USD unwind → ONE failed row, realized = MEASURED net USD", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-L2")] });
    let placed = 0;
    krakenRawLimitOrder.mockImplementation((_c: unknown, _s: string, _v: number, _p: number, pair: string) => {
      placed++;
      if (pair === "ATOMXBT") return Promise.reject(new Error("EOrder:Rejected"));
      return Promise.resolve({ txid: [`L${placed}`] });
    });
    // Cross-pair taker fallback also fails; the residual-ATOM unwind (ATOMUSD) fills.
    krakenRawMarketOrder.mockImplementation((_c: unknown, _s: string, _v: number, pair: string) =>
      pair === "ATOMXBT" ? Promise.reject(new Error("EOrder:Rejected")) : Promise.resolve({ txid: ["UNWIND-1"] }));
    krakenRawIocLimitOrder.mockRejectedValue(new Error("EOrder:Rejected"));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => Promise.resolve(
      txid === "L1" ? kClosed(2, 10, 0.01) : kClosed(2, 10, 0)));

    const { body } = await graphExecute(liveBody("TRI-FL-L2"));
    expect(body["success"]).toBe(false);

    // Round trip closed: buy 2 ATOM @ $10 + $0.01 fee, unwind sold 2 ATOM for
    // $10 (fee 0) → measured net −$0.01. The risk gate now learns THIS number
    // instead of assuming 1.5% of size.
    const row = expectSingleFailedRow({ realized: "-0.010000" });
    expect(body["realizedNetUsd"]).toBeCloseTo(-0.01, 6);
    // Leg-1 evidence: confirmed fill volume + order id for reconciliation.
    expect(String(row["buyOrderId"])).toContain("L1");
    const fills = row["legFills"] as Array<Record<string, unknown>>;
    expect(fills.some(f => f["leg"] === 1 && f["txid"] === "L1" && (f["volume"] as number) > 0)).toBe(true);
    expect(parseFloat(String(row["volume"]))).toBeGreaterThan(0); // leg-1 confirmed volume recorded
  });

  it("leg-2 failure with unwind accepted but NOT confirmed → failed row, realized NULL (never a guess)", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-UNCONF")] });
    let placed = 0;
    krakenRawLimitOrder.mockImplementation((_c: unknown, _s: string, _v: number, _p: number, pair: string) => {
      placed++;
      if (pair === "ATOMXBT") return Promise.reject(new Error("EOrder:Rejected"));
      return Promise.resolve({ txid: [`L${placed}`] });
    });
    krakenRawMarketOrder.mockImplementation((_c: unknown, _s: string, _v: number, pair: string) =>
      pair === "ATOMXBT" ? Promise.reject(new Error("EOrder:Rejected")) : Promise.resolve({ txid: ["UNWIND-U"] }));
    krakenRawIocLimitOrder.mockRejectedValue(new Error("EOrder:Rejected"));
    // Unwind order accepted but its status never confirms → zero-volume
    // evidence row → the USD flow is unknown → realized MUST stay NULL.
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => Promise.resolve(
      txid === "L1" ? kClosed(2, 10, 0.01) : kOpen));

    const { body } = await graphExecute(liveBody("TRI-FL-UNCONF"));
    expect(body["success"]).toBe(false);

    const row = expectSingleFailedRow({ realized: null });
    expect(body["realizedNetUsd"]).toBeNull();
    const fills = row["legFills"] as Array<Record<string, unknown>>;
    expect(fills.some(f => f["txid"] === "UNWIND-U" && f["volume"] === 0)).toBe(true);
  }, 30_000);

  it("leg-3 failure after confirmed legs 1+2 → ONE failed row, realized NULL, both legs' evidence kept", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-L3")] });
    let placed = 0;
    krakenRawLimitOrder.mockImplementation((_c: unknown, _s: string, _v: number, _p: number, pair: string) => {
      placed++;
      if (pair === "XXBTZUSD") return Promise.reject(new Error("EOrder:Rejected")); // leg 3 dies
      return Promise.resolve({ txid: [`L${placed}`] });
    });
    // Leg-3 taker fallback + BTC unwind sweep also rejected on XXBTZUSD would
    // strand inventory — let the unwind fill so the run ends via the normal
    // failure path with confirmed legs 1+2.
    krakenRawMarketOrder.mockImplementation((_c: unknown, _s: string, _v: number, pair: string) =>
      pair === "XXBTZUSD" && placed < 90 ? Promise.reject(new Error("EOrder:Rejected")) : Promise.resolve({ txid: ["UNWIND-B"] }));
    krakenRawIocLimitOrder.mockRejectedValue(new Error("EOrder:Rejected"));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => Promise.resolve(
      txid === "L1" ? kClosed(2, 10, 0.01)
      : txid === "L2" ? kClosed(2, 0.0002, 0)
      : kClosed(0.0002, 10, 0)));

    const { body } = await graphExecute(liveBody("TRI-FL-L3"));
    expect(body["success"]).toBe(false);

    // Leg-2 filled on the cross pair (quote isn't USD) → net USD effect is
    // NOT provably closed → realized stays NULL, never a reconstruction.
    const row = expectSingleFailedRow({ realized: null });
    expect(body["realizedNetUsd"]).toBeNull();
    const fills = row["legFills"] as Array<Record<string, unknown>>;
    expect(fills.some(f => f["leg"] === 1 && f["txid"] === "L1")).toBe(true);
    expect(fills.some(f => f["leg"] === 2 && f["txid"] === "L2")).toBe(true);
  }, 30_000);

  it("lock revoked (HARD RESET) while leg 1 rests with a partial fill, fully unwound → failed row, realized measured", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-REVOKE")] });
    let polls = 0;
    let cancelled = false;
    krakenRawLimitOrder.mockResolvedValue({ txid: ["R1"] });
    krakenCancelOrder.mockImplementation(() => { cancelled = true; return Promise.resolve(undefined); });
    krakenOrderInfo.mockImplementation(() => {
      polls++;
      // Rests until the run cancels post-revocation; the cancel race left a
      // CONFIRMED partial fill of 1/2 ATOM.
      return Promise.resolve(cancelled ? kCanceled(1, 5, 0.01) : kOpen);
    });
    krakenRawMarketOrder.mockResolvedValue({ txid: ["UNWIND-R"] }); // partial unwound

    // Long maker timeout: the revoke must land while the leg still RESTS,
    // not after a maker-timeout cancel.
    const run = graphExecute(liveBody("TRI-FL-REVOKE", { makerTimeoutMs: 60_000 }));
    await waitUntil(() => polls >= 2);
    const reset = await hardReset();
    expect(reset.body["cleared"]).toBe(true);

    const { body } = await run;
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/revoked/i);

    // Partial 1 ATOM buy ($5 + $0.01 fee) fully unwound for $5 − $0.01 fee →
    // measured net −$0.02 (round trip provably closed).
    const row = expectSingleFailedRow({ realized: "-0.020000" });
    const fills = row["legFills"] as Array<Record<string, unknown>>;
    expect(fills.some(f => f["txid"] === "R1" && (f["volume"] as number) > 0)).toBe(true);
  }, 30_000);

  it("leg-1 accepted but PROVEN zero fill → failed row with realized exactly \"0\" and zero-volume evidence", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-ZERO")] });
    krakenRawLimitOrder.mockResolvedValue({ txid: ["Z1"] });
    krakenOrderInfo.mockResolvedValue(kCanceled0); // terminal, zero fill; taker fallback declined

    const { body } = await graphExecute(liveBody("TRI-FL-ZERO"));
    expect(body["success"]).toBe(false);

    const failed = failedRows();
    if (failed.length > 0) {
      // Nothing moved → realized is exactly $0, never NULL, never an estimate.
      const row = expectSingleFailedRow({ realized: "0" });
      const fills = row["legFills"] as Array<Record<string, unknown>>;
      expect(fills.some(f => f["txid"] === "Z1" && f["volume"] === 0)).toBe(true);
    } else {
      // If the zero-fill abort pre-dates any accepted-order tracking there
      // must AT LEAST be no verified/estimated row — but with acceptedOrders
      // tracking in place, a row is expected. Fail loudly if absent.
      throw new Error("zero-fill live abort left NO failed ledger row — accepted order vanished from the ledger");
    }
  });

  it("dry run failure path writes NO failed row (dry runs never touch the live ledger classification)", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-DRY")] });
    const { body } = await graphExecute({ ...liveBody("TRI-FL-DRY"), isDryRun: true });
    expect(body["isDryRun"]).toBe(true);
    expect(failedRows()).toHaveLength(0);
    // Dry-run ledger rows are "simulated", never verified/failed.
    for (const r of tradesRows()) expect(r["status"]).toBe("simulated");
  });
});
