/**
 * KILL / HARD RESET safety while a maker leg RESTS — proof that a revoked
 * run can never place a NEW order.
 *
 * Revocation here is the HARD RESET path (POST /arb/exec-lock/clear →
 * forceReleaseLiveLock), the money-critical property flagged by code review
 * of the resting/chasing leg-1 flow:
 *   1. Lock revoked WHILE leg 1 rests → the run cancels its OWN order, places
 *      no taker fallback (no krakenRawIocLimitOrder / market completion), and
 *      unwinds ONLY the actual confirmed partial fill.
 *   2. Adopted-lock path (graph-execute holds the lock → runKrakenTriangle
 *      heldLockGen): when the generation is already stale before leg 1, the
 *      run aborts with ZERO orders placed.
 *   3. Chase re-join (repriceTo): a revoke landing during the cancel-confirm
 *      window of a reprice must block the re-placement — exactly one limit
 *      order ever reaches Kraken.
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
    routeGateStateTable: { __name: "route_gate_state", accountId: "accountId", style: "style", route: "route", failStreak: "failStreak", blacklistedUntilMs: "blacklistedUntilMs", updatedAt: "updatedAt", id: "id" },
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
const makerQuote             = orderBookModule.makerQuote             as ReturnType<typeof vi.fn>;
const krakenRawLimitOrder    = exchangeModule.krakenRawLimitOrder     as ReturnType<typeof vi.fn>;
const krakenRawMarketOrder   = exchangeModule.krakenRawMarketOrder    as ReturnType<typeof vi.fn>;
const krakenRawIocLimitOrder = exchangeModule.krakenRawIocLimitOrder  as ReturnType<typeof vi.fn>;
const krakenOrderInfo        = exchangeModule.krakenOrderInfo         as ReturnType<typeof vi.fn>;
const krakenCancelOrder      = exchangeModule.krakenCancelOrder       as ReturnType<typeof vi.fn>;

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

const kOpen = { status: "open", volExec: 0, price: 0, cost: 0, fee: 0 };
const kCanceled = (volExec: number, cost: number, fee: number) => ({ status: "canceled", volExec, price: 0, cost, fee });

const KEYS = { krakenKey: "k-key", krakenSecret: "k-secret" };
/** Long maker/rest windows so the resting order never times out on its own —
 *  ONLY the revocation may end it. */
const liveBody = (routeDescription: string, extra: Record<string, unknown> = {}) => ({
  ...KEYS, routeDescription, tradeSizeUsd: 10, minProfitUsd: 0, isDryRun: false,
  executionStyle: "maker", makerTimeoutMs: 120_000, maxReprices: 4, leg1RestMs: 120_000, ...extra,
});

/** Deferred: hangs a mocked call until the test releases it. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await sleep(25);
  }
}

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
  makerQuote.mockResolvedValue(null);
  krakenCancelOrder.mockResolvedValue(undefined);
  krakenRawMarketOrder.mockResolvedValue({ txid: ["UNWIND-TX"] });
});

async function graphExecute(body: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}/arb/graph-execute`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

/** HARD RESET: force-clears the live execution lock (forceReleaseLiveLock). */
async function hardReset() {
  const r = await fetch(`${baseUrl}/arb/exec-lock/clear`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(KEYS),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("KILL / HARD RESET while a maker leg rests — no new orders ever", () => {

  it("revoked while leg 1 rests → own order cancelled, actual partial fill unwound, NO taker fallback / further orders", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-KILL-REST")] });
    let polls = 0;
    let cancelled = false;
    krakenRawLimitOrder.mockResolvedValue({ txid: ["L1"] });
    krakenCancelOrder.mockImplementation(() => { cancelled = true; return Promise.resolve(undefined); });
    krakenOrderInfo.mockImplementation(() => {
      polls++;
      // Order rests (open) until the run cancels it after revocation — the
      // cancel race left a CONFIRMED partial fill of 1/2 ATOM.
      return Promise.resolve(cancelled ? kCanceled(1, 5, 0.01) : kOpen);
    });

    const run = graphExecute(liveBody("TRI-KILL-REST"));
    await waitUntil(() => polls >= 2); // leg-1 order is resting

    // HARD RESET revokes the lock out from under the resting run.
    const reset = await hardReset();
    expect(reset.body["cleared"]).toBe(true);
    expect(reset.body["wasHeld"]).toBe(true);

    const { body } = await run;
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/revoked/i);
    // The run cancelled its OWN resting order…
    expect(krakenCancelOrder).toHaveBeenCalledWith(expect.anything(), "L1");
    // …and placed NO new cycle-advancing order afterward: exactly one limit
    // order (leg 1), no taker fallback, no IOC, no legs 2/3.
    expect(krakenRawLimitOrder).toHaveBeenCalledTimes(1);
    expect(krakenRawIocLimitOrder).not.toHaveBeenCalled();
    // The ONLY market order is the unwind of the ACTUAL confirmed partial (1 ATOM).
    expect(krakenRawMarketOrder).toHaveBeenCalledTimes(1);
    expect(krakenRawMarketOrder).toHaveBeenCalledWith(expect.anything(), "sell", 1, "ATOMUSD");
    // FAILED ledger row keeps the revoked run's evidence.
    const failed = inserts.map(i => i.values as Record<string, unknown>).filter(v => typeof v["pair"] === "string" && (v["pair"] as string).includes("FAILED"));
    expect(failed).toHaveLength(1);
  }, 30_000);

  it("adopted lock (graph-execute → heldLockGen) already stale → aborts BEFORE placing leg 1, zero orders", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-KILL-ADOPT")] });
    // Hang the executor's maker pre-flight: the lock was acquired by
    // graph-execute BEFORE runKrakenTriangle, so a HARD RESET during this
    // window makes the adopted generation stale before any order.
    const hang = deferred<ReturnType<typeof makerPf>>();
    let pfCalls = 0;
    preflightObCycle.mockImplementation((_a: string, _b: string, _s: number, _f: number, pricing?: string) => {
      if (pricing !== "maker") return Promise.resolve(null);
      pfCalls++;
      return pfCalls === 1 ? hang.promise : Promise.resolve(makerPf());
    });

    const run = graphExecute(liveBody("TRI-KILL-ADOPT"));
    await waitUntil(() => pfCalls >= 1); // lock held, pre-flight in flight

    const reset = await hardReset();
    expect(reset.body["wasHeld"]).toBe(true);

    hang.resolve(makerPf()); // pre-flight passes — but the adopted lock is stale
    const { body } = await run;
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/before any order was placed|revoked/i);
    // NOTHING was ever sent to the exchange.
    expect(krakenRawLimitOrder).not.toHaveBeenCalled();
    expect(krakenRawMarketOrder).not.toHaveBeenCalled();
    expect(krakenRawIocLimitOrder).not.toHaveBeenCalled();
  }, 30_000);

  it("chase re-join (repriceTo) is blocked when the revoke lands in the cancel-confirm window — exactly ONE limit order", async () => {
    scanGraphOpportunities.mockResolvedValue({ routes: [triRoute("TRI-KILL-CHASE")] });
    // makerQuote: null at placement (order joins at 5), then a BETTER price
    // (5.01) on the first resting edge-check → triggers the repriceTo chase.
    let quoted = false;
    makerQuote.mockImplementation(() => {
      if (!quoted) { quoted = true; return Promise.resolve(null); }
      return Promise.resolve({ price: 5.01, bestBid: 5, bestAsk: 5.02, queueAheadVol: 1 });
    });
    let cancelled = false;
    const confirmGate = deferred<void>();
    krakenRawLimitOrder.mockResolvedValue({ txid: ["C1"] });
    krakenCancelOrder.mockImplementation(() => { cancelled = true; return Promise.resolve(undefined); });
    krakenOrderInfo.mockImplementation(async () => {
      if (!cancelled) return kOpen; // resting until the chase cancels it
      // Cancel-confirm poll: hold it open until the test revokes the lock,
      // then report a clean zero-fill cancel — the chase would now re-join.
      await confirmGate.promise;
      return kCanceled(0, 0, 0);
    });

    const run = graphExecute(liveBody("TRI-KILL-CHASE", { edgeCheckMs: 1_000 }));
    await waitUntil(() => cancelled, 20_000); // reprice chase began: own order cancel in flight

    // Revoke DURING the cancel-confirm window, then let the confirm land.
    const reset = await hardReset();
    expect(reset.body["wasHeld"]).toBe(true);
    confirmGate.resolve();

    const { body } = await run;
    expect(body["success"]).toBe(false);
    expect(String(body["error"])).toMatch(/revoked/i);
    // The chase re-join was BLOCKED: only the original leg-1 order exists.
    expect(krakenRawLimitOrder).toHaveBeenCalledTimes(1);
    expect(krakenRawIocLimitOrder).not.toHaveBeenCalled();
    // Zero-fill cancel → nothing to unwind, and no other market order fired.
    expect(krakenRawMarketOrder).not.toHaveBeenCalled();
  }, 30_000);
});
