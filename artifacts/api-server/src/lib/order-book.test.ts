/**
 * Unit tests for order-book.ts:
 *   - simulateCycle (via scanOrderBookCycles with fixture order books)
 *     • both cross orientations (aIsQuote true / false)
 *     • full-fill rejection on shallow books
 *     • slippage math
 *     • confidence (top-of-book coverage)
 *   - v18 scaling statuses (VIABLE / HIGH_SLIPPAGE / REJECTED)
 *     including exact threshold boundary profit == minProfitUsd × (size/10)
 *   - get24hChanges ticker-key mapping
 *
 * No real network calls are made — global `fetch` is stubbed per test.
 * The OB and ticker module-level caches are invalidated between tests by
 * advancing fake timers past the cache TTLs (OB: 5 s, ticker: 60 s).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scanOrderBookCycles, get24hChanges, CROSS_LOOKUP, discoverCrossPairs, _testOnly_clearCrossCache } from "./order-book.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Kraken Depth API response for one pair. */
function depthResponse(pair: string, asks: [number, number][], bids: [number, number][]) {
  return {
    error: [],
    result: {
      [pair]: {
        asks: asks.map(([p, v]) => [String(p), String(v), 0]),
        bids: bids.map(([p, v]) => [String(p), String(v), 0]),
      },
    },
  };
}

/** Build a Kraken Ticker API response. */
function tickerResponse(entries: Record<string, { c: string; o: string }>) {
  return {
    error: [],
    result: Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, { c: [v.c], o: v.o }]),
    ),
  };
}

/** Return a resolved fetch mock for a given JSON body. */
function mockFetch(responses: Record<string, object>) {
  return vi.fn((url: string) => {
    // Match by the `pair=` query param value
    const m = url.match(/[?&]pair=([^&]+)/);
    const key = m ? decodeURIComponent(m[1]) : url;
    for (const [k, body] of Object.entries(responses)) {
      if (key.includes(k) || url.includes(k)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(body),
        });
      }
    }
    // Fallback: empty valid response
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ error: [], result: {} }) });
  });
}

// ── Cache invalidation ────────────────────────────────────────────────────────
// obCache (5 s TTL) and tickerCache (60 s TTL) are module-level state.
// `vi.advanceTimersByTime` does NOT work here: after `vi.useRealTimers()` in
// afterEach, the next test's `vi.useFakeTimers()` resets to the real clock,
// which barely moves between tests, so cached entries look fresh.
//
// Solution: use `vi.setSystemTime` with a monotonically increasing counter
// that jumps 5 minutes between tests — always > any TTL — so every test
// starts with a guaranteed cold cache.

let fakeNow = 1_700_000_000_000; // arbitrary fixed epoch (ms)

beforeEach(() => {
  fakeNow += 300_000; // +5 min per test (>> OB 5 s TTL and ticker 60 s TTL)
  vi.useFakeTimers();
  vi.setSystemTime(fakeNow);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Verify orientation metadata ───────────────────────────────────────────────

describe("CROSS_LOOKUP orientation metadata", () => {
  it("BTC→ETH: aIsQuote=true (BTC is quote on ETHXBT)", () => {
    expect(CROSS_LOOKUP.get("BTC-ETH")).toEqual({ pair: "ETHXBT", aIsQuote: true });
  });

  it("ETH→BTC: aIsQuote=false (ETH is base on ETHXBT)", () => {
    expect(CROSS_LOOKUP.get("ETH-BTC")).toEqual({ pair: "ETHXBT", aIsQuote: false });
  });

  it("ETH→SOL: aIsQuote=true (ETH is quote on SOLETH)", () => {
    expect(CROSS_LOOKUP.get("ETH-SOL")).toEqual({ pair: "SOLETH", aIsQuote: true });
  });

  it("SOL→ETH: aIsQuote=false (SOL is base on SOLETH)", () => {
    expect(CROSS_LOOKUP.get("SOL-ETH")).toEqual({ pair: "SOLETH", aIsQuote: false });
  });
});

// ── simulateCycle: aIsQuote=true (USD→BTC→ETH→USD) ──────────────────────────
//
// Route: USD → buy BTC (walk XXBTZUSD asks)
//        BTC → buy ETH on ETHXBT (aIsQuote=true: walk ASKS, price in BTC/ETH)
//        ETH → sell for USD (walk ETHUSD bids)
//
// Fixture:
//   BTC ask = 50 000 USD, depth 0.004 BTC (cost 200 USD → absorbs 100 USD)
//   ETHXBT ask = 0.05 BTC/ETH, depth 1 ETH
//   ETH bid = 3 000 USD, depth 1 ETH
//
// Leg 1: 100 USD / 50 000 = 0.002 BTC; avg1 = 50 000; best1 = 50 000
// Leg 2: 0.002 BTC / 0.05 = 0.04 ETH; avg2 = 0.04/0.002 = 20 ETH/BTC; best2 = 1/0.05 = 20
// Leg 3: 0.04 ETH × 3 000 = 120 USD; avg3 = 3 000; best3 = 3 000
// grossProfit = 120 − 100 = 20
// feeUsd (0.40%) = 0.004 × (100 + 100 + 120) = 1.28
// netProfit = 20 − 1.28 = 18.72
// slippagePct = 0 (all fills at best price)
// coverage all 1.0 → confidencePct = 100

describe("simulateCycle — aIsQuote=true (USD→BTC→ETH→USD)", () => {
  function setupFetch() {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 0.004]], [[49_900, 1]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 1]],         [[0.049, 1]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1]],        [[3_000, 1]]),
      }),
    );
  }

  it("returns correct net profit after per-leg fees", async () => {
    setupFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle).toBeDefined();
    expect(cycle!.grossProfitUsd).toBeCloseTo(20, 6);
    expect(cycle!.feeUsd).toBeCloseTo(1.28, 6);
    expect(cycle!.estimatedProfitUsd).toBeCloseTo(18.72, 5);
  });

  it("reports zero slippage when all legs fill at best price", async () => {
    setupFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle!.slippagePct).toBeCloseTo(0, 10);
  });

  it("reports 100% confidence when top-of-book depth exceeds fill size on all legs", async () => {
    setupFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle!.confidencePct).toBe(100);
  });

  it("records correct avg prices and cross rate", async () => {
    setupFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle!.avgPriceA).toBeCloseTo(50_000, 3);    // USD per BTC
    expect(cycle!.avgCrossRate).toBeCloseTo(20, 6);     // ETH per BTC
    expect(cycle!.avgPriceB).toBeCloseTo(3_000, 3);     // USD per ETH
  });
});

// ── simulateCycle: aIsQuote=false (USD→ETH→BTC→USD) ─────────────────────────
//
// Route: USD → buy ETH (walk ETHUSD asks)
//        ETH → sell for BTC on ETHXBT (aIsQuote=false: walk BIDS, price in BTC/ETH)
//        BTC → sell for USD (walk XXBTZUSD bids)
//
// Fixture:
//   ETH ask = 2 500 USD, depth 1 ETH
//   ETHXBT bid = 0.05 BTC/ETH, depth 1 ETH
//   BTC bid = 55 000 USD, depth 1 BTC
//
// Leg 1: 100 USD / 2 500 = 0.04 ETH; avg1 = 2 500; best1 = 2 500
// Leg 2: 0.04 ETH × 0.05 = 0.002 BTC; avg2 = 0.002/0.04 = 0.05 BTC/ETH; best2 = 0.05
// Leg 3: 0.002 BTC × 55 000 = 110 USD; avg3 = 55 000; best3 = 55 000
// grossProfit = 110 − 100 = 10
// feeUsd (0.40%) = 0.004 × (100 + 100 + 110) = 1.24
// netProfit = 10 − 1.24 = 8.76
// slippagePct = 0
// confidencePct = 100

describe("simulateCycle — aIsQuote=false (USD→ETH→BTC→USD)", () => {
  function setupFetch() {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        ETHUSD:   depthResponse("ETHUSD",   [[2_500, 1]],   [[2_490, 1]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.051, 1]],   [[0.05,  1]]),
        XXBTZUSD: depthResponse("XXBTZUSD", [[55_100, 1]],  [[55_000, 1]]),
      }),
    );
  }

  it("returns correct net profit after per-leg fees (aIsQuote=false orientation)", async () => {
    setupFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→ETH→BTC→USD");
    expect(cycle).toBeDefined();
    expect(cycle!.grossProfitUsd).toBeCloseTo(10, 6);
    expect(cycle!.feeUsd).toBeCloseTo(1.24, 6);
    expect(cycle!.estimatedProfitUsd).toBeCloseTo(8.76, 5);
  });

  it("reports zero slippage when all fills hit best price", async () => {
    setupFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→ETH→BTC→USD");
    expect(cycle!.slippagePct).toBeCloseTo(0, 10);
  });

  it("records correct cross rate (BTC per ETH)", async () => {
    setupFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→ETH→BTC→USD");
    expect(cycle!.avgCrossRate).toBeCloseTo(0.05, 6);
  });
});

// ── Full-fill rejection ───────────────────────────────────────────────────────

describe("simulateCycle — full-fill rejection on shallow books", () => {
  it("omits the cycle when leg 1 book is too shallow to fill the trade size", async () => {
    // BTC book depth: only 0.001 BTC at 50 000 = 50 USD — cannot fill 100 USD
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 0.001]], [[49_900, 1]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 1]],       [[0.049, 1]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1]],      [[3_000, 1]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle).toBeUndefined();
  });

  it("omits the cycle when the cross-pair book is too shallow to absorb leg 2", async () => {
    // ETHXBT has only 0.001 ETH depth — 0.002 BTC can't all be converted
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 0.004]], [[49_900, 1]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 0.001]],   [[0.049, 0.001]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1]],      [[3_000, 1]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle).toBeUndefined();
  });

  it("omits the cycle when leg 3 book is too shallow to absorb the B volume", async () => {
    // ETH bid depth only 0.01 ETH — can't sell 0.04 ETH
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 0.004]], [[49_900, 1]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 1]],       [[0.049, 1]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1]],      [[3_000, 0.01]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle).toBeUndefined();
  });
});

// ── Slippage math ─────────────────────────────────────────────────────────────
//
// Use a 2-level book so the fill spans across levels, creating measurable slippage.
//
// Route: USD→BTC→ETH→USD
// Leg 1 (XXBTZUSD asks):
//   Level 1: [50 000, 0.001] → 50 USD spent, 0.001 BTC
//   Level 2: [51 000, 1]     → remaining 50 USD → 50/51 000 BTC
//   totalBTC = 0.001 + 50/51 000 ≈ 0.001980...
//   avg1 = 100 / 0.001980... ≈ 50 490.2...
//   best1 = 50 000
//   slip1 = |50490.2 - 50000| / 50000 × 100 ≈ 0.9804%
//
// Leg 2 and leg 3 are kept single-level (no slippage) to isolate leg 1 math.

describe("simulateCycle — slippage math across multi-level books", () => {
  it("accumulates slippage correctly when the fill spans two price levels on leg 1", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse(
          "XXBTZUSD",
          [[50_000, 0.001], [51_000, 1]], // 2-level asks
          [[49_000, 10]],
        ),
        ETHXBT: depthResponse("ETHXBT", [[0.05, 1]], [[0.049, 1]]),
        ETHUSD: depthResponse("ETHUSD", [[3_010, 1]], [[3_000, 10]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0, 0.02, 10, false); // fee=0 to isolate slippage
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle).toBeDefined();

    // Leg 1 math:
    const btcLevel1 = 0.001;
    const usdLevel1 = 50_000 * 0.001; // = 50
    const btcLevel2 = (100 - usdLevel1) / 51_000;
    const totalBtc  = btcLevel1 + btcLevel2;
    const expectedAvg1 = 100 / totalBtc;
    const expectedSlip1 = Math.abs(expectedAvg1 - 50_000) / 50_000 * 100;

    expect(cycle!.avgPriceA).toBeCloseTo(expectedAvg1, 4);
    // Total slippage includes all 3 legs; legs 2 and 3 have no slippage
    expect(cycle!.slippagePct).toBeCloseTo(expectedSlip1, 4);
  });
});

// ── Confidence (top-of-book coverage) ────────────────────────────────────────
//
// Coverage per leg = min(1, topLevelVolume / neededUnits), averaged × 100.
// When topLevelVolume < neededUnits, coverage < 1 and confidencePct < 100.

describe("simulateCycle — confidence / top-of-book coverage", () => {
  it("reports 100% when top-of-book depth ≥ fill size on every leg", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        // All top levels have plenty of volume
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 10]], [[49_000, 10]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 10]],  [[0.049, 10]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 10]], [[3_000, 10]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle!.confidencePct).toBe(100);
  });

  it("reports < 100% when top-of-book is shallower than the fill size", async () => {
    // Leg 1: aAmt ≈ 0.002 BTC. Top level vol = 0.001 BTC → cov1 = 0.5
    // Legs 2 & 3: ample depth → cov2 = cov3 = 1
    // confidencePct = round((0.5 + 1 + 1) / 3 × 100) = round(83.33) = 83
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 0.001], [50_001, 10]], [[49_000, 10]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 10]],                    [[0.049, 10]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 10]],                   [[3_000, 10]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle!.confidencePct).toBe(83);
  });

  it("is capped at 100% even when top-of-book volume greatly exceeds the fill size", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 1000]], [[49_000, 1000]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 1000]],   [[0.049, 1000]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1000]],  [[3_000, 1000]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→BTC→ETH→USD");
    expect(cycle!.confidencePct).toBe(100);
  });
});

// ── v18 scaling statuses ──────────────────────────────────────────────────────
//
// threshold(size) = minProfitUsd × (size / 10)
// VIABLE:       profit > threshold  AND slippage ≤ maxSlippagePct
// HIGH_SLIPPAGE: profit > threshold  AND slippage > maxSlippagePct
// REJECTED:     profit ≤ threshold
//
// We use a route (BTC→ETH) that yields ~18.72 USD net at $100, and the
// scaling analysis re-simulates the TOP route at $10/$50/$100/$500/$1000.
// To control the profit precisely at each size without managing 5 fixtures
// we test via the result of a single scan at $10 and read the .scaling array.

describe("v18 scaling statuses", () => {
  // Fixture: BTC→ETH route, all fills at best price, deep books
  function setupProfitableRoute() {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        // Deep enough to absorb even $1 000
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 1]], [[49_000, 1]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 100]], [[0.049, 100]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1000]], [[3_000, 1000]]),
      }),
    );
  }

  it("marks VIABLE when profit > scaled threshold and slippage ≤ max", async () => {
    setupProfitableRoute();
    // minProfitUsd=0.01, maxSlippage=1.0 → threshold at $10 = 0.01; profit ≈ 1.87 → VIABLE
    const result = await scanOrderBookCycles(10, 0.40, 0.01, 1.0, false);
    expect(result.scaling.length).toBeGreaterThan(0);
    const row10 = result.scaling.find(r => r.sizeUsd === 10);
    expect(row10).toBeDefined();
    expect(row10!.status).toBe("VIABLE");
    expect(row10!.profitUsd).toBeGreaterThan(0.01);
  });

  it("marks HIGH_SLIPPAGE when profit > scaled threshold but slippage > max", async () => {
    // Use a 2-level book so the $10 fill crosses into the second level, creating slippage.
    // Set maxSlippagePct=0 so any slippage triggers HIGH_SLIPPAGE.
    vi.stubGlobal(
      "fetch",
      mockFetch({
        XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 0.00005], [51_000, 1]], [[49_000, 1]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 100]], [[0.049, 100]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1000]], [[3_000, 1000]]),
      }),
    );

    // maxSlippagePct=0 means any slippage → HIGH_SLIPPAGE
    const result = await scanOrderBookCycles(10, 0.40, 0.001, 0, false);
    const row10 = result.scaling.find(r => r.sizeUsd === 10);
    expect(row10).toBeDefined();
    expect(row10!.status).toBe("HIGH_SLIPPAGE");
    expect(row10!.slippagePct).toBeGreaterThan(0);
  });

  it("marks REJECTED when profit ≤ scaled threshold (including exact boundary)", async () => {
    setupProfitableRoute();
    // At $10, threshold = minProfitUsd × 1.
    // Net profit at $10 with fee=40% is ~(3000/50000 × 1/0.05 × 10) - 10 = 12 - 10 = 2 − fees ≈ 1.87 USD
    // Set minProfitUsd very high so threshold >> profit → REJECTED
    const result = await scanOrderBookCycles(10, 0.40, 5.0, 1.0, false);
    const row10 = result.scaling.find(r => r.sizeUsd === 10);
    expect(row10!.status).toBe("REJECTED");
  });

  it("exact boundary: profit == threshold produces REJECTED (> not >=)", async () => {
    // Craft a zero-fee scenario so we know the exact profit.
    // Fixture: ETH→SOL route. Let's use a route where gross profit = exactly $threshold.
    // Simpler: use the scan at known size, then set minProfitUsd to exactly profitUsd
    // (which makes threshold = profitUsd). The condition is profit > threshold, so it must be REJECTED.
    setupProfitableRoute();
    // Get the actual profit at $10 first
    const probe = await scanOrderBookCycles(10, 0, 0.001, 10, false);
    vi.advanceTimersByTime(120_000); // expire cache
    const row10profit = probe.scaling.find(r => r.sizeUsd === 10)?.profitUsd ?? 1;

    // Now scan with minProfitUsd set so that threshold exactly equals the profit.
    // threshold(10) = minProfitUsd × (10/10) = minProfitUsd
    // We want threshold = row10profit, so minProfitUsd = row10profit.
    setupProfitableRoute();
    const result = await scanOrderBookCycles(10, 0, row10profit, 10, false);
    const scalingRow10 = result.scaling.find(r => r.sizeUsd === 10);
    // profit (row10profit) is NOT > threshold (row10profit), so → REJECTED
    expect(scalingRow10!.status).toBe("REJECTED");
  });

  it("scales the profit threshold with trade size (threshold = minProfitUsd × size/10)", async () => {
    // At deep books with fee=0, gross profit scales linearly with size.
    // threshold(size) = minProfitUsd × (size / 10)
    // With minProfitUsd=0.001 and high enough profit, all sizes should be VIABLE.
    setupProfitableRoute();
    const result = await scanOrderBookCycles(10, 0.40, 0.001, 1.0, false);
    for (const row of result.scaling) {
      // Threshold for each row = 0.001 × (row.sizeUsd / 10)
      const threshold = 0.001 * (row.sizeUsd / 10);
      if (row.status === "VIABLE") {
        expect(row.profitUsd).toBeGreaterThan(threshold);
        expect(row.slippagePct).toBeLessThanOrEqual(1.0);
      }
      if (row.status === "REJECTED") {
        expect(row.profitUsd).toBeLessThanOrEqual(threshold);
      }
    }
  });
});

// ── get24hChanges — ticker-key mapping ───────────────────────────────────────

describe("get24hChanges — ticker-key mapping", () => {
  // The Kraken Ticker API keys results by INTERNAL names (XETHZUSD etc.)
  // rather than altnames (ETHUSD). get24hChanges must try both.

  it("resolves BTC from internal key XXBTZUSD (same as altname)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              tickerResponse({ XXBTZUSD: { c: "52000", o: "50000" } }),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    // change = (52000 - 50000) / 50000 × 100 = 4%
    expect(changes.get("BTC")).toBeCloseTo(4, 5);
  });

  it("resolves ETH via internal-key fallback XETHZUSD when altname ETHUSD absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              tickerResponse({
                // Only the internal key is present — altname ETHUSD is absent
                XETHZUSD: { c: "3300", o: "3000" },
              }),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    // change = (3300 - 3000) / 3000 × 100 = 10%
    expect(changes.get("ETH")).toBeCloseTo(10, 5);
  });

  it("resolves XRP via internal-key fallback XXRPZUSD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              tickerResponse({ XXRPZUSD: { c: "0.6", o: "0.5" } }),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    // change = (0.6 - 0.5) / 0.5 × 100 = 20%
    expect(changes.get("XRP")).toBeCloseTo(20, 5);
  });

  it("resolves LTC via internal-key fallback XLTCZUSD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              tickerResponse({ XLTCZUSD: { c: "110", o: "100" } }),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    // change = 10%
    expect(changes.get("LTC")).toBeCloseTo(10, 5);
  });

  it("resolves DOGE using altname XDGUSD (no Z-suffix internal form)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              tickerResponse({ XDGUSD: { c: "0.15", o: "0.10" } }),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    // change = (0.15 - 0.10) / 0.10 × 100 = 50%
    expect(changes.get("DOGE")).toBeCloseTo(50, 5);
  });

  it("resolves correctly when BOTH altname and internal key are present (prefers altname)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              tickerResponse({
                // Altname key present → should be used first
                ETHUSD:   { c: "3300", o: "3000" }, // 10%
                XETHZUSD: { c: "2000", o: "1000" }, // 100% — should NOT be used
              }),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    expect(changes.get("ETH")).toBeCloseTo(10, 5);
  });

  it("omits assets that are missing from the ticker response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              // Response is empty — no entries for any asset
              tickerResponse({}),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    expect(changes.has("BTC")).toBe(false);
    expect(changes.has("ETH")).toBe(false);
    expect(changes.size).toBe(0);
  });

  it("omits an asset when its open price is zero (division guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              tickerResponse({ XXBTZUSD: { c: "50000", o: "0" } }),
            ),
        }),
      ),
    );

    const changes = await get24hChanges();
    expect(changes.has("BTC")).toBe(false);
  });

  it("returns an empty map and does not throw when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    const changes = await get24hChanges();
    expect(changes.size).toBe(0);
  });

  it("returns a cached result on the second call without re-fetching", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(tickerResponse({ XXBTZUSD: { c: "52000", o: "50000" } })),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await get24hChanges();
    await get24hChanges();

    // Ticker response includes many pairs, but only one Ticker fetch is made
    // because the second call hits the cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── v19: dynamic cross-pair discovery via AssetPairs ─────────────────────────
//
// Routes only present in the dynamically-discovered map (not in the hardcoded
// OB_CROSS_MAP fallback) must be found by the scanner AND must survive the
// execution-path lookup (preflightObCycle / arb.ts runKrakenTriangle uses the
// same activeLookup). This test verifies both properties end-to-end via the
// public API.
//
// We inject a synthetic pair "INJ/XBT" (INJ→BTC cross) that is deliberately
// absent from the hardcoded OB_CROSS_MAP, mock the AssetPairs and Depth
// endpoints, and confirm:
//  - discoverCrossPairs() returns the new pair in its lookup
//  - scanOrderBookCycles() returns both the USD→INJ→BTC→USD and
//    USD→BTC→INJ→USD routes

describe("v19 — dynamic AssetPairs discovery", () => {
  beforeEach(() => {
    // Each test in this suite clears the module-level cache so the mocked
    // AssetPairs response is actually fetched.
    _testOnly_clearCrossCache();
  });

  /** Minimal AssetPairs response that adds INJ/XBT not in the hardcoded map. */
  function assetPairsResponse() {
    return {
      error: [],
      result: {
        INJXBT: {
          altname: "INJXBT",
          wsname:  "INJ/XBT",
          base:    "INJ",
          quote:   "XXBT",
          status:  "online",
        },
      },
    };
  }

  /** mockFetch that handles both AssetPairs and Depth calls. */
  function setupDiscoveryFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("AssetPairs")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(assetPairsResponse()) });
        }
        // Depth endpoint — match pair query param
        const m = url.match(/[?&]pair=([^&]+)/);
        const pair = m ? decodeURIComponent(m[1]) : "";
        const bodies: Record<string, object> = {
          INJUSD:   depthResponse("INJUSD",   [[20,   500]],   [[19.9, 500]]),
          INJXBT:   depthResponse("INJXBT",   [[0.0004, 100]], [[0.00039, 100]]),
          XXBTZUSD: depthResponse("XXBTZUSD", [[50_000, 1]],   [[49_900, 1]]),
        };
        const body = bodies[pair] ?? { error: [], result: {} };
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      }),
    );
  }

  it("discoverCrossPairs includes the live-discovered pair not in the hardcoded map", async () => {
    setupDiscoveryFetch();
    // Hardcoded map must NOT have INJ→BTC
    expect(CROSS_LOOKUP.has("INJ-BTC")).toBe(false);

    const { lookup } = await discoverCrossPairs();
    expect(lookup.has("INJ-BTC")).toBe(true);
    expect(lookup.get("INJ-BTC")).toEqual({ pair: "INJXBT", aIsQuote: false });
    expect(lookup.get("BTC-INJ")).toEqual({ pair: "INJXBT", aIsQuote: true });
  });

  it("scanOrderBookCycles surfaces routes only reachable via dynamic discovery", async () => {
    setupDiscoveryFetch();
    // volatilityFilter=false so INJ and BTC are always included regardless of
    // 24h price movement; fee=0 to avoid REJECTED status masking the route.
    const result = await scanOrderBookCycles(10, 0, 0.001, 10, false);

    const injBtc = result.cycles.find(c => c.route === "USD→INJ→BTC→USD");
    const btcInj = result.cycles.find(c => c.route === "USD→BTC→INJ→USD");
    expect(injBtc ?? btcInj).toBeDefined();
    // crossPairsDiscovered must be non-zero (the live map was used, not the fallback)
    expect(result.crossPairsDiscovered).toBeGreaterThan(0);
  });
});

// ── v20: 4-leg routes (USD→A→M1→M2→USD) — simulatePath math ─────────────────
//
// Fixture (SOL as asset A, deep single-level books, all fills at best price):
//   SOLUSD   ask 100 USD/SOL      → $100 buys 1 SOL
//   SOLXBT   bid 0.002 BTC/SOL    → 1 SOL sells for 0.002 BTC   (SOL→BTC: aIsQuote=false, walk BIDS)
//   ETHXBT   ask 0.05 BTC/ETH     → 0.002 BTC buys 0.04 ETH     (BTC→ETH: aIsQuote=true, walk ASKS)
//   ETHUSD   bid 3 000 USD/ETH    → 0.04 ETH sells for 120 USD
//
// USD→SOL→BTC→ETH→USD @ $100:
//   grossProfit = 120 − 100 = 20
//   legs = 4 → feeUsd (0.40%) = 0.004 × (100×3 + 120) = 0.004 × 420 = 1.68
//   netProfit = 20 − 1.68 = 18.32
//   slippagePct = 0, confidencePct = 100
//
// Alternate mid order USD→SOL→ETH→BTC→USD (same books + SOLETH):
//   SOLETH   bid 0.04 ETH/SOL     → 1 SOL sells for 0.04 ETH    (SOL→ETH: aIsQuote=false, walk BIDS)
//   ETHXBT   bid 0.049 BTC/ETH    → 0.04 ETH sells for 0.00196 BTC (ETH→BTC: aIsQuote=false, walk BIDS)
//   XXBTZUSD bid 55 000 USD/BTC   → 0.00196 BTC sells for 107.8 USD
//   grossProfit = 7.8; feeUsd = 0.004 × (300 + 107.8) = 1.6312; net = 6.1688

describe("v20 — 4-leg routes: fee, slippage, and confidence math", () => {
  // The v19 discovery suite above caches an INJ-only cross lookup (1h TTL
  // outlives the 5-min per-test clock jump) — clear it so the hardcoded map is used.
  beforeEach(() => { _testOnly_clearCrossCache(); });

  function setupFourLegFetch() {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        SOLUSD:   depthResponse("SOLUSD",   [[100, 100]],      [[99, 100]]),
        SOLXBT:   depthResponse("SOLXBT",   [[0.0021, 1000]],  [[0.002, 1000]]),
        SOLETH:   depthResponse("SOLETH",   [[0.041, 1000]],   [[0.04, 1000]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 1000]],    [[0.049, 1000]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1000]],   [[3_000, 1000]]),
        XXBTZUSD: depthResponse("XXBTZUSD", [[60_000, 10]],    [[55_000, 10]]),
      }),
    );
  }

  it("USD→SOL→BTC→ETH→USD: exact net profit after 4 per-leg fees on notional", async () => {
    setupFourLegFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→SOL→BTC→ETH→USD");
    expect(cycle).toBeDefined();
    expect(cycle!.legs).toBe(4);
    expect(cycle!.path).toEqual(["SOL", "BTC", "ETH"]);
    expect(cycle!.grossProfitUsd).toBeCloseTo(20, 6);
    // 4 legs, fee on each leg's notional: 0.004 × (100 + 100 + 100 + 120)
    expect(cycle!.feeUsd).toBeCloseTo(1.68, 6);
    expect(cycle!.estimatedProfitUsd).toBeCloseTo(18.32, 5);
    // Fee must be strictly larger than the 3-leg fee on the same edge —
    // 4-leg fees can never be understated to a 3-leg drag (1.28).
    expect(cycle!.feeUsd).toBeGreaterThan(0.004 * (100 + 100 + 120));
  });

  it("USD→SOL→ETH→BTC→USD (other mid order): exact net profit after 4 per-leg fees", async () => {
    setupFourLegFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→SOL→ETH→BTC→USD");
    expect(cycle).toBeDefined();
    expect(cycle!.legs).toBe(4);
    expect(cycle!.path).toEqual(["SOL", "ETH", "BTC"]);
    // 1 SOL → 0.04 ETH (SOLETH bid) → 0.04 × 0.049 = 0.00196 BTC (ETHXBT bid) → × 55 000 = 107.8 USD
    expect(cycle!.grossProfitUsd).toBeCloseTo(7.8, 6);
    expect(cycle!.feeUsd).toBeCloseTo(0.004 * (300 + 107.8), 6);
    expect(cycle!.estimatedProfitUsd).toBeCloseTo(7.8 - 0.004 * (300 + 107.8), 5);
  });

  it("reports zero slippage and 100% confidence when all 4 legs fill at best price", async () => {
    setupFourLegFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    const cycle = result.cycles.find(c => c.route === "USD→SOL→BTC→ETH→USD");
    expect(cycle!.slippagePct).toBeCloseTo(0, 10);
    expect(cycle!.confidencePct).toBe(100);
  });

  it("accumulates slippage across multiple legs of a 4-leg route (legs 1 and 4 multi-level)", async () => {
    // Leg 1 (SOLUSD asks): [100, 0.5] then [101, 10] — $100 fill spans 2 levels
    // Leg 4 (ETHUSD bids): [3000, 0.02] then [2990, 10] — ETH sell spans 2 levels
    // Legs 2 & 3 stay single-level (zero slippage) to isolate the accumulation.
    vi.stubGlobal(
      "fetch",
      mockFetch({
        SOLUSD:   depthResponse("SOLUSD",   [[100, 0.5], [101, 10]], [[99, 100]]),
        SOLXBT:   depthResponse("SOLXBT",   [[0.0021, 1000]],        [[0.002, 1000]]),
        ETHXBT:   depthResponse("ETHXBT",   [[0.05, 1000]],          [[0.049, 1000]]),
        ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1000]],         [[3_000, 0.02], [2_990, 10]]),
      }),
    );

    const result = await scanOrderBookCycles(100, 0, 0.02, 10, false); // fee=0 to isolate slippage
    const cycle = result.cycles.find(c => c.route === "USD→SOL→BTC→ETH→USD");
    expect(cycle).toBeDefined();

    // Leg 1: 0.5 SOL @100 ($50) + $50/101 SOL @101
    const solLvl2 = 50 / 101;
    const totalSol = 0.5 + solLvl2;
    const avg1 = 100 / totalSol;
    const slip1 = Math.abs(avg1 - 100) / 100 * 100;

    // Legs 2–3 at best: totalSol SOL → ×0.002 BTC → /0.05 ETH
    const eth = (totalSol * 0.002) / 0.05;

    // Leg 4: 0.02 ETH @3000 + remainder @2990
    const usdFinal = 0.02 * 3_000 + (eth - 0.02) * 2_990;
    const avg4 = usdFinal / eth;
    const slip4 = Math.abs(avg4 - 3_000) / 3_000 * 100;

    expect(cycle!.avgPriceA).toBeCloseTo(avg1, 6);
    expect(cycle!.slippagePct).toBeCloseTo(slip1 + slip4, 6);
    expect(cycle!.grossProfitUsd).toBeCloseTo(usdFinal - 100, 6);
    // With fee=0, net must equal gross exactly — never higher.
    expect(cycle!.estimatedProfitUsd).toBeCloseTo(usdFinal - 100, 6);
  });
});

// ── v20: 4-leg shallow-book rejection on each leg ────────────────────────────
//
// Base fixture fills: $100 → 1 SOL → 0.002 BTC → 0.04 ETH → USD.
// Each test starves exactly one leg's book below the required volume; the
// cycle must be OMITTED (never a partial-fill phantom edge).

describe("v20 — 4-leg full-fill rejection on shallow books", () => {
  // The v19 discovery suite above caches an INJ-only cross lookup (1h TTL
  // outlives the 5-min per-test clock jump) — clear it so the hardcoded map is used.
  beforeEach(() => { _testOnly_clearCrossCache(); });

  function books(overrides: Partial<Record<string, object>> = {}) {
    return {
      SOLUSD:   depthResponse("SOLUSD",   [[100, 100]],     [[99, 100]]),
      SOLXBT:   depthResponse("SOLXBT",   [[0.0021, 1000]], [[0.002, 1000]]),
      ETHXBT:   depthResponse("ETHXBT",   [[0.05, 1000]],   [[0.049, 1000]]),
      ETHUSD:   depthResponse("ETHUSD",   [[3_010, 1000]],  [[3_000, 1000]]),
      ...overrides,
    } as Record<string, object>;
  }

  async function scanRoute(overrides: Record<string, object>) {
    vi.stubGlobal("fetch", mockFetch(books(overrides)));
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false);
    return result.cycles.find(c => c.route === "USD→SOL→BTC→ETH→USD");
  }

  it("sanity: full-depth fixture produces the 4-leg cycle", async () => {
    expect(await scanRoute({})).toBeDefined();
  });

  it("omits the route when leg 1 (SOLUSD asks) cannot absorb $100", async () => {
    // Only 0.5 SOL at 100 = $50 depth — cannot fill $100
    expect(await scanRoute({ SOLUSD: depthResponse("SOLUSD", [[100, 0.5]], [[99, 100]]) })).toBeUndefined();
  });

  it("omits the route when leg 2 (SOLXBT bids) cannot absorb 1 SOL", async () => {
    expect(await scanRoute({ SOLXBT: depthResponse("SOLXBT", [[0.0021, 1000]], [[0.002, 0.5]]) })).toBeUndefined();
  });

  it("omits the route when leg 3 (ETHXBT asks) cannot supply 0.04 ETH", async () => {
    expect(await scanRoute({ ETHXBT: depthResponse("ETHXBT", [[0.05, 0.02]], [[0.049, 1000]]) })).toBeUndefined();
  });

  it("omits the route when leg 4 (ETHUSD bids) cannot absorb 0.04 ETH", async () => {
    expect(await scanRoute({ ETHUSD: depthResponse("ETHUSD", [[3_010, 1000]], [[3_000, 0.01]]) })).toBeUndefined();
  });
});

// ── v20: maxLegs=3 gate and 4-leg scaling-table re-simulation ────────────────

describe("v20 — maxLegs gate and scaling table on a 4-leg top route", () => {
  // The v19 discovery suite above caches an INJ-only cross lookup (1h TTL
  // outlives the 5-min per-test clock jump) — clear it so the hardcoded map is used.
  beforeEach(() => { _testOnly_clearCrossCache(); });

  // Fixture with ONLY the pairs needed for USD→SOL→BTC→ETH→USD, deep enough
  // to absorb $1 000. No SOLETH / XXBTZUSD books → no competing 3-leg or
  // alternate-mid cycle can simulate, so the 4-leg route is the unique top.
  function setupFourLegOnlyFetch() {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        SOLUSD: depthResponse("SOLUSD", [[100, 100]],     [[99, 100]]),
        SOLXBT: depthResponse("SOLXBT", [[0.0021, 1000]], [[0.002, 1000]]),
        ETHXBT: depthResponse("ETHXBT", [[0.05, 1000]],   [[0.049, 1000]]),
        ETHUSD: depthResponse("ETHUSD", [[3_010, 1000]],  [[3_000, 1000]]),
      }),
    );
  }

  it("maxLegs=3 returns no 4-leg cycles at all", async () => {
    setupFourLegOnlyFetch();
    const result = await scanOrderBookCycles(100, 0.40, 0.02, 1.0, false, 3);
    expect(result.cycles.find(c => c.route === "USD→SOL→BTC→ETH→USD")).toBeUndefined();
    expect(result.cycles.every(c => c.legs === 3)).toBe(true);
  });

  it("re-simulates the 4-leg top route in the scaling table with 4-leg math (not a bogus A→B triangle)", async () => {
    setupFourLegOnlyFetch();
    const result = await scanOrderBookCycles(10, 0.40, 0.001, 1.0, false);
    expect(result.scalingRoute).toBe("USD→SOL→BTC→ETH→USD");
    expect(result.scaling.length).toBeGreaterThan(0);

    // With deep single-level books the fills are linear in size:
    // usdFinal = 1.2 × size, gross = 0.2 × size,
    // 4-leg fee = 0.004 × (3×size + 1.2×size) = 0.0168 × size,
    // net = 0.2×size − 0.0168×size = 0.1832 × size.
    // A bogus SOL→ETH 3-leg re-simulation could not even run here (no SOLETH
    // book), and a 3-leg fee model would give 0.1872 × size — higher profit.
    for (const size of [10, 50, 100, 500, 1000]) {
      const row = result.scaling.find(r => r.sizeUsd === size);
      expect(row, `scaling row for $${size}`).toBeDefined();
      expect(row!.profitUsd).toBeCloseTo(0.1832 * size, 5);
      expect(row!.slippagePct).toBeCloseTo(0, 10);
      expect(row!.status).toBe("VIABLE");
    }
  });
});
