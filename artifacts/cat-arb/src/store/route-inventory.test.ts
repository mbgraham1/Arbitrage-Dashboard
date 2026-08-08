import { describe, it, expect } from "vitest";
import {
  routeInventoryReqs,
  inventoryBalanceFor,
  missingInventory,
  formatInventoryReqs,
} from "./route-inventory";

// USD[K]→BTC[K]→BTC[CB]→USD[CB]: buy BTC on Kraken, bridge, sell existing
// Coinbase BTC — needs BTC inventory on Coinbase before firing.
const crossRoute = {
  hops: [
    { exchange: "kraken", pair: "XBTUSD", side: "buy", from: "kraken:USD", to: "kraken:BTC", amountIn: 10, amountOut: 0.000154 },
    { exchange: "bridge", pair: "BTC", side: "bridge", from: "kraken:BTC", to: "coinbase:BTC", amountIn: 0.000154, amountOut: 0.000154 },
    { exchange: "coinbase", pair: "BTC-USD", side: "sell", from: "coinbase:BTC", to: "coinbase:USD", amountIn: 0.000154, amountOut: 10.01 },
  ],
};

// Reverse direction: bridge lands on Kraken — needs SOL on Kraken.
const crossRouteToKraken = {
  hops: [
    { exchange: "coinbase", pair: "SOL-USD", side: "buy", from: "coinbase:USD", to: "coinbase:SOL", amountIn: 10, amountOut: 0.13 },
    { exchange: "bridge", pair: "SOL", side: "bridge", from: "coinbase:SOL", to: "kraken:SOL", amountIn: 0.13, amountOut: 0.13 },
    { exchange: "kraken", pair: "SOLUSD", side: "sell", from: "kraken:SOL", to: "kraken:USD", amountIn: 0.13, amountOut: 10.02 },
  ],
};

// Kraken-only triangle — no bridge hops, no inventory prerequisite.
const triangleRoute = {
  hops: [
    { exchange: "kraken", pair: "XBTUSD", side: "buy", from: "kraken:USD", to: "kraken:BTC", amountIn: 10, amountOut: 0.000154 },
    { exchange: "kraken", pair: "SOLXBT", side: "buy", from: "kraken:BTC", to: "kraken:SOL", amountIn: 0.000154, amountOut: 0.13 },
    { exchange: "kraken", pair: "SOLUSD", side: "sell", from: "kraken:SOL", to: "kraken:USD", amountIn: 0.13, amountOut: 10.01 },
  ],
};

const balances = (kraken: [string, number][], coinbase: [string, number][]) => ({
  kraken: kraken.map(([currency, amount]) => ({ currency, amount })),
  coinbase: coinbase.map(([currency, amount]) => ({ currency, amount })),
});

describe("routeInventoryReqs", () => {
  it("extracts the bridged asset, destination exchange, and amount", () => {
    expect(routeInventoryReqs(crossRoute)).toEqual([
      { asset: "BTC", exchange: "coinbase", amount: 0.000154 },
    ]);
    expect(routeInventoryReqs(crossRouteToKraken)).toEqual([
      { asset: "SOL", exchange: "kraken", amount: 0.13 },
    ]);
  });

  it("returns no requirements for same-exchange triangles", () => {
    expect(routeInventoryReqs(triangleRoute)).toEqual([]);
  });
});

describe("inventoryBalanceFor", () => {
  it("returns null when balances aren't loaded", () => {
    expect(inventoryBalanceFor(null, "coinbase", "BTC")).toBeNull();
    expect(inventoryBalanceFor(undefined, "kraken", "BTC")).toBeNull();
  });

  it("resolves Kraken's non-standard codes (BTC→XBT/XXBT, ETH→XETH, SOL→SOL.S)", () => {
    const b = balances([["XXBT", 0.5], ["XETH", 2], ["SOL", 1], ["SOL.S", 3]], []);
    expect(inventoryBalanceFor(b, "kraken", "BTC")).toBe(0.5);
    expect(inventoryBalanceFor(b, "kraken", "ETH")).toBe(2);
    // duplicate codes sum (SOL + staked SOL.S)
    expect(inventoryBalanceFor(b, "kraken", "SOL")).toBe(4);
  });

  it("never matches Kraken codes on Coinbase (canonical symbols only)", () => {
    const b = balances([], [["XBT", 1], ["BTC", 0.25]]);
    expect(inventoryBalanceFor(b, "coinbase", "BTC")).toBe(0.25);
  });

  it("returns 0 (not null) when balances are loaded but the asset is absent", () => {
    expect(inventoryBalanceFor(balances([["ZUSD", 100]], [["USD", 100]]), "coinbase", "BTC")).toBe(0);
  });
});

describe("missingInventory — the gate shared by EXECUTE, AUTO, and fallback candidates", () => {
  it("flags a cross route when the destination venue lacks the asset", () => {
    const b = balances([["ZUSD", 100]], [["USD", 100]]); // no BTC on Coinbase
    expect(missingInventory(crossRoute, b)).toEqual([
      { asset: "BTC", exchange: "coinbase", amount: 0.000154 },
    ]);
  });

  it("passes when the destination venue holds at least the required amount (exact match counts as met)", () => {
    expect(missingInventory(crossRoute, balances([], [["BTC", 0.000154]]))).toEqual([]);
    expect(missingInventory(crossRoute, balances([], [["BTC", 1]]))).toEqual([]);
  });

  it("flags when held balance is just short of the requirement", () => {
    expect(missingInventory(crossRoute, balances([], [["BTC", 0.000153]]))).toHaveLength(1);
  });

  it("does NOT block on unknown balances — server pre-flight stays the validator", () => {
    expect(missingInventory(crossRoute, null)).toEqual([]);
    expect(missingInventory(crossRoute, undefined)).toEqual([]);
  });

  it("never blocks Kraken-only triangles regardless of balances", () => {
    expect(missingInventory(triangleRoute, balances([], []))).toEqual([]);
  });

  it("AUTO scenario: top cross route with empty Coinbase inventory is blocked; a fallback triangle is not", () => {
    const b = balances([["ZUSD", 500], ["XXBT", 1]], [["USD", 500]]);
    // candidate filter used by doExecuteGraphRoute / AUTO:
    const candidates = [crossRoute, triangleRoute].filter(r => missingInventory(r, b).length === 0);
    expect(candidates).toEqual([triangleRoute]);
  });

  it("fallback scenario: a fallback cross candidate with short destination inventory is skipped even when the top route passes", () => {
    const b = balances([["SOL", 0.01]], [["BTC", 1]]); // Coinbase BTC ok; Kraken SOL too small
    const candidates = [crossRoute, crossRouteToKraken].filter(r => missingInventory(r, b).length === 0);
    expect(candidates).toEqual([crossRoute]);
  });
});

describe("formatInventoryReqs", () => {
  it("formats human-readable venue requirements", () => {
    expect(formatInventoryReqs([
      { asset: "BTC", exchange: "coinbase", amount: 0.000154 },
      { asset: "SOL", exchange: "kraken", amount: 2.5 },
    ])).toBe("0.000154 BTC on Coinbase, 2.5000 SOL on Kraken");
  });
});
