import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { krakenNetCashFlowUsd, krakenDailyCloses } from "./exchange";

// Deposit-day historical pricing for non-USD ledger flows: each entry must be
// valued at its own day's OHLC close, with a flagged current-price fallback
// only when the historical candle is missing.

const DAY = 86_400;
const day0 = 1_700_000_000 - (1_700_000_000 % DAY); // aligned UTC day start

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const creds = { krakenKey: "test-key-cashflow-" + Math.random(), krakenSecret: Buffer.from("secret").toString("base64") };

let fetchMock: ReturnType<typeof vi.fn>;
let ohlcCalls: string[];

beforeEach(() => {
  ohlcCalls = [];
  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/0/private/Ledgers")) {
      return jsonResponse({
        error: [],
        result: {
          count: 3,
          ledger: {
            L1: { refid: "r1", time: day0 + 100, type: "deposit", asset: "SOL", amount: "2.0", fee: "0" },
            L2: { refid: "r2", time: day0 + DAY + 100, type: "withdrawal", asset: "SOL", amount: "-1.0", fee: "0" },
            L3: { refid: "r3", time: day0 + 200, type: "deposit", asset: "ZUSD", amount: "50", fee: "0" },
          },
        },
      });
    }
    if (url.includes("/0/public/OHLC")) {
      ohlcCalls.push(url);
      return jsonResponse({
        error: [],
        result: {
          SOLUSD: [
            [day0, "0", "0", "0", "100", "0", "0", 1],       // deposit-day close $100
            [day0 + DAY, "0", "0", "0", "120", "0", "0", 1], // withdrawal-day close $120
          ],
          last: day0 + DAY,
        },
      });
    }
    if (url.includes("/0/public/Ticker")) {
      return jsonResponse({ error: [], result: { SOLUSD: { c: ["200", "1"] } } });
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("krakenNetCashFlowUsd historical pricing", () => {
  it("values each non-USD entry at its own day's OHLC close (not current price)", async () => {
    const cf = await krakenNetCashFlowUsd(creds, day0);
    // 2 SOL × $100 − 1 SOL × $120 + $50 USD = 130
    expect(cf.netUsd).toBeCloseTo(130, 6);
    expect(cf.approximated).toBe(false);
    expect(cf.complete).toBe(true);
    expect(cf.entries).toBe(3);
  });

  it("falls back to current price and flags approximated when OHLC is unavailable", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/0/private/Ledgers")) {
        return jsonResponse({
          error: [],
          result: {
            count: 1,
            ledger: { L1: { refid: "r1", time: day0 + 100, type: "deposit", asset: "ETH", amount: "2.0", fee: "0" } },
          },
        });
      }
      if (url.includes("/0/public/OHLC")) return jsonResponse({ error: ["EService:Unavailable"], result: {} });
      if (url.includes("/0/public/Ticker")) return jsonResponse({ error: [], result: { ETHUSD: { c: ["200", "1"] } } });
      throw new Error("unexpected fetch: " + url);
    });
    const cf = await krakenNetCashFlowUsd({ ...creds, krakenKey: creds.krakenKey + "-b" }, day0);
    expect(cf.netUsd).toBeCloseTo(400, 6); // 2 SOL × current $200
    expect(cf.approximated).toBe(true);
  });

  it("never treats today's still-forming OHLC candle as a historical close", async () => {
    const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;
    const entryTime = Math.floor(Date.now() / 1000) - 60; // deposited today
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/0/private/Ledgers")) {
        return jsonResponse({
          error: [],
          result: {
            count: 1,
            ledger: { L1: { refid: "r1", time: entryTime, type: "deposit", asset: "ADA", amount: "10", fee: "0" } },
          },
        });
      }
      if (url.includes("/0/public/OHLC")) {
        return jsonResponse({
          error: [],
          result: {
            ADAUSD: [
              [todayStart - DAY, "0", "0", "0", "0.50", "0", "0", 1], // finalized yesterday
              [todayStart, "0", "0", "0", "0.55", "0", "0", 1],       // in-progress today — must be ignored
            ],
            last: todayStart,
          },
        });
      }
      if (url.includes("/0/public/Ticker")) return jsonResponse({ error: [], result: { ADAUSD: { c: ["0.60", "1"] } } });
      throw new Error("unexpected fetch: " + url);
    });
    const cf = await krakenNetCashFlowUsd({ ...creds, krakenKey: creds.krakenKey + "-c" }, todayStart);
    expect(cf.netUsd).toBeCloseTo(6, 6); // 10 ADA × current $0.60 — NOT 0.55 in-progress close
    expect(cf.approximated).toBe(true);
  });

  it("uses the finalized close after UTC midnight even if the cache was populated before", async () => {
    vi.useFakeTimers();
    try {
      const dayStart = Math.floor(Date.now() / 1000 / DAY) * DAY + 10 * DAY; // a fixed future "yesterday"
      const entryTime = dayStart + 3600; // deposit during that day
      let afterMidnight = false;
      fetchMock.mockImplementation(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/0/private/Ledgers")) {
          return jsonResponse({
            error: [],
            result: {
              count: 1,
              ledger: { L1: { refid: "r1", time: entryTime, type: "deposit", asset: "DOT", amount: "10", fee: "0" } },
            },
          });
        }
        if (url.includes("/0/public/OHLC")) {
          return jsonResponse({
            error: [],
            result: {
              DOTUSD: afterMidnight
                ? [[dayStart, "0", "0", "0", "7.00", "0", "0", 1], [dayStart + DAY, "0", "0", "0", "7.50", "0", "0", 1]]
                : [[dayStart, "0", "0", "0", "6.50", "0", "0", 1]], // in-progress close pre-midnight
              last: dayStart,
            },
          });
        }
        if (url.includes("/0/public/Ticker")) return jsonResponse({ error: [], result: { DOTUSD: { c: ["9.00", "1"] } } });
        throw new Error("unexpected fetch: " + url);
      });
      // Pre-midnight: populate the per-asset OHLC cache (entry's day still in progress).
      vi.setSystemTime(new Date((dayStart + DAY - 60) * 1000));
      await krakenDailyCloses("DOT", dayStart);
      // Post-midnight: the day finalized at $7.00. The stale pre-midnight cache
      // must NOT be reused — the valuation must use the finalized close.
      afterMidnight = true;
      vi.setSystemTime(new Date((dayStart + DAY + 60) * 1000));
      const cf = await krakenNetCashFlowUsd({ ...creds, krakenKey: creds.krakenKey + "-d" }, dayStart);
      expect(cf.netUsd).toBeCloseTo(70, 6); // 10 DOT × finalized $7.00, not $6.50 stale or $9.00 fallback
      expect(cf.approximated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
