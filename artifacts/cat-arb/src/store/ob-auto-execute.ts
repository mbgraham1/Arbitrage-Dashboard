import type { ObCycleEntry } from "@workspace/api-client-react";

/**
 * Inputs for the OB Hunter auto-execute decision. All lock flags mirror the
 * refs in bot-context so the gate can be unit-tested without React.
 */
export interface ObAutoExecuteParams {
  /** Cycles from the latest /arb/ob-scan response */
  cycles: ObCycleEntry[];
  /** Bot master switch */
  isRunning: boolean;
  /** Emergency stop engaged */
  emergencyStop: boolean;
  /** True while a cross-exchange trade is in flight (isExecutingRef) */
  isExecuting: boolean;
  /** True while the triangular auto-executor is in flight (isAutoExecutingTriRef) */
  isAutoExecutingTri: boolean;
  /** True while a previous OB auto-execute is still in flight (isAutoExecutingObRef) */
  isAutoExecutingOb: boolean;
  /** Current timestamp (ms) */
  now: number;
  /** Timestamp (ms) of the last OB auto-trade */
  lastObTradeTime: number;
  /** Cooldown between OB auto-trades (ms) */
  cooldownMs: number;
  /** Profit floor in USD — cycles at or below this are skipped */
  obMinProfitUsd: number;
  /** Fires the OB execute mutation for the chosen cycle */
  execute: (cycle: ObCycleEntry) => void;
}

/**
 * OB Hunter auto-execute gate + cycle selection.
 *
 * Calls `execute` with the best READY 3-leg cycle above the profit floor —
 * but only when the bot is running, no other executor (cross-exchange,
 * triangular, or a prior OB trade) is in flight, the emergency stop is off,
 * and the cooldown has elapsed. Returns true iff `execute` was called.
 */
export function maybeAutoExecuteOb(p: ObAutoExecuteParams): boolean {
  if (
    !p.isRunning ||
    p.emergencyStop ||
    p.isExecuting ||
    p.isAutoExecutingTri ||
    p.isAutoExecutingOb ||
    p.now - p.lastObTradeTime < p.cooldownMs
  ) return false;

  // Pick the best READY cycle above the profit floor. cycles[] is sorted by
  // estimatedProfitUsd descending, but the #1 entry may be HIGH_SLIPPAGE or
  // LOW_PROFIT — filter first, then take the highest-profit READY one.
  // v21: 4-leg routes are executable too — the executor places one order per
  // hop from the cycle's full asset path (bot-context passes `path` through).
  const top = p.cycles
    .filter(c => c.status === "READY" && c.estimatedProfitUsd > p.obMinProfitUsd)
    .sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd)[0];
  if (!top) return false;

  p.execute(top);
  return true;
}
