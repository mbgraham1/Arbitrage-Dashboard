/**
 * Shared thin-edge AUTO-fire predicate.
 *
 * When an auto-executor (graph, OB, or triangular) fires a LIVE trade whose
 * estimated profit is below the trader's thin-edge warning threshold
 * (settings.thinEdgeWarnPct % of trade size), the card shows a non-blocking
 * amber "AUTO fired on a thin edge" warning row after the fact.
 *
 * Rules enforced here (unit-tested in auto-thin-fire.test.ts):
 *  - Dry runs NEVER produce a warning snapshot, regardless of profit.
 *  - Live fires at/above the threshold return null (and callers clear any
 *    previous snapshot).
 *  - Invalid trade sizes (null/0/negative) never warn — no divide-by-zero
 *    banners from a rejected or unsized execution.
 */
export interface ThinFireSnapshot {
  profitUsd: number;
  tradeSizeUsd: number;
  description: string;
  at: number;
}

/**
 * Post-execution variant: evaluates the thin-edge warning from an execute
 * RESULT, so a preflight-rejected or errored attempt (no orders placed) can
 * never produce an "AUTO fired" banner. Returns null unless the execution
 * actually went through (`success && executed`), then applies the same
 * thin-edge rules as thinFireSnapshot.
 */
export function thinFireFromExecResult(params: {
  success: boolean;
  executed: boolean;
  isDryRun: boolean;
  profitUsd: number | null | undefined;
  tradeSizeUsd: number | null | undefined;
  thinEdgeWarnPct: number;
  description: string;
  at: number;
}): ThinFireSnapshot | null {
  if (!params.success || !params.executed) return null;
  return thinFireSnapshot(params);
}

export function thinFireSnapshot(params: {
  isDryRun: boolean;
  profitUsd: number | null | undefined;
  tradeSizeUsd: number | null | undefined;
  thinEdgeWarnPct: number;
  description: string;
  at: number;
}): ThinFireSnapshot | null {
  const { isDryRun, profitUsd, tradeSizeUsd, thinEdgeWarnPct, description, at } = params;
  if (isDryRun) return null;
  if (profitUsd == null || tradeSizeUsd == null || tradeSizeUsd <= 0) return null;
  if (profitUsd >= (thinEdgeWarnPct / 100) * tradeSizeUsd) return null;
  return { profitUsd, tradeSizeUsd, description, at };
}
