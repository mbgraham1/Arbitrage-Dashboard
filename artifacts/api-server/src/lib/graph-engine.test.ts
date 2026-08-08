/**
 * Unit tests locking down the depth-walk pricing math in the graph engine.
 *
 * These functions directly gate live trades: a sign error or off-by-one in the
 * "book too thin → drop edge" rule would silently overstate profit.
 */
import { describe, it, expect } from "vitest";
import {
  vwapBuy,
  vwapSell,
  takerBuyQuote,
  takerSellQuote,
  makerBuyQuote,
  makerSellQuote,
  type BookLevels,
} from "./graph-engine";

// Book convention: [price, baseQty][]; asks ascending, bids descending.

describe("vwapBuy (walk asks spending quote)", () => {
  it("fills exactly at one level when the top level covers the size", () => {
    const asks: BookLevels = [[100, 10]]; // 1000 quote available
    // Spend 500 → acquire 5 @ 100 → VWAP exactly 100
    expect(vwapBuy(asks, 500)).toBeCloseTo(100, 12);
  });

  it("consumes an exact-fit book (spend == total depth) without returning null", () => {
    const asks: BookLevels = [
      [100, 2], // 200 quote
      [110, 3], // 330 quote
    ];
    const vwap = vwapBuy(asks, 530);
    // acquired = 2 + 3 = 5; spent = 530 → VWAP = 106
    expect(vwap).toBeCloseTo(106, 9);
  });

  it("computes a multi-level VWAP with a partial final level", () => {
    const asks: BookLevels = [
      [100, 1],  // 100 quote
      [110, 1],  // 110 quote
      [120, 10],
    ];
    // Spend 330: 100 @100 → 1 base; 110 @110 → 1 base; 120 remaining @120 → 1 base
    // acquired = 3, spent = 330 → VWAP = 110
    expect(vwapBuy(asks, 330)).toBeCloseTo(110, 9);
    // VWAP must be ≥ best ask (never a better-than-top price)
    expect(vwapBuy(asks, 330)!).toBeGreaterThanOrEqual(100);
  });

  it("returns null when the book is too thin (never approximates)", () => {
    const asks: BookLevels = [[100, 1], [110, 1]]; // 210 quote total
    expect(vwapBuy(asks, 210.01)).toBeNull();
  });

  it("returns null on an empty book", () => {
    expect(vwapBuy([], 100)).toBeNull();
  });

  it("does not return null for float-noise near-exact fills", () => {
    const asks: BookLevels = [[3, 0.1], [3.1, 0.1]];
    // total quote = 0.3 + 0.31 = 0.61 (float-imprecise)
    expect(vwapBuy(asks, 0.3 + 0.31)).not.toBeNull();
  });
});

describe("vwapSell (walk bids selling base)", () => {
  it("fills exactly at one level", () => {
    const bids: BookLevels = [[100, 10]];
    expect(vwapSell(bids, 5)).toBeCloseTo(100, 12);
  });

  it("consumes an exact-fit book without returning null", () => {
    const bids: BookLevels = [[100, 2], [90, 3]];
    // sell 5: 2@100 + 3@90 = 470 / 5 = 94
    expect(vwapSell(bids, 5)).toBeCloseTo(94, 9);
  });

  it("computes a multi-level VWAP with a partial final level", () => {
    const bids: BookLevels = [
      [100, 1],
      [90, 1],
      [80, 10],
    ];
    // sell 3: 100 + 90 + 80 = 270 / 3 = 90
    const vwap = vwapSell(bids, 3);
    expect(vwap).toBeCloseTo(90, 9);
    // VWAP must be ≤ best bid (never better than top-of-book)
    expect(vwap!).toBeLessThanOrEqual(100);
  });

  it("returns null when the book is too thin", () => {
    const bids: BookLevels = [[100, 1], [90, 1]];
    expect(vwapSell(bids, 2.001)).toBeNull();
  });

  it("returns null on an empty book", () => {
    expect(vwapSell([], 1)).toBeNull();
  });
});

describe("takerBuyQuote", () => {
  const asks: BookLevels = [[100, 1], [110, 1], [120, 10]];

  it("prices grossRate as 1/VWAP and applies fee on netRate", () => {
    const q = takerBuyQuote(asks, 330, 0.26)!;
    expect(q).not.toBeNull();
    expect(q.effPrice).toBeCloseTo(110, 9);
    expect(q.grossRate).toBeCloseTo(1 / 110, 12);
    expect(q.netRate).toBeCloseTo((1 / 110) * (1 - 0.0026), 12);
    expect(q.netRate).toBeLessThan(q.grossRate);
  });

  it("slippagePct is positive when VWAP exceeds best ask, and never negative", () => {
    const q = takerBuyQuote(asks, 330, 0)!;
    // (110 - 100) / 100 * 100 = 10%
    expect(q.slippagePct).toBeCloseTo(10, 9);
    const flat = takerBuyQuote([[100, 100]], 500, 0)!;
    expect(flat.slippagePct).toBe(0);
    expect(flat.slippagePct).toBeGreaterThanOrEqual(0);
  });

  it("returns null when the book cannot absorb the size (edge dropped)", () => {
    expect(takerBuyQuote([[100, 1]], 200, 0)).toBeNull();
  });

  it("returns null on an empty book", () => {
    expect(takerBuyQuote([], 100, 0)).toBeNull();
  });
});

describe("takerSellQuote", () => {
  const bids: BookLevels = [[100, 1], [90, 1], [80, 10]];

  it("prices grossRate as VWAP received and applies fee on netRate", () => {
    const q = takerSellQuote(bids, 3, 0.26)!;
    expect(q).not.toBeNull();
    expect(q.effPrice).toBeCloseTo(90, 9);
    expect(q.grossRate).toBeCloseTo(90, 9);
    expect(q.netRate).toBeCloseTo(90 * (1 - 0.0026), 9);
    expect(q.netRate).toBeLessThan(q.grossRate);
  });

  it("slippagePct is positive when VWAP is below best bid, and never negative", () => {
    const q = takerSellQuote(bids, 3, 0)!;
    // (100 - 90) / 100 * 100 = 10%
    expect(q.slippagePct).toBeCloseTo(10, 9);
    const flat = takerSellQuote([[100, 100]], 5, 0)!;
    expect(flat.slippagePct).toBe(0);
  });

  it("returns null when the book cannot absorb the size", () => {
    expect(takerSellQuote([[100, 1]], 2, 0)).toBeNull();
  });

  it("returns null on an empty book", () => {
    expect(takerSellQuote([], 1, 0)).toBeNull();
  });
});

describe("maker vs taker edge rates", () => {
  // Book: best bid 99, best ask 101, deeper ask levels worse.
  const asks: BookLevels = [[101, 1], [103, 10]];
  const bids: BookLevels = [[99, 1], [97, 10]];

  it("maker BUY joins at best BID (better rate than taker VWAP over asks)", () => {
    const mk = makerBuyQuote(99, 0.16)!;
    const tk = takerBuyQuote(asks, 300, 0.26)!; // walks into 103s
    expect(mk.effPrice).toBe(99);
    expect(mk.grossRate).toBeCloseTo(1 / 99, 12);
    expect(tk.effPrice).toBeGreaterThan(101 - 1e-9);
    expect(mk.grossRate).toBeGreaterThan(tk.grossRate);
  });

  it("maker SELL joins at best ASK (better rate than taker VWAP over bids)", () => {
    const mk = makerSellQuote(101, 0.16)!;
    const tk = takerSellQuote(bids, 3, 0.26)!; // walks into 97s
    expect(mk.effPrice).toBe(101);
    expect(mk.grossRate).toBe(101);
    expect(tk.grossRate).toBeLessThan(99 + 1e-9);
    expect(mk.grossRate).toBeGreaterThan(tk.grossRate);
  });

  it("maker quotes always report zero slippage", () => {
    expect(makerBuyQuote(99, 0.16)!.slippagePct).toBe(0);
    expect(makerSellQuote(101, 0.16)!.slippagePct).toBe(0);
  });

  it("maker quotes apply the fee and return null on a missing top-of-book", () => {
    expect(makerBuyQuote(100, 0.16)!.netRate).toBeCloseTo(0.01 * (1 - 0.0016), 12);
    expect(makerSellQuote(100, 0.16)!.netRate).toBeCloseTo(100 * (1 - 0.0016), 9);
    expect(makerBuyQuote(0, 0.16)).toBeNull();
    expect(makerSellQuote(0, 0.16)).toBeNull();
  });
});
