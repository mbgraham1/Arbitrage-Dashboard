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
 * Thrown when, after the abort window expires and a cancel is sent, Kraken
 * never confirms a TERMINAL status (closed/canceled/expired) for the order.
 * The order may still be resting — and could fill later — so the caller must
 * NOT treat it as cancelled, must not unwind on assumed volumes, and must
 * surface the txid for manual reconciliation.
 */
export class TriIndeterminateOrderError extends Error {
  constructor(public readonly txid: string, public readonly label: string) {
    super(
      `${label} (${txid}) is INDETERMINATE: cancel was sent after the abort window but Kraken never confirmed a terminal status. ` +
      `The order may still be resting and could fill later — do not assume it was cancelled; reconcile ${txid} manually before trading.`,
    );
    this.name = "TriIndeterminateOrderError";
  }
}

/** Terminal Kraken order statuses — nothing more can execute after these. */
const isTerminal = (s: string) => s === "closed" || s === "canceled" || s === "expired";

/**
 * After placing a post-only limit order, poll krakenOrderInfo() until the
 * order closes (status="closed") or the WALL-CLOCK deadline expires
 * (default 90 s — the abort window). Wall-clock matters: rate-limiter
 * queueing/backoff stretches individual polls, and an attempt-counted loop
 * would silently extend the window.
 *
 * On deadline expiry:
 *   1. Attempt to cancel the order (best-effort via krakenCancelOrder).
 *   2. A cancel ACK is NOT terminal — the order can still fill in the race
 *      between deadline expiry and the cancel taking effect. Poll until
 *      Kraken reports a TERMINAL status (closed/canceled/expired):
 *        - closed   → the order filled in the cancel race; return filled=true
 *                     with the ACTUAL fill so the caller continues the cycle.
 *        - canceled/expired → return filled=false with the ACTUAL partial
 *                     volExec/cost/fee for correct unwind sizing.
 *   3. If no terminal status can be confirmed within the confirm window,
 *      FAIL CLOSED: throw TriIndeterminateOrderError. Returning
 *      filled=false/volExec=0 here would let a still-resting order fill
 *      after the caller has already treated it as dead.
 *
 * Only for limit-order legs — market orders fill synchronously and don't need
 * this guard.
 */
export async function waitForTriLimitFill(
  creds: { krakenKey: string; krakenSecret: string },
  txid: string,
  label: string,
  log: { info: (msg: string) => void; error: (msg: string) => void },
  timeoutMs = 90_000,
): Promise<TriFillResult> {
  const pollMs = 500;
  const deadline = Date.now() + timeoutMs; // wall-clock abort window

  while (Date.now() < deadline) {
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

  // Deadline expired — attempt cancel, then confirm the ACTUAL final state.
  log.error(`[TRI·FILL] ${label} (${txid}) timed out after ${timeoutMs}ms — cancelling`);
  try {
    await krakenCancelOrder(creds, txid);
    log.info(`[TRI·FILL] cancel sent for ${label} (${txid})`);
  } catch (e) {
    // Cancel failure is expected in the race (order already closed) — the
    // terminal-status poll below decides what actually happened.
    log.error(`[TRI·FILL] cancel failed for ${label} (${txid}) — may already be terminal: ${(e as Error).message}`);
  }

  // A cancel ACK is not terminal: poll until Kraken reports a TERMINAL
  // status. The order may have filled concurrently (cancel race) — using the
  // actual post-cancel state is essential both to detect that fill and for
  // correct unwind sizing on partials.
  const confirmDeadline = Date.now() + 10_000;
  let final: { status: string; volExec: number; cost: number; fee: number } | null = null;
  for (;;) {
    try {
      const info = await krakenOrderInfo(creds, txid);
      if (isTerminal(info.status)) { final = info; break; }
    } catch { /* transient — retry until confirm deadline */ }
    if (Date.now() >= confirmDeadline) break;
    await new Promise(r => setTimeout(r, pollMs));
  }

  if (final == null) {
    // No terminal status confirmed — the order may STILL be resting and could
    // fill after we walk away. Never report this as "cancelled, no fill".
    log.error(`[TRI·FILL] ${label} (${txid}) INDETERMINATE after cancel — no terminal status confirmed; failing closed`);
    throw new TriIndeterminateOrderError(txid, label);
  }

  if (final.status === "closed") {
    log.info(`[TRI·FILL] ${label} (${txid}) cancel-race: already filled (vol=${final.volExec})`);
    return { filled: true, volExec: final.volExec, cost: final.cost, fee: final.fee };
  }
  log.error(`[TRI·FILL] ${label} (${txid}) cancelled with partial vol=${final.volExec}`);
  return { filled: false, volExec: final.volExec, cost: final.cost, fee: final.fee };
}
