/**
 * FORCE MODE lock-eviction safety — proof against double-spend.
 *
 * FORCE MODE evicts the live execution lock only when its heartbeat has been
 * silent > FORCE_LOCK_STALE_MS (15s). Every Kraken private call — including
 * rate-limit backoff sleeps — beats the OWNER-scoped heartbeat the executor
 * bound via bindLockHeartbeat(liveLockHeartbeat(gen)) when it took the lock.
 * These tests prove:
 *   1. A heartbeat-LIVE lock (beating ≤5s apart, as during a long rate-limit
 *      backoff) is NEVER force-evicted — a concurrent forceMode graph-execute
 *      is refused and the original run completes untouched.
 *   2. A genuinely SILENT lock (>15s no heartbeat) IS evicted, and the evicted
 *      run's cooperative KILL checks stop it before its next order:
 *      a. revoked while leg 1 rests → order cancelled, partial fill unwound
 *      b. revoked before leg 2 → no leg-2 order, leg-1 inventory unwound
 *      c. revoked before leg 3 → no leg-3 order, held B inventory unwound
 *
 * Only Date is faked (vi.useFakeTimers({ toFake: ["Date"] })) so heartbeat
 * silence can be advanced past the 15s threshold while real timers keep the
 * executor's poll loops alive.
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

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

import arbRouter from "./arb.js";
import * as dbModule from "@workspace/db";
import * as exchangeModule from "../lib/exchange.js";
import * as orderBookModule from "../lib/order-book.js";
import * as graphEngineModule from "../lib/graph-engine.js";

const inserts = (dbModule as unknown as { __inserts: Array<{ table: unknown; values: Record<string, unknown> }> }).__inserts;
const selectRows = (dbModule as unknown as { __selectRows: unknown[] }).__selectRows;

const scanGraphOpportunities = graphEngineModule.scanGraphOpportunities as ReturnType<typeof vi.fn>;
const preflightObCycle       = orderBookModule.preflightObCycle       as ReturnType<typeof vi.fn>;
const krakenRawLimitOrder    = exchangeModule.krakenRawLimitOrder     as ReturnType<typeof vi.fn>;
const krakenRawMarketOrder   = exchangeModule.krakenRawMarketOrder    as ReturnType<typeof vi.fn>;
const krakenOrderInfo        = exchangeModule.krakenOrderInfo         as ReturnType<typeof vi.fn>;
const krakenCancelOrder      = exchangeModule.krakenCancelOrder       as ReturnType<typeof vi.fn>;
const krakenCancelAllOrders  = exchangeModule.krakenCancelAllOrders   as ReturnType<typeof vi.fn>;
const bindLockHeartbeat      = exchangeModule.bindLockHeartbeat       as ReturnType<typeof vi.fn>;

/** The ownership-scoped heartbeat the executor bound when it acquired the
 *  live lock (liveLockHeartbeat(gen)) — captured per-test from the mocked
 *  bindLockHeartbeat. Calling it mirrors what withPrivateLimiter's queue/
 *  backoff beats do inside the owner's scope. */
const boundHeartbeat = (): (() => void) => {
  const call = bindLockHeartbeat.mock.calls.at(-1);
  if (!call) throw new Error("no lock heartbeat was bound");
  return call[0] as () => void;
};

// ── Fixtures ───────────────────────────────────────────────────────────────────

const triRoute = (description: string) => ({
  description,
  hops: [
    { from: "kraken:USD",  to: "kraken:ATOM", exchange: "kraken" },
    { from: "kraken:ATOM", to: "kraken:BTC",  exchange: "kraken" },
    { from: "kraken:BTC",  to: "kraken:USD",  exchange: "kraken" },
  ],
  netProfitUsd: 1.0, profitPct: 10, startUsd: 10, executable: true, slippagePct: 0.1,
});

const makerPf = () => ({
  profitUsd: 0.30, slippagePct: 0, confidencePct: 90,
  legs: [
    { pair: "ATOMUSD",  side: "buy",  volume: 2,      limitPrice: 5 },
    { pair: "ATOMXBT",  side: "sell", volume: 2,      limitPrice: 0.0001 },
    { pair: "XXBTZUSD", side: "sell", volume: 0.0002, limitPrice: 50_000 },
  ],
  volumeA: 2, volumeB: 0.0002,
});

const kClosed = (volExec: number, cost: number, fee: number) => ({ status: "closed", volExec, price: 0, cost, fee });
const kOpen = { status: "open", volExec: 0, price: 0, cost: 0, fee: 0 };

const KEYS = { krakenKey: "k-key", krakenSecret: "k-secret" };
/** Long maker timeout so an advanced (faked) clock never expires the leg. */
const liveBody = (routeDescription: string, extra: Record<string, unknown> = {}) => ({
  ...KEYS, routeDescription, tradeSizeUsd: 10, minProfitUsd: 0, isDryRun: false,
  executionStyle: "maker", makerTimeoutMs: 120_000, maxReprices: 1, ...extra,
});

/** Deferred: hangs a mocked call until the test releases it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = process.hrtime.bigint();
  while (!cond()) {
    if (Number(process.hrtime.bigint() - start) / 1e6 > timeoutMs) throw new Error("waitUntil timed out");
    await sleep(25);
  }
}
const advanceClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

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
  preflightObCycle.mockImplementation((_a: string, _b: string, _s: number, _f: number, pricing?: string) =>
    Promise.resolve(pricing === "maker" ? makerPf() : null));
  krakenCancelOrder.mockResolvedValue(undefined);
  krakenCancelAllOrders.mockResolvedValue(0);
  krakenRawMarketOrder.mockResolvedValue({ txid: ["UNWIND-TX"] });
  // Fake ONLY Date: heartbeat silence is measured with Date.now(), while the
  // executor's poll loops use real setTimeout and must keep running.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function graphExecute(body: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}/arb/graph-execute`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("FORCE MODE lock eviction — POST /arb/graph-execute", () => {

  it("a heartbeat-live lock (long rate-limit backoff, beats every ≤5s) is NEVER force-evicted", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-ALIVE")] });
    // Run #1: leg 1 order placed, then the FIRST status poll hangs — exactly
    // like a private call stuck behind a long Kraken rate-limit backoff.
    const hang = deferred<typeof kOpen>();
    let t1Polls = 0;
    let nA = 0;
    krakenRawLimitOrder.mockImplementation(() => Promise.resolve({ txid: [`A${++nA}`] }));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => {
      if (txid === "A1") { t1Polls++; return t1Polls === 1 ? hang.promise : Promise.resolve(kClosed(2, 10, 0.01)); }
      if (txid === "A2") return Promise.resolve(kClosed(2, 0.0002, 0));
      return Promise.resolve(kClosed(0.0002, 11, 0.01));
    });

    const run1 = graphExecute(liveBody("TRI-FL-ALIVE"));
    await waitUntil(() => t1Polls >= 1);

    // 20s of wall clock pass, but the backoff loop beats the heartbeat every
    // 5s (mirroring withPrivateLimiter's ≤5s beat cadence during backoff).
    const heartbeat = boundHeartbeat();
    for (let i = 0; i < 4; i++) { advanceClock(5_000); heartbeat(); }

    // Concurrent forceMode graph-execute: the lock's heartbeat is RECENT, so
    // eviction must be refused — no CancelAll, no lock steal.
    const run2 = await graphExecute(liveBody("whatever", { forceMode: true, routeDescription: "NO-SUCH-ROUTE" }));
    expect(run2.body["success"]).toBe(false);
    expect(String(run2.body["error"])).toMatch(/RECENT heartbeat/i);
    expect(krakenCancelAllOrders).not.toHaveBeenCalled();

    // The original run still owns the lock and completes its full cycle.
    hang.resolve(kClosed(2, 10, 0.01) as typeof kOpen);
    const { body } = await run1;
    expect(body["success"]).toBe(true);
    expect(body["executed"]).toBe(true);
    expect(krakenRawLimitOrder).toHaveBeenCalledTimes(3); // all three legs placed by the ORIGINAL run
    expect(krakenRawMarketOrder).not.toHaveBeenCalled(); // nothing was unwound
  }, 30_000);

  it("a SILENT lock (>15s no heartbeat) is evicted; the evicted run cancels its resting leg-1 order and unwinds the partial fill", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-RESTING")] });
    const hang = deferred<typeof kOpen>();
    let t1Polls = 0;
    krakenRawLimitOrder.mockImplementation(() => Promise.resolve({ txid: ["B1"] }));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => {
      if (txid !== "B1") return Promise.resolve(kOpen);
      t1Polls++;
      if (t1Polls === 1) return hang.promise;                      // silent stall
      return Promise.resolve({ status: "canceled", volExec: 1, price: 0, cost: 5, fee: 0.005 }); // partial fill confirmed after cancel
    });

    const run1 = graphExecute(liveBody("TRI-FL-RESTING"));
    await waitUntil(() => t1Polls >= 1);

    // 20s of TOTAL heartbeat silence → FORCE MODE may evict.
    advanceClock(20_000);
    const run2 = await graphExecute(liveBody("whatever", { forceMode: true, routeDescription: "NO-SUCH-ROUTE" }));
    expect(run2.body["success"]).toBe(false); // its own route doesn't exist — but the eviction already happened
    expect(krakenCancelAllOrders).toHaveBeenCalledTimes(1); // dead run's open orders cancelled BEFORE eviction

    // The stalled run resumes: cooperative KILL check sees the revoked lock,
    // stops without placing ANY further order, and unwinds the partial fill.
    hang.resolve(kOpen);
    const { body } = await run1;
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/revoked|cancelled while resting/i);
    expect(krakenRawLimitOrder).toHaveBeenCalledTimes(1); // leg 1 only — never legs 2/3
    // Partial 1 ATOM unwound at market.
    expect(krakenRawMarketOrder).toHaveBeenCalledTimes(1);
    expect(krakenRawMarketOrder).toHaveBeenCalledWith(expect.anything(), "sell", 1, "ATOMUSD");
    // FAILED ledger row recorded for reconciliation — and the UNWIND order
    // appears as its own legFills entry. Its status poll here never turns
    // terminal (kOpen), so it must be recorded as accepted-but-UNCONFIRMED
    // (zero volume, txid kept) rather than vanish or block recovery.
    const failed = inserts.map(i => i.values as Record<string, unknown>).filter(v => typeof v["pair"] === "string" && (v["pair"] as string).includes("FAILED"));
    expect(failed).toHaveLength(1);
    const fills = failed[0]!["legFills"] as Array<Record<string, unknown>>;
    const unwinds = fills.filter(f => f["unwind"] === true);
    expect(unwinds).toHaveLength(1);
    expect(unwinds[0]).toMatchObject({ txid: "UNWIND-TX", side: "sell", pair: "ATOMUSD", volume: 0 });
    expect(String(unwinds[0]!["label"])).toMatch(/unconfirmed/i);
  }, 30_000);

  it("evicted between legs 1 and 2 → cooperative check aborts BEFORE leg 2 and unwinds leg-1 inventory", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-PRELEG2")] });
    const hang = deferred<typeof kOpen>();
    let t1Polls = 0;
    krakenRawLimitOrder.mockImplementation(() => Promise.resolve({ txid: ["C1"] }));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => {
      if (txid === "UNWIND-TX") return Promise.resolve(kClosed(2, 9.9, 0.01)); // unwind sell confirms
      if (txid !== "C1") return Promise.resolve(kOpen);
      t1Polls++;
      return t1Polls === 1 ? hang.promise : Promise.resolve(kClosed(2, 10, 0.01));
    });

    const run1 = graphExecute(liveBody("TRI-FL-PRELEG2"));
    await waitUntil(() => t1Polls >= 1);

    advanceClock(20_000); // silent → evictable
    await graphExecute(liveBody("whatever", { forceMode: true, routeDescription: "NO-SUCH-ROUTE" }));
    expect(krakenCancelAllOrders).toHaveBeenCalledTimes(1);

    // Leg 1 completes FULLY on resume — the revocation is only caught by the
    // cooperative check between legs 1 and 2.
    hang.resolve(kClosed(2, 10, 0.01) as typeof kOpen);
    const { body } = await run1;
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/before leg 2/i);
    expect(String(body["error"])).toMatch(/unwound/i);
    expect(krakenRawLimitOrder).toHaveBeenCalledTimes(1); // no leg-2 order ever placed
    expect(krakenRawMarketOrder).toHaveBeenCalledTimes(1);
    expect(krakenRawMarketOrder).toHaveBeenCalledWith(expect.anything(), "sell", 2, "ATOMUSD"); // full leg-1 fill unwound
    // The unwind's CONFIRMED fill appears as its own legFills entry (unwind: true)
    // in the FAILED ledger row — actual volExec/cost/fee/txid, not the request.
    const failed = inserts.map(i => i.values as Record<string, unknown>).filter(v => typeof v["pair"] === "string" && (v["pair"] as string).includes("FAILED"));
    expect(failed).toHaveLength(1);
    const fills = failed[0]!["legFills"] as Array<Record<string, unknown>>;
    const unwinds = fills.filter(f => f["unwind"] === true);
    expect(unwinds).toHaveLength(1);
    expect(unwinds[0]).toMatchObject({ txid: "UNWIND-TX", side: "sell", pair: "ATOMUSD", volume: 2, costUsd: 9.9, fee: 0.01 });
  }, 30_000);

  it("evicted between legs 2 and 3 → cooperative check aborts BEFORE leg 3 and unwinds held B inventory", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-FL-PRELEG3")] });
    const hang = deferred<typeof kOpen>();
    let t2Polls = 0;
    let n = 0;
    krakenRawLimitOrder.mockImplementation(() => Promise.resolve({ txid: [`D${++n}`] }));
    krakenOrderInfo.mockImplementation((_c: unknown, txid: string) => {
      if (txid === "D1") return Promise.resolve(kClosed(2, 10, 0.01)); // leg 1 fills instantly
      if (txid === "D2") {
        t2Polls++;
        return t2Polls === 1 ? hang.promise : Promise.resolve(kClosed(2, 0.0002, 0)); // leg 2: 2 ATOM → 0.0002 BTC
      }
      return Promise.resolve(kOpen);
    });

    const run1 = graphExecute(liveBody("TRI-FL-PRELEG3"));
    await waitUntil(() => t2Polls >= 1);

    advanceClock(20_000); // silent → evictable
    await graphExecute(liveBody("whatever", { forceMode: true, routeDescription: "NO-SUCH-ROUTE" }));
    expect(krakenCancelAllOrders).toHaveBeenCalledTimes(1);

    hang.resolve(kClosed(2, 0.0002, 0) as typeof kOpen);
    const { body } = await run1;
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/before leg 3/i);
    expect(String(body["error"])).toMatch(/unwound/i);
    expect(krakenRawLimitOrder).toHaveBeenCalledTimes(2); // legs 1+2 only — no leg-3 order
    expect(krakenRawMarketOrder).toHaveBeenCalledTimes(1);
    expect(krakenRawMarketOrder).toHaveBeenCalledWith(expect.anything(), "sell", 0.0002, "XXBTZUSD"); // held BTC unwound
  }, 30_000);
});
