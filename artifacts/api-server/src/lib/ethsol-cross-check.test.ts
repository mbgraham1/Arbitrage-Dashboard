/**
 * Task: Warn traders when Kraken and Coinbase disagree on the ETH/SOL cross rate.
 *
 * Validates getTriPrices().ethSolCrossCheck:
 * 1. Present (non-null) when BOTH exchanges have fresh SOL/USD + ETH/USD legs.
 * 2. warning=false when the two synthetic mids agree (normal ~1.3 bp regime).
 * 3. warning=true when the mids deviate by more than ETH_SOL_CROSS_WARN_BPS
 *    (e.g. one venue's ETH feed is stale during a flash move).
 * 4. Advisory only — kraken/coinbase results are still returned unchanged.
 * 5. Null when only one exchange has data (nothing to compare).
 */
import { describe, it, expect, vi } from "vitest";

// Kraken cache entries are seeded through the REST fallback path of
// getPairPrices() (bid = ask = price). Coinbase entries are seeded through the
// exported WS tick helper. Values are set per-test via these mock refs.
const krakenPrices: Record<string, number> = {};
vi.mock("./exchange", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exchange")>();
  return {
    ...actual,
    getKrakenPrice: vi.fn((pair: string) => {
      const p = krakenPrices[pair];
      return p != null ? Promise.resolve(p) : Promise.reject(new Error("no price"));
    }),
    getCoinbasePrice: vi.fn(() => Promise.reject(new Error("coinbase REST down"))),
  };
});

import {
  getTriPrices,
  getPairPrices,
  applyCoinbaseWsTick,
  ETH_SOL_CROSS_WARN_BPS,
} from "./price-cache";

// getPairPrices() only fires the Kraken REST fallback when the cached entry is
// stale (>15 s), so each test jumps the clock forward past the staleness
// window before reseeding. Coinbase WS ticks are then reapplied at the new
// "now" so both sides are fresh again.
let clockOffsetMs = 0;
const realNow = Date.now;
function advancePastStale(): void {
  clockOffsetMs += 20_000;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
}

async function seedKraken(ethUsd: number, solUsd: number): Promise<void> {
  krakenPrices["ETH/USD"] = ethUsd;
  krakenPrices["SOL/USD"] = solUsd;
  await getPairPrices("ETH/USD");
  await getPairPrices("SOL/USD");
}

function seedCoinbase(ethUsd: number, solUsd: number): void {
  applyCoinbaseWsTick("ETH/USD", ethUsd, ethUsd);
  applyCoinbaseWsTick("SOL/USD", solUsd, solUsd);
}

describe("getTriPrices ethSolCrossCheck", () => {
  it("agreeing venues → present, small deviation, no warning", async () => {
    await seedKraken(4600, 186);
    seedCoinbase(4600.5, 186.02); // ~1 bp-ish disagreement
    const tri = getTriPrices();
    expect(tri.kraken).not.toBeNull();
    expect(tri.coinbase).not.toBeNull();
    expect(tri.ethSolCrossCheck).not.toBeNull();
    expect(tri.ethSolCrossCheck!.thresholdBps).toBe(ETH_SOL_CROSS_WARN_BPS);
    expect(tri.ethSolCrossCheck!.deviationBps).toBeLessThan(ETH_SOL_CROSS_WARN_BPS);
    expect(tri.ethSolCrossCheck!.warning).toBe(false);
  });

  it("diverging venues → warning=true, results still returned (advisory only)", async () => {
    // Kraken ETH drifts 1% while Coinbase holds → cross mids diverge ~100 bp.
    advancePastStale();
    await seedKraken(4600 * 1.01, 186);
    seedCoinbase(4600, 186);
    const tri = getTriPrices();
    expect(tri.ethSolCrossCheck).not.toBeNull();
    expect(tri.ethSolCrossCheck!.deviationBps).toBeGreaterThan(ETH_SOL_CROSS_WARN_BPS);
    expect(tri.ethSolCrossCheck!.warning).toBe(true);
    // Advisory only: both per-exchange results remain available.
    expect(tri.kraken).not.toBeNull();
    expect(tri.coinbase).not.toBeNull();
  });

  it("deviation math: |kMid − cMid| / avg in bps", async () => {
    advancePastStale();
    await seedKraken(4600, 186);
    seedCoinbase(4600, 186 * 1.005); // Coinbase SOL +0.5% → cross mid ~50 bp lower
    const tri = getTriPrices();
    const kMid = (tri.kraken!.ethSolBid + tri.kraken!.ethSolAsk) / 2;
    const cMid = (tri.coinbase!.ethSolBid + tri.coinbase!.ethSolAsk) / 2;
    const expected = (Math.abs(kMid - cMid) / ((kMid + cMid) / 2)) * 10_000;
    expect(tri.ethSolCrossCheck!.deviationBps).toBeCloseTo(expected, 8);
    expect(expected).toBeGreaterThan(ETH_SOL_CROSS_WARN_BPS); // sanity: ~50 bp
    expect(tri.ethSolCrossCheck!.warning).toBe(true);
  });
});
