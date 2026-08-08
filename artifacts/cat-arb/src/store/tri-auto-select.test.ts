import { describe, it, expect, vi } from "vitest";
import { selectTriAutoOpportunity } from "./tri-auto-select";
import type { TriangularOpportunity } from "@workspace/api-client-react";

function opp(over: Partial<TriangularOpportunity>): TriangularOpportunity {
  return {
    exchange: "Kraken",
    loop: "USD→ETH→SOL→USD",
    profitPct: 0.2,
    solUsd: 150,
    ethUsd: 3000,
    ethSol: 20,
    variant: "eth",
    timestamp: new Date().toISOString(),
    ...over,
  } as TriangularOpportunity;
}

describe("selectTriAutoOpportunity", () => {
  it("skips a synthetic Kraken ETH opportunity and warns (lowercase priceSource keys vs display-cased exchange)", () => {
    const warn = vi.fn();
    const best = selectTriAutoOpportunity(
      [opp({ exchange: "Kraken", profitPct: 0.5 })],
      { kraken: "synthetic" },
      0.05,
      warn,
    );
    expect(best).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("synthetic cross-rate");
    expect(warn.mock.calls[0][0]).toContain("Kraken");
  });

  it("allows an ETH opportunity when the price source is direct", () => {
    const warn = vi.fn();
    const best = selectTriAutoOpportunity(
      [opp({ exchange: "Coinbase", profitPct: 0.3 })],
      { coinbase: "direct", kraken: "synthetic" },
      0.05,
      warn,
    );
    expect(best?.exchange).toBe("Coinbase");
    expect(warn).not.toHaveBeenCalled();
  });

  it("BTC-variant loops are unaffected by a synthetic ETH/SOL source", () => {
    const warn = vi.fn();
    const best = selectTriAutoOpportunity(
      [opp({ variant: "btc", loop: "USD→BTC→SOL→USD", profitPct: 0.2 })],
      { kraken: "synthetic" },
      0.05,
      warn,
    );
    expect(best?.variant).toBe("btc");
    expect(warn).not.toHaveBeenCalled();
  });

  it("prefers BTC over a higher-profit direct ETH loop, and falls back to direct ETH when no BTC", () => {
    const warn = vi.fn();
    const btc = opp({ variant: "btc", loop: "USD→BTC→SOL→USD", profitPct: 0.1 });
    const eth = opp({ exchange: "Kraken", profitPct: 0.9 });
    expect(selectTriAutoOpportunity([btc, eth], { kraken: "direct" }, 0.05, warn)).toBe(btc);
    expect(selectTriAutoOpportunity([eth], { kraken: "direct" }, 0.05, warn)).toBe(eth);
  });

  it("filters below-threshold opportunities without warning", () => {
    const warn = vi.fn();
    const best = selectTriAutoOpportunity(
      [opp({ profitPct: 0.01 })],
      { kraken: "synthetic" },
      0.05,
      warn,
    );
    expect(best).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a missing price source entry as tradable (fail-open only for unknown, not synthetic)", () => {
    const warn = vi.fn();
    const best = selectTriAutoOpportunity(
      [opp({ exchange: "Coinbase", profitPct: 0.3 })],
      {},
      0.05,
      warn,
    );
    expect(best?.exchange).toBe("Coinbase");
    expect(warn).not.toHaveBeenCalled();
  });
});
