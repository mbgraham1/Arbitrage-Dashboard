/**
 * Task: Confirm the pair filter survives a Force Trade edge case where all
 * enabled pairs lack prices.
 *
 * Scenario: the trader enables only a non-SOL pair (e.g. BTC/USD), but that
 * pair has no fresh bid/ask in the cache and REST fallbacks fail (network
 * outage, exchange downtime). scanAllPairs() must:
 * 1. Not throw — return gracefully.
 * 2. Return an empty array (no fabricated entries, no fallback to a
 *    non-enabled pair such as SOL/USD).
 * 3. Same guarantee for getBestPairPrices() → null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the exchange REST fallbacks to always fail — simulates every enabled
// pair being unreachable. Keep PAIRS from the real module.
vi.mock("./exchange", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exchange")>();
  return {
    ...actual,
    getKrakenPrice: vi.fn(() => Promise.reject(new Error("kraken down"))),
    getCoinbasePrice: vi.fn(() => Promise.reject(new Error("coinbase down"))),
  };
});

// Fresh module per test run: pairCache starts empty (all entries null =
// maximally stale) and initPriceFeeds() is never called, so no WS/poll data.
import { scanAllPairs, getBestPairPrices } from "./price-cache";

describe("scanAllPairs — all enabled pairs lack prices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty array (not SOL/USD or any other pair) when the only enabled pair has no prices", async () => {
    const entries = await scanAllPairs(["BTC/USD"]);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(0);
  });

  it("does not fall back to non-enabled pairs when several enabled pairs are all stale", async () => {
    const entries = await scanAllPairs(["BTC/USD", "ETH/USD", "ADA/USD"]);
    expect(entries).toHaveLength(0);
  });

  it("returns an empty array for an enabled list containing only unknown symbols", async () => {
    // Unknown symbols are filtered out; the scan set is empty → empty result, no throw.
    const entries = await scanAllPairs(["DOGE/USD"]);
    expect(entries).toHaveLength(0);
  });

  it("getBestPairPrices returns null under the same conditions", async () => {
    await expect(getBestPairPrices(["BTC/USD"])).resolves.toBeNull();
    await expect(getBestPairPrices(["DOGE/USD"])).resolves.toBeNull();
  });
});
