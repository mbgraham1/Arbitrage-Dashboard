/**
 * crossTakerBreakdownRest — REST level-2 pre-fire fallback for cross routes.
 * Verifies: (1) the Coinbase leg is depth-walked VWAP at the ACTUAL trade
 * size from the level-2 book, (2) a book too thin to absorb the size returns
 * null (trade aborts — never mispriced from top-of-book), (3) missing books
 * return null.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./book-stream.js", () => ({
  getStreamBook: vi.fn(() => null),
  getCoinbaseStreamBook: vi.fn(() => null),
}));

vi.mock("./order-book.js", () => ({
  OB_USD_PAIRS: { BTC: "XXBTZUSD", ETH: "XETHZUSD", SOL: "SOLUSD" },
  bookSnapshot: vi.fn(),
}));

vi.mock("./exchange.js", () => ({
  PAIRS: ["BTC/USD", "ETH/USD", "SOL/USD"],
  getCoinbaseOrderBook: vi.fn(),
}));

import { crossTakerBreakdownRest } from "./cross-pricing.js";
import { bookSnapshot } from "./order-book.js";
import { getCoinbaseOrderBook } from "./exchange.js";

const kSnapshot = (asks: [number, number][], bids: [number, number][]) => ({
  book: { asks, bids }, updatedAtMs: Date.now(), ageMs: 0, source: "rest" as const,
});

describe("crossTakerBreakdownRest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("depth-walks the Coinbase leg at trade size and returns an executable net", async () => {
    // Buy on Kraken at 100, sell into a two-level Coinbase bid book.
    (bookSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      kSnapshot([[100, 10]], [[99.9, 10]]),
    );
    (getCoinbaseOrderBook as ReturnType<typeof vi.fn>).mockResolvedValue({
      asks: [[101.5, 10]],
      bids: [[101, 0.05], [100.5, 10]], // $10 buys 0.1 BTC — must walk into level 2
    });
    const bd = await crossTakerBreakdownRest("BTC" as never, "kraken", 10, 0.2, 0.4, 200);
    expect(bd).not.toBeNull();
    expect(bd!.baseQty).toBeCloseTo(0.1, 9);
    // Sell VWAP must be BELOW the top bid (level-2 walk, not top-of-book).
    const sellLeg = bd!.legDiag.find(l => l.side === "sell")!;
    expect(sellLeg.venue).toBe("coinbase");
    expect(sellLeg.vwapPx).toBeLessThan(101);
    expect(sellLeg.vwapPx).toBeCloseTo((0.05 * 101 + 0.05 * 100.5) / 0.1, 6);
    // Net = proceeds − size − fees (both legs), from the walked VWAPs.
    const proceeds = 0.05 * 101 + 0.05 * 100.5;
    const fees = 10 * 0.002 + proceeds * 0.004;
    expect(bd!.netProfitUsd).toBeCloseTo(proceeds - 10 - fees, 9);
    expect(bd!.quoteAgeMs).toBeLessThan(200);
  });

  it("returns null (abort) when the Coinbase book cannot absorb the size", async () => {
    (bookSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      kSnapshot([[100, 10]], [[99.9, 10]]),
    );
    (getCoinbaseOrderBook as ReturnType<typeof vi.fn>).mockResolvedValue({
      asks: [[101.5, 10]],
      bids: [[101, 0.01]], // visible depth < 0.1 BTC needed
    });
    const bd = await crossTakerBreakdownRest("BTC" as never, "kraken", 10, 0.2, 0.4, 200);
    expect(bd).toBeNull();
  });

  it("returns null when either level-2 book is unavailable", async () => {
    (bookSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      kSnapshot([[100, 10]], [[99.9, 10]]),
    );
    (getCoinbaseOrderBook as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Coinbase book HTTP 500"));
    expect(await crossTakerBreakdownRest("BTC" as never, "kraken", 10, 0.2, 0.4, 200)).toBeNull();

    (bookSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getCoinbaseOrderBook as ReturnType<typeof vi.fn>).mockResolvedValue({ asks: [[101.5, 10]], bids: [[101, 10]] });
    expect(await crossTakerBreakdownRest("BTC" as never, "kraken", 10, 0.2, 0.4, 200)).toBeNull();
  });

  it("refuses assets without a Coinbase product mapping", async () => {
    expect(await crossTakerBreakdownRest("XYZ" as never, "kraken", 10, 0.2, 0.4, 200)).toBeNull();
    expect(bookSnapshot).not.toHaveBeenCalled();
  });
});
