/**
 * Tests for the ETHSOL market availability guard in POST /arb/execute-triangular.
 *
 * Key assertions:
 * 1. Live ETH execution is blocked (200 + success:false) when ETH/SOL rates are synthetic
 *    — a synthetic cross rate cannot be submitted as a real ETHSOL order book price.
 * 2. No Kraken private order function (krakenRawMarketOrder / krakenRawLimitOrder)
 *    is called when execution is blocked.
 * 3. Dry-run mode still proceeds when rates are synthetic (estimation only, no orders).
 * 4. Direct ETH/SOL rates allow the guard to pass normally.
 */
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// ── Mock all external dependencies BEFORE importing the router ─────────────────

vi.mock("../lib/price-cache.js", () => ({
  getTriPrices:       vi.fn(),
  getBtcTriPrices:    vi.fn(() => null),
  getBestPairPrices:  vi.fn(),
  scanAllPairs:       vi.fn(() => Promise.resolve([])),
  getPairPrices:      vi.fn(),
  getAllPairSnapshots: vi.fn(() => []),
  initPriceFeeds:     vi.fn(),
  PAIRS: [] as string[],
}));

vi.mock("../lib/exchange.js", () => ({
  getKrakenPrice:           vi.fn(),
  getKrakenBalances:        vi.fn(() => Promise.resolve([{ currency: "ZUSD", amount: 1000 }])),
  krakenCancelAllOrders:    vi.fn(() => Promise.resolve(0)),
  setPrivateCallHeartbeat:  vi.fn(),
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
  krakenAccountValueUsd:    vi.fn(() => Promise.resolve({ totalUsd: 0, usdBalance: 0, holdingsUsd: 0, holdings: [], unpriced: [] })),
  krakenNetCashFlowUsd:     vi.fn(() => Promise.resolve({ netUsd: 0, entries: 0, approximated: false, complete: true })),
  coinbaseAccountValueUsd:  vi.fn(() => Promise.resolve({ totalUsd: 0, usdBalance: 0, holdingsUsd: 0, unpriced: [] })),
  getCoinbaseBalances:      vi.fn(),
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
  PAIRS: [] as string[],
}));

vi.mock("@workspace/db", () => {
  const valuesStub = vi.fn(() => Promise.resolve());
  const insertStub = vi.fn(() => ({ values: valuesStub }));
  const totalRow = [{ total: 0 }];
  const selectStub = vi.fn(() => ({
    from: vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve([])) })),
      })),
    })),
    // aggregate select path: select({ total: count() }).from(...) → [{ total: 0 }]
  }));
  return {
    db: { insert: insertStub, select: selectStub },
    tradesTable:  {},
    triScanTable: {},
    desc:   (..._: unknown[]) => undefined,
    sql:    (..._: unknown[]) => undefined,
    sum:    (..._: unknown[]) => undefined,
    count:  (..._: unknown[]) => undefined,
    max:    (..._: unknown[]) => undefined,
    avg:    (..._: unknown[]) => undefined,
  };
});

vi.mock("@workspace/api-zod", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@workspace/api-zod")>();
  return mod;
});

vi.mock("../lib/order-book.js", () => ({
  scanOrderBookCycles: vi.fn(() => Promise.resolve({ cycles: [] })),
  preflightObCycle:    vi.fn(),
  OB_ASSETS:           [] as string[],
  OB_USD_PAIRS:        {} as Record<string, string>,
  CROSS_LOOKUP:        new Map(),
}));

vi.mock("../lib/graph-engine.js", () => ({
  scanGraphOpportunities: vi.fn(() => Promise.resolve({ routes: [] })),
}));

vi.mock("../lib/kalman.js", () => ({
  createPairHistory: vi.fn(),
  updatePairHistory: vi.fn(),
}));

vi.mock("../lib/tri-fill.js", () => ({
  waitForTriLimitFill: vi.fn(),
}));

import arbRouter from "./arb.js";
import * as priceCacheModule from "../lib/price-cache.js";
import * as exchangeModule from "../lib/exchange.js";

// ── Test server ────────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;

const getTriPrices = priceCacheModule.getTriPrices as ReturnType<typeof vi.fn>;
const krakenRawMarketOrder = exchangeModule.krakenRawMarketOrder as ReturnType<typeof vi.fn>;
const krakenRawLimitOrder  = exchangeModule.krakenRawLimitOrder  as ReturnType<typeof vi.fn>;

// ── Sample price fixtures ──────────────────────────────────────────────────────

const SYNTHETIC_KRAKEN_TRI = {
  solBid: 150.00, solAsk: 150.50,
  ethBid: 3000.00, ethAsk: 3001.00,
  // synthetic: ethBid / solAsk, ethAsk / solBid
  ethSolBid: 3000 / 150.50,
  ethSolAsk: 3001 / 150.00,
  ethSolSource: "synthetic" as const,
};

const DIRECT_KRAKEN_TRI = {
  ...SYNTHETIC_KRAKEN_TRI,
  // direct market bid/ask (slightly different to model real spread)
  ethSolBid: 19.85,
  ethSolAsk: 19.90,
  ethSolSource: "direct" as const,
};

const BASE_ETH_BODY = {
  krakenKey:    "test-key",
  krakenSecret: "test-secret",
  loop:         "USD→SOL→ETH→USD",
  tradeUsd:     10,
  isDryRun:     false,
  orderType:    "market",
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Inject a mock pino-style request logger — the router calls req.log.info/warn/error
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>)["log"] = {
      info:  vi.fn(),
      error: vi.fn(),
      warn:  vi.fn(),
    };
    next();
  });
  app.use(arbRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://localhost:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default stubs so tests that pass the guard don't crash on order calls
  krakenRawMarketOrder.mockResolvedValue({ txid: ["TEST-TXN-001"] });
  krakenRawLimitOrder.mockResolvedValue({ txid: ["TEST-TXN-001"] });
});

// ── Helper ─────────────────────────────────────────────────────────────────────

async function postExecuteTriangular(body: Record<string, unknown>) {
  const r = await fetch(`${baseUrl}/arb/execute-triangular`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /arb/execute-triangular — ETHSOL market guard", () => {

  describe("live execution blocked when ETH/SOL market is unavailable", () => {

    it("returns success:false when WS cache reports synthetic rates and isDryRun=false", async () => {
      getTriPrices.mockReturnValue({ kraken: SYNTHETIC_KRAKEN_TRI, coinbase: null });

      const { status, body } = await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: false });

      expect(status).toBe(200);
      expect(body["success"]).toBe(false);
      expect(body["executed"]).toBeFalsy();
      expect(body["estimatedProfitUsd"]).toBeNull();
      expect(body["error"]).toMatch(/direct market is currently unavailable/i);
      expect(body["synthetic"]).toBe(true);
      expect(body["priceSource"]).toBe("synthetic");
    });

    it("does NOT call krakenRawMarketOrder when live execution is blocked by synthetic guard", async () => {
      getTriPrices.mockReturnValue({ kraken: SYNTHETIC_KRAKEN_TRI, coinbase: null });

      await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: false });

      // The safeguard must fire BEFORE any Kraken private API call
      expect(krakenRawMarketOrder).not.toHaveBeenCalled();
    });

    it("does NOT call krakenRawLimitOrder when live limit-order execution is blocked by synthetic guard", async () => {
      getTriPrices.mockReturnValue({ kraken: SYNTHETIC_KRAKEN_TRI, coinbase: null });

      await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: false, orderType: "limit" });

      expect(krakenRawLimitOrder).not.toHaveBeenCalled();
    });

    it("blocks live execution when REST fallback also returns no ETHSOL key (synthesises cross rate)", async () => {
      // WS cache miss → route falls back to Kraken REST
      getTriPrices.mockReturnValue({ kraken: null, coinbase: null });

      // Intercept only outbound Kraken requests; pass local test requests through
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input
                    : input instanceof URL     ? input.href
                    :                            (input as Request).url;
          // Kraken REST → return ETH+SOL USD pairs but no ETHSOL key
          if (url.includes("api.kraken.com") && url.includes("Ticker")) {
            return Promise.resolve(
              new Response(JSON.stringify({
                error: ["EQuery:Unknown asset pair"],   // ETHSOL unknown
                result: {
                  "XETHZUSD": { b: ["3000.00"], a: ["3001.00"] },
                  "SOLUSD":   { b: ["150.00"],  a: ["150.50"]  },
                  // ETHSOL key intentionally absent
                },
              }), { status: 200, headers: { "Content-Type": "application/json" } })
            );
          }
          // Local test server or anything else — pass through
          return realFetch(input, init);
        },
      );

      const { status, body } = await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: false });

      vi.restoreAllMocks();

      expect(status).toBe(200);
      expect(body["success"]).toBe(false);
      expect(body["error"]).toMatch(/direct market is currently unavailable/i);
      expect(body["synthetic"]).toBe(true);
      expect(krakenRawMarketOrder).not.toHaveBeenCalled();
    });

  });

  describe("dry-run mode is allowed even with synthetic rates", () => {

    it("returns HTTP 200 success for dry-run when rates are synthetic", async () => {
      getTriPrices.mockReturnValue({ kraken: SYNTHETIC_KRAKEN_TRI, coinbase: null });

      const { status, body } = await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: true });

      expect(status).toBe(200);
      expect(body["success"]).toBe(true);
      expect(body["isDryRun"]).toBe(true);
    });

    it("flags synthetic=true in dry-run response so caller knows rates are estimated", async () => {
      getTriPrices.mockReturnValue({ kraken: SYNTHETIC_KRAKEN_TRI, coinbase: null });

      const { body } = await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: true });

      expect(body["synthetic"]).toBe(true);
      expect(body["priceSource"]).toBe("synthetic");
    });

    it("does NOT call any Kraken order function during a synthetic dry-run", async () => {
      getTriPrices.mockReturnValue({ kraken: SYNTHETIC_KRAKEN_TRI, coinbase: null });

      await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: true });

      expect(krakenRawMarketOrder).not.toHaveBeenCalled();
      expect(krakenRawLimitOrder).not.toHaveBeenCalled();
    });

  });

  describe("direct ETH/SOL rates pass the guard", () => {

    it("does not return the 'direct market unavailable' error when rates are direct", async () => {
      getTriPrices.mockReturnValue({ kraken: DIRECT_KRAKEN_TRI, coinbase: null });

      const { body } = await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: false });

      // The synthetic guard was cleared — error should not mention market unavailability
      const err = String(body["error"] ?? "");
      expect(err).not.toMatch(/direct market is currently unavailable/i);
    });

    it("returns priceSource=direct in dry-run response when rates are direct", async () => {
      getTriPrices.mockReturnValue({ kraken: DIRECT_KRAKEN_TRI, coinbase: null });

      const { body } = await postExecuteTriangular({ ...BASE_ETH_BODY, isDryRun: true });

      expect(body["priceSource"]).toBe("direct");
      expect(body["synthetic"]).toBeFalsy();
    });

  });

});
