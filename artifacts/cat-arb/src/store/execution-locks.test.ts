import { describe, it, expect, vi } from "vitest";
import { withExecutionLock, type LockRef } from "./execution-locks";
import { maybeAutoExecuteOb, type ObAutoExecuteParams } from "./ob-auto-execute";
import type { ObCycleEntry } from "@workspace/api-client-react";

// ── Integration tests: forced executions hold the SAME lock refs the OB ──────
// auto-execute gate reads, exactly as wired in bot-context. A forced
// cross-exchange trade runs inside withExecutionLock(isExecutingRef, ...) and
// a forced triangular trade inside withExecutionLock(isAutoExecutingTriRef, ...);
// the OB gate reads those refs' .current at scan-arrival time.

const readyCycle: ObCycleEntry = {
  route: "USD→BTC→ETH→USD",
  assetA: "BTC",
  assetB: "ETH",
  legs: 3,
  status: "READY",
  estimatedProfitUsd: 0.5,
  slippagePct: 0.1,
} as ObCycleEntry;

/** Mirrors the gate wiring in bot-context's OB scan effect. */
function obScanArrives(
  locks: { isExecuting: LockRef; isAutoExecutingTri: LockRef; isAutoExecutingOb: LockRef },
  execute: ObAutoExecuteParams["execute"],
): boolean {
  return maybeAutoExecuteOb({
    cycles: [readyCycle],
    isRunning: true,
    emergencyStop: false,
    isExecuting: locks.isExecuting.current,
    isAutoExecutingTri: locks.isAutoExecutingTri.current,
    isAutoExecutingOb: locks.isAutoExecutingOb.current,
    now: 100_000,
    lastObTradeTime: 0,
    cooldownMs: 30_000,
    obMinProfitUsd: 0.02,
    execute,
  });
}

function makeLocks() {
  return {
    isExecuting: { current: false },
    isAutoExecutingTri: { current: false },
    isAutoExecutingOb: { current: false },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("forced executions block the OB auto-executor via shared locks", () => {
  it("OB never fires while a forced cross-exchange trade is in flight, then fires after release", async () => {
    const locks = makeLocks();
    const trade = deferred();
    // Forced cross-exchange trade starts (bot-context: withExecutionLock(isExecutingRef, ...))
    const forced = withExecutionLock(locks.isExecuting, () => trade.promise);

    // OB scan arrives mid-trade — mutation must NOT fire
    const execute = vi.fn();
    expect(obScanArrives(locks, execute)).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    // Trade completes → lock released → next scan may fire
    trade.resolve();
    await forced;
    expect(locks.isExecuting.current).toBe(false);
    expect(obScanArrives(locks, execute)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("OB never fires while a forced triangular trade is in flight, then fires after release", async () => {
    const locks = makeLocks();
    const trade = deferred();
    const forced = withExecutionLock(locks.isAutoExecutingTri, () => trade.promise);

    const execute = vi.fn();
    expect(obScanArrives(locks, execute)).toBe(false);
    expect(execute).not.toHaveBeenCalled();

    trade.resolve();
    await forced;
    expect(obScanArrives(locks, execute)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("releases the lock even when the forced trade throws, so OB is not blocked forever", async () => {
    const locks = makeLocks();
    await expect(
      withExecutionLock(locks.isExecuting, async () => { throw new Error("kraken down"); }),
    ).rejects.toThrow("kraken down");
    expect(locks.isExecuting.current).toBe(false);

    const execute = vi.fn();
    expect(obScanArrives(locks, execute)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("a second execution on the same lock is a no-op while the first is in flight", async () => {
    const lock: LockRef = { current: false };
    const first = deferred();
    const running = withExecutionLock(lock, async () => { await first.promise; return "first"; });

    const second = vi.fn(async () => "second");
    expect(await withExecutionLock(lock, second)).toBeUndefined();
    expect(second).not.toHaveBeenCalled();

    first.resolve();
    expect(await running).toBe("first");
  });
});
