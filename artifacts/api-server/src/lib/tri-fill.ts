/**
 * Triangular-arb fill-confirmation helper.
 *
 * Extracted into its own module so it can be unit-tested without pulling in
 * the full Express/Drizzle stack that lives in src/routes/arb.ts.
 */
import { krakenOrderInfo, krakenCancelOrder } from "./exchange.js";

export interface TriFillResult {
  /** true = order fully closed; false = timed out / cancelled */
  filled: boolean;
  /** Actual base-currency volume executed (0 when no fill at all) */
  volExec: number;
  /** Quote currency spent/received (ex-fee) */
  cost: number;
  /** Fee charged (same currency as cost) */
  fee: number;
}

/**
 * After placing a post-only limit order, poll krakenOrderInfo() until the
 * order closes (status="closed") or the timeout expires.
 *
 * On timeout:
 *   1. Attempt to cancel the order (best-effort via krakenCancelOrder).
 *   2. Re-query the final order state to capture any partial fill and to
 *      detect a cancel-race (order filled concurrently with our cancel).
 *
 * Returns:
 *   - filled=true  → order is fully closed; volExec/cost/fee reflect actual fill
 *   - filled=false → timed out or already cancelled; volExec/cost/fee reflect
 *     whatever was executed before cancellation — use these for unwind sizing
 *
 * Only for limit-order legs — market orders fill synchronously and don't need
 * this guard.
 */
export async function waitForTriLimitFill(
  creds: { krakenKey: string; krakenSecret: string },
  txid: string,
  label: string,
  log: { info: (msg: string) => void; error: (msg: string) => void },
  timeoutMs = 10_000,
): Promise<TriFillResult> {
  const pollMs = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollMs);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollMs));
    let info: { status: string; volExec: number; cost: number; fee: number };
    try {
      info = await krakenOrderInfo(creds, txid);
    } catch {
      continue; // transient network error — keep retrying
    }
    if (info.status === "closed") {
      log.info(`[TRI·FILL] ${label} (${txid}) confirmed filled (vol=${info.volExec})`);
      return { filled: true, volExec: info.volExec, cost: info.cost, fee: info.fee };
    }
    if (info.status === "canceled" || info.status === "expired") {
      log.error(`[TRI·FILL] ${label} (${txid}) found already ${info.status} (partial vol=${info.volExec})`);
      return { filled: false, volExec: info.volExec, cost: info.cost, fee: info.fee };
    }
    // "open" or "partial" — keep polling
  }

  // Timeout — attempt cancel then read actual final state
  log.error(`[TRI·FILL] ${label} (${txid}) timed out after ${timeoutMs}ms — cancelling`);
  try {
    await krakenCancelOrder(creds, txid);
    log.info(`[TRI·FILL] cancel sent for ${label} (${txid})`);
  } catch (e) {
    log.error(`[TRI·FILL] cancel failed for ${label} (${txid}): ${(e as Error).message}`);
  }

  // Must re-query after cancel: the order may have filled concurrently (cancel-race).
  // Using the actual post-cancel vol_exec is essential for correct unwind sizing.
  let final: { status: string; volExec: number; cost: number; fee: number } =
    { status: "unknown", volExec: 0, cost: 0, fee: 0 };
  try { final = await krakenOrderInfo(creds, txid); } catch { /* use zero defaults */ }

  const filled = final.status === "closed";
  if (filled) {
    log.info(`[TRI·FILL] ${label} (${txid}) cancel-race: already filled (vol=${final.volExec})`);
  } else {
    log.error(`[TRI·FILL] ${label} (${txid}) cancelled with partial vol=${final.volExec}`);
  }
  return { filled, volExec: final.volExec, cost: final.cost, fee: final.fee };
}
