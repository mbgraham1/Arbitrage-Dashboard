/**
 * Race coverage for the Coinbase WS feed vs. REST fallbacks.
 *
 * A WebSocket ticker update landing while a REST fallback request is in
 * flight must never be overwritten by the (older) REST response — for both:
 *   1. the 2s background poll (fetchCoinbasePair)
 *   2. the on-demand fallback inside getPairPrices
 * Also verifies wsCoinbase flag semantics: true only for fresh source="ws".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock exchange REST helpers used by getPairPrices fallbacks
vi.mock("./exchange", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./exchange")>();
  return {
    ...orig,
    getKrakenPrice: vi.fn(async () => 100),
    getCoinbasePrice: vi.fn(async () => 100),
  };
});

import { applyCoinbaseWsTick, fetchCoinbasePair, getPairPrices } from "./price-cache";
import { getCoinbasePrice } from "./exchange";

const PAIR = "BTC/USD" as const;

describe("Coinbase WS vs REST fallback races", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("background poll: skips entirely when a fresh WS entry exists", async () => {
    applyCoinbaseWsTick(PAIR, 50_000, 50_001);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await fetchCoinbasePair(PAIR);
    expect(fetchSpy).not.toHaveBeenCalled();

    const pp = await getPairPrices(PAIR);
    expect(pp.wsCoinbase).toBe(true);
    expect(pp.coinbaseBid).toBe(50_000);
    expect(pp.coinbaseAsk).toBe(50_001);
  });

  it("background poll: a WS tick landing during the REST await is not overwritten", async () => {
    // Make the current WS entry stale so the poll proceeds to fetch
    const past = Date.now() - 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(past);
    applyCoinbaseWsTick(PAIR, 40_000, 40_001); // stale ws entry
    nowSpy.mockRestore();

    globalThis.fetch = vi.fn(async () => {
      // WS tick lands while the REST request is in flight
      applyCoinbaseWsTick(PAIR, 51_000, 51_001);
      return new Response(JSON.stringify({ bid: "40000", ask: "40001", price: "40000.5" }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchCoinbasePair(PAIR);

    const pp = await getPairPrices(PAIR);
    expect(pp.coinbaseBid).toBe(51_000); // WS quote retained, late REST discarded
    expect(pp.wsCoinbase).toBe(true);
  });

  it("getPairPrices fallback: a WS tick landing during the REST await is not overwritten", async () => {
    // Stale ws entry → getPairPrices fires the on-demand REST fallback
    const past = Date.now() - 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(past);
    applyCoinbaseWsTick(PAIR, 40_000, 40_001);
    nowSpy.mockRestore();

    vi.mocked(getCoinbasePrice).mockImplementationOnce(async () => {
      applyCoinbaseWsTick(PAIR, 52_000, 52_001); // WS tick mid-flight
      return 40_000; // stale REST price
    });

    const pp = await getPairPrices(PAIR);
    expect(pp.coinbaseBid).toBe(52_000); // fresh WS retained
    expect(pp.coinbaseAsk).toBe(52_001);
    expect(pp.wsCoinbase).toBe(true);
  });

  it("getPairPrices fallback: REST result is applied when no fresh WS entry exists", async () => {
    const past = Date.now() - 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(past);
    applyCoinbaseWsTick(PAIR, 40_000, 40_001); // stale
    nowSpy.mockRestore();

    vi.mocked(getCoinbasePrice).mockImplementationOnce(async () => 45_000);

    const pp = await getPairPrices(PAIR);
    expect(pp.coinbase).toBe(45_000);
    expect(pp.wsCoinbase).toBe(false); // REST data is honestly labeled non-ws
  });
});
