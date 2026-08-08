/**
 * Account-scope isolation proof (trading safety): one trader's fill history
 * must NEVER rank or block another trader's routes.
 *
 * Uses the REAL database (the account filter lives in the SQL where-clause —
 * a mocked db would only test the mock). Seeds execution_quality with
 * CONFLICTING histories for the SAME route under two accountIds:
 *   account A: every live attempt filled   → fill rate 1.0
 *   account B: every live attempt unfilled → fill rate 0.0
 * and asserts:
 *   1. /arb/graph-scan ranking (histFillRate / effectiveScoreUsd, and the
 *      resulting route ORDER) differs per account and never crosses;
 *   2. no accountId → neutral 0.7 prior, no history leaks;
 *   3. "legacy" rows (pre-scoping, unknown owner) never influence ANY scoped
 *      account's ranking or gate;
 *   4. the graph-execute feedback-loop gate (routeQualityPenalty) blocks B's
 *      route on B's history while A — and a fresh third account — pass the
 *      gate on the identical route.
 *
 * All seeded rows use a unique per-run route-name nonce and are deleted in
 * afterAll, so the test never touches real execution history.
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// ── Mock all external dependencies EXCEPT the database ────────────────────────

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
  coinbaseIocLimitOrder:    vi.fn(),
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
  PAIRS: ["SOL/USD"] as string[],
}));

vi.mock("../lib/order-book.js", () => ({
  scanOrderBookCycles: vi.fn(() => Promise.resolve({ cycles: [] })),
  preflightObCycle:    vi.fn(),
  discoverCrossPairs:  vi.fn(() => Promise.resolve({ lookup: new Map(), crossMap: [], cachedAt: 1 })),
  freshJoinPrice:      vi.fn(() => Promise.resolve(null)),
  makerQuote:          vi.fn(() => Promise.resolve(null)),
  takerCycleBreakdown: vi.fn(() => Promise.resolve(null)),
  cachedTakerCycleBreakdown: vi.fn(() => Promise.resolve(null)),
  getEventScan:        vi.fn(() => null),
  krakenStreamStats:   vi.fn(() => ({})),
  getStreamBook:       vi.fn(() => null),
  waitForBookTouch:    vi.fn(() => Promise.resolve(null)),
  formatLegAges:       vi.fn(() => ""),
  OB_ASSETS:           ["BTC", "ETH", "SOL"] as string[],
  OB_USD_PAIRS:        { BTC: "XXBTZUSD", ETH: "XETHZUSD", SOL: "SOLUSD" } as Record<string, string>,
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
}));

import arbRouter from "./arb.js";
import { db, pool, executionQualityTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as graphEngineModule from "../lib/graph-engine.js";

const scanGraphOpportunities = graphEngineModule.scanGraphOpportunities as ReturnType<typeof vi.fn>;

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** EXACT mirror of the server's accountIdFromKey (arb.ts). */
const accountIdFromKey = (krakenKey: string, coinbaseKey?: string): string =>
  createHash("sha256").update(`${krakenKey}|${coinbaseKey ?? ""}`).digest("hex").slice(0, 16);

const NONCE = `TEST99-${Date.now()}`;
const R_SCAN   = `${NONCE} USD[K]→SOL[K]→USD[C] scan`;
const R_LEGACY = `${NONCE} USD[K]→ETH[K]→USD[C] legacy`;
const R_GATE   = `${NONCE} USD[K]→SOL[K]→USD[C] gate`;

const KEY_A = `${NONCE}-kraken-key-A`;
const KEY_B = `${NONCE}-kraken-key-B`;
const KEY_C = `${NONCE}-kraken-key-C`; // fresh account, zero history
const ID_A = accountIdFromKey(KEY_A);
const ID_B = accountIdFromKey(KEY_B);

/** 2-leg cross-exchange inventory route (buy Kraken → bridge → sell Coinbase).
 *  Deliberately NOT a Kraken triangle: for cross shapes the feedback-loop
 *  gate runs with allowProbe=false and currentNetUsd=0, so a bad history
 *  blocks deterministically (no probe, no big-edge bypass). */
const crossRoute = (description: string, netProfitUsd: number) => ({
  description,
  hops: [
    { from: "kraken:USD",   to: "kraken:SOL",   exchange: "kraken",   side: "buy",  pair: "SOLUSD", amountOut: 0.06 },
    { from: "kraken:SOL",   to: "coinbase:SOL", exchange: "bridge" },
    { from: "coinbase:SOL", to: "coinbase:USD", exchange: "coinbase", side: "sell", amountOut: netProfitUsd + 10 },
  ],
  netProfitUsd, profitPct: netProfitUsd * 10, startUsd: 10, executable: true, slippagePct: 0, status: "VIABLE",
});

const seedRows = (accountId: string, route: string, style: string, filled: boolean, n: number) =>
  db.insert(executionQualityTable).values(Array.from({ length: n }, () => ({
    accountId, route, style, isDryRun: false, filled,
    tradeSizeUsd: "10.00", expectedProfitUsd: "0.500000",
    realizedProfitUsd: null, slippagePct: null, legsFilled: null, note: "account-scope regression seed",
  })));

// ── Test server ────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  // Conflicting histories for the SAME routes under two accounts, plus
  // pre-scoping "legacy" rows on a separate route.
  await seedRows(ID_A, R_SCAN, "maker", true, 12);
  await seedRows(ID_B, R_SCAN, "maker", false, 12);
  await seedRows("legacy", R_LEGACY, "maker", true, 10);
  await seedRows(ID_A, R_GATE, "taker", true, 12);
  await seedRows(ID_B, R_GATE, "taker", false, 12);
  // Dead legacy history on the gate route: must not block ANY scoped account.
  await seedRows("legacy", R_GATE, "taker", false, 12);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: object }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(arbRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await db.delete(executionQualityTable).where(sql`${executionQualityTable.route} like ${`${NONCE}%`}`);
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await pool.end();
});

type ScanRoute = { description: string; netProfitUsd: number; histLiveAttempts: number; histFillRate: number | null; effectiveScoreUsd: number };

const graphScan = async (accountId?: string): Promise<ScanRoute[]> => {
  // Fresh route objects per call — the handler mutates them in place.
  scanGraphOpportunities.mockResolvedValue({ routes: [crossRoute(R_SCAN, 1.0), crossRoute(R_LEGACY, 0.6)] });
  const q = new URLSearchParams({ tradeSizeUsd: "10", executionStyle: "maker", ...(accountId ? { accountId } : {}) });
  const res = await fetch(`${baseUrl}/arb/graph-scan?${q}`);
  expect(res.status).toBe(200);
  const body = await res.json() as { routes: ScanRoute[] };
  return body.routes;
};

const graphExecute = async (krakenKey: string, extra: Record<string, unknown> = {}): Promise<{ error: string | null }> => {
  scanGraphOpportunities.mockResolvedValue({ routes: [crossRoute(R_GATE, 1.0)] });
  const res = await fetch(`${baseUrl}/arb/graph-execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      krakenKey, krakenSecret: "s", routeDescription: R_GATE,
      tradeSizeUsd: 10, minProfitUsd: 0.01, isDryRun: false, executionStyle: "taker",
      // No Coinbase creds by default: an account that PASSES the gate stops
      // safely at the "Coinbase credentials required" check — no orders, no
      // DB writes.
      ...extra,
    }),
  });
  expect(res.status).toBe(200);
  return await res.json() as { error: string | null };
};

// ── Scan ranking isolation ─────────────────────────────────────────────────────

describe("graph-scan fill-rate ranking is account-scoped", () => {
  it("account A sees ONLY its own perfect history (fillRate 1.0, undiscounted score)", async () => {
    const routes = await graphScan(ID_A);
    const r = routes.find((x) => x.description === R_SCAN)!;
    expect(r.histLiveAttempts).toBe(12);
    expect(r.histFillRate).toBe(1);
    expect(r.effectiveScoreUsd).toBeCloseTo(1.0, 6); // net × 1.0 — B's 0/12 never leaked in
    // Ranking: A's 1.0-score route outranks the 0.6 legacy route.
    expect(routes.map((x) => x.description).indexOf(R_SCAN)).toBeLessThan(routes.map((x) => x.description).indexOf(R_LEGACY));
  });

  it("account B sees ONLY its own dead history (fillRate 0, score 0) for the SAME route", async () => {
    const routes = await graphScan(ID_B);
    const r = routes.find((x) => x.description === R_SCAN)!;
    expect(r.histLiveAttempts).toBe(12);
    expect(r.histFillRate).toBe(0);
    expect(r.effectiveScoreUsd).toBe(0); // net × 0 — A's 12/12 never leaked in
    // Ranking flips: for B the legacy route (0.6) outranks the dead route (0).
    expect(routes.map((x) => x.description).indexOf(R_LEGACY)).toBeLessThan(routes.map((x) => x.description).indexOf(R_SCAN));
  });

  it("no accountId → neutral 0.7 prior; nobody's history is used", async () => {
    const routes = await graphScan();
    const r = routes.find((x) => x.description === R_SCAN)!;
    expect(r.histLiveAttempts).toBe(0);
    expect(r.histFillRate).toBeNull();
    expect(r.effectiveScoreUsd).toBeCloseTo(0.7, 6);
  });

  it('"legacy" (pre-scoping, unknown-owner) rows never influence ANY scoped account', async () => {
    // R_LEGACY has 10 filled "legacy" rows and NOTHING under A or B. If
    // legacy rows leaked into scoped stats, A/B would see fillRate 1 here.
    for (const id of [ID_A, ID_B]) {
      const r = (await graphScan(id)).find((x) => x.description === R_LEGACY)!;
      expect(r.histLiveAttempts).toBe(0);
      expect(r.histFillRate).toBeNull();
      expect(r.effectiveScoreUsd).toBeCloseTo(0.6 * 0.7, 6); // neutral prior only
    }
  });
});

// ── Feedback-loop gate isolation ───────────────────────────────────────────────

describe("graph-execute feedback-loop gate is account-scoped", () => {
  it("blocks account B on ITS OWN 0/12 live history", async () => {
    const out = await graphExecute(KEY_B);
    expect(out.error).toContain("Feedback-loop gate");
    expect(out.error).toContain("0/12");
  });

  it("account A passes the gate on the IDENTICAL route despite B's dead history", async () => {
    const out = await graphExecute(KEY_A);
    expect(out.error ?? "").not.toContain("Feedback-loop gate");
    // A got PAST the gate and stopped at the later credentials check.
    expect(out.error).toContain("Coinbase API credentials are required");
  });

  it("a fresh account with NO history is not blocked by B's failures either", async () => {
    const out = await graphExecute(KEY_C);
    expect(out.error ?? "").not.toContain("Feedback-loop gate");
    expect(out.error).toContain("Coinbase API credentials are required");
  });

  it("a Coinbase key WITHOUT its secret does not fork the scope — B's own history still gates B", async () => {
    // B's 0/12 rows were recorded under hash(krakenB|). If a lone Coinbase
    // key changed the gate's scope, B's own dead history would become
    // invisible to B's own gate. Canonical rule: no secret → same scope.
    const out = await graphExecute(KEY_B, { coinbaseKey: `${NONCE}-cb-key-without-secret` });
    expect(out.error).toContain("Feedback-loop gate");
    expect(out.error).toContain("0/12");
  });

  it("with BOTH Coinbase key and secret the scope legitimately differs (fresh combined account)", async () => {
    const out = await graphExecute(KEY_B, { coinbaseKey: `${NONCE}-cb-key`, coinbaseSecret: "cb-secret" });
    // hash(krakenB|cbKey) has no history → gate passes; execution proceeds
    // past the credentials check and stops at the stream pre-fire (mocked
    // books unavailable) — no orders, no quality rows recorded.
    expect(out.error ?? "").not.toContain("Feedback-loop gate");
  });
});
