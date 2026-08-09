import { describe, it, expect, vi } from "vitest";
import { maybeAutoExecuteOb, type ObAutoExecuteParams } from "./ob-auto-execute";
import type { ObCycleEntry } from "@workspace/api-client-react";

// A READY 3-leg cycle comfortably above the default $0.02 profit floor —
// if the gate is open, this cycle WILL fire.
const readyCycle: ObCycleEntry = {
  route: "USD→BTC→ETH→USD",
  assetA: "BTC",
  assetB: "ETH",
  legs: 3,
  status: "READY",
  estimatedProfitUsd: 0.5,
  slippagePct: 0.1,
} as ObCycleEntry;

function baseParams(overrides: Partial<ObAutoExecuteParams> = {}): ObAutoExecuteParams {
  return {
    cycles: [readyCycle],
    isRunning: true,
    emergencyStop: false,
    isExecuting: false,
    isAutoExecutingTri: false,
    isAutoExecutingOb: false,
    now: 100_000,
    lastObTradeTime: 0,
    cooldownMs: 30_000,
    obMinProfitUsd: 0.02,
    execute: vi.fn(),
    ...overrides,
  };
}

describe("OB auto-executor gate (maybeAutoExecuteOb)", () => {
  it("fires the execute mutation when no other executor is in flight (positive control)", () => {
    const execute = vi.fn();
    const fired = maybeAutoExecuteOb(baseParams({ execute }));
    expect(fired).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(readyCycle);
  });

  it("never calls the OB execute mutation while a cross-exchange trade is running (isExecutingRef = true)", () => {
    const execute = vi.fn();
    const fired = maybeAutoExecuteOb(baseParams({ isExecuting: true, execute }));
    expect(fired).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("never calls the OB execute mutation while a triangular auto-trade is running (isAutoExecutingTriRef = true)", () => {
    const execute = vi.fn();
    const fired = maybeAutoExecuteOb(baseParams({ isAutoExecutingTri: true, execute }));
    expect(fired).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("never calls the OB execute mutation while a previous OB auto-trade is still in flight (isAutoExecutingObRef = true)", () => {
    const execute = vi.fn();
    const fired = maybeAutoExecuteOb(baseParams({ isAutoExecutingOb: true, execute }));
    expect(fired).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("stays gated even when multiple locks are held at once", () => {
    const execute = vi.fn();
    const fired = maybeAutoExecuteOb(
      baseParams({ isExecuting: true, isAutoExecutingTri: true, execute }),
    );
    expect(fired).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not fire when the bot is stopped, emergency-stopped, or cooling down", () => {
    for (const overrides of [
      { isRunning: false },
      { emergencyStop: true },
      { lastObTradeTime: 90_000 }, // 10s ago < 30s cooldown
    ] as Partial<ObAutoExecuteParams>[]) {
      const execute = vi.fn();
      expect(maybeAutoExecuteOb(baseParams({ ...overrides, execute }))).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("skips non-READY and below-floor cycles even when the gate is open", () => {
    const execute = vi.fn();
    const cycles = [
      { ...readyCycle, status: "HIGH_SLIPPAGE" },
      { ...readyCycle, estimatedProfitUsd: 0.01 },
    ] as ObCycleEntry[];
    expect(maybeAutoExecuteOb(baseParams({ cycles, execute }))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("v21: executes a READY 4-leg route above the floor (executor places one order per hop)", () => {
    const execute = vi.fn();
    const fourLeg = { ...readyCycle, legs: 4, route: "USD→SOL→BTC→ETH→USD", path: ["SOL", "BTC", "ETH"] } as ObCycleEntry;
    expect(maybeAutoExecuteOb(baseParams({ cycles: [fourLeg], execute }))).toBe(true);
    expect(execute).toHaveBeenCalledWith(fourLeg);
  });
});
