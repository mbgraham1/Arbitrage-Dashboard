/**
 * Tests for the synthetic ETH/SOL cross rate used by getTriPrices() when
 * Kraken has no direct ETH/SOL market (Task: confirm the ETH triangular loop
 * uses accurate prices on the synthetic path).
 *
 * Validates:
 * 1. Correct orientation: bid = ethBid/solAsk, ask = ethAsk/solBid.
 * 2. bid < mid < ask, and synthetic mid ≈ ethMid/solMid within tight tolerance.
 * 3. Spread compounding: synthetic relative spread ≈ sum of the two USD-leg
 *    relative spreads — always ≥ either single leg (conservative bias).
 * 4. Edge computation with synthetic legs never overstates profit vs a direct
 *    quote with the same mid but a single-leg spread.
 * 5. Guards: zero/missing legs yield 0 (callers reject non-positive quotes).
 */
import { describe, it, expect } from "vitest";
import { syntheticEthSol } from "./price-cache";

// Realistic Kraken-like quotes (2026-08 magnitudes)
const ethBid = 4611.2, ethAsk = 4611.9;   // ~1.5 bp spread
const solBid = 186.42, solAsk = 186.49;   // ~3.8 bp spread

describe("syntheticEthSol", () => {
  it("uses the conservative orientation (bid=ethBid/solAsk, ask=ethAsk/solBid)", () => {
    const { bid, ask } = syntheticEthSol(ethBid, ethAsk, solBid, solAsk);
    expect(bid).toBeCloseTo(ethBid / solAsk, 10);
    expect(ask).toBeCloseTo(ethAsk / solBid, 10);
    expect(bid).toBeLessThan(ask);
  });

  it("synthetic mid matches ethMid/solMid within 1 bp", () => {
    const { bid, ask } = syntheticEthSol(ethBid, ethAsk, solBid, solAsk);
    const synMid = (bid + ask) / 2;
    const refMid = ((ethBid + ethAsk) / 2) / ((solBid + solAsk) / 2);
    expect(Math.abs(synMid / refMid - 1)).toBeLessThan(1e-4);
  });

  it("compounds the two leg spreads (relative spread ≈ ethSpread + solSpread, and ≥ each leg)", () => {
    const { bid, ask } = syntheticEthSol(ethBid, ethAsk, solBid, solAsk);
    const rel = (a: number, b: number) => (a - b) / ((a + b) / 2);
    const synSpread = rel(ask, bid);
    const ethSpread = rel(ethAsk, ethBid);
    const solSpread = rel(solAsk, solBid);
    // first-order: synthetic spread = sum of leg spreads
    expect(synSpread).toBeCloseTo(ethSpread + solSpread, 6);
    expect(synSpread).toBeGreaterThanOrEqual(ethSpread);
    expect(synSpread).toBeGreaterThanOrEqual(solSpread);
  });

  it("never overstates triangular edge vs a direct quote with the same mid", () => {
    // Direct market hypothetical: same mid as synthetic, but tighter (2 bp) spread.
    const syn = syntheticEthSol(ethBid, ethAsk, solBid, solAsk);
    const mid = (syn.bid + syn.ask) / 2;
    const direct = { bid: mid * (1 - 0.0001), ask: mid * (1 + 0.0001) };
    const f = 0.0026; // Kraken taker fee

    // Loop 1: USD→SOL→ETH→USD (buy SOL at solAsk, buy ETH at ethSolAsk, sell ETH at ethBid)
    const edge = (ethSol: { bid: number; ask: number }) =>
      (ethBid * (1 - f)) / (solAsk * (1 + f) * ethSol.ask * (1 + f)) - 1;
    expect(edge(syn)).toBeLessThanOrEqual(edge(direct));

    // Loop 2: USD→ETH→SOL→USD (buy ETH at ethAsk, sell for SOL at ethSolBid, sell SOL at solBid)
    const edge2 = (ethSol: { bid: number; ask: number }) =>
      (ethSol.bid * (1 - f) * solBid * (1 - f)) / (ethAsk * (1 + f)) - 1;
    expect(edge2(syn)).toBeLessThanOrEqual(edge2(direct));
  });

  it("returns 0 for non-positive denominators so callers reject the quote", () => {
    expect(syntheticEthSol(ethBid, ethAsk, 0, 0)).toEqual({ bid: 0, ask: 0 });
    expect(syntheticEthSol(ethBid, ethAsk, -1, 0).bid).toBe(0);
  });
});
