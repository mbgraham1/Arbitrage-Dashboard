import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * Account-snapshot retention (P&L-safe by construction).
 *
 * account_snapshots grows on every live trade and every changed 60s poll.
 * Retention policy:
 *   • post_trade rows: NEVER deleted — they're the audit trail.
 *   • each account's first-ever row: NEVER deleted — lifetime P&L baseline.
 *   • poll rows younger than 7 days: kept in full (today's baseline lives here).
 *   • poll rows 7–30 days old: downsampled to one per (account, hour) bucket
 *     (earliest row in the bucket survives).
 *   • poll rows older than 30 days: downsampled to one per (account, day).
 *
 * P&L math only reads the first-ever row, today's first row, and the latest
 * row — all untouched by this policy, so reported numbers don't change.
 */

/**
 * The EXACT retention statements, exported so the integration test can run
 * the identical SQL against an isolated scratch schema (search_path-scoped)
 * without issuing global deletes on the shared database. The table name is
 * intentionally unqualified — resolution follows the session search_path.
 */
export const SNAPSHOT_PRUNE_STATEMENTS: readonly string[] = [
  // Hourly downsample: poll rows older than 7 days, keep the earliest row in
  // each (account, hour) bucket. First-ever rows are excluded explicitly.
  `
    DELETE FROM account_snapshots s
    WHERE s.trigger = 'poll'
      AND s.created_at < now() - interval '7 days'
      AND s.created_at >= now() - interval '30 days'
      AND s.id <> (SELECT min(m.id) FROM account_snapshots m WHERE m.account_id = s.account_id)
      AND s.id NOT IN (
        SELECT min(b.id)
        FROM account_snapshots b
        WHERE b.trigger = 'poll'
          AND b.created_at < now() - interval '7 days'
          AND b.created_at >= now() - interval '30 days'
        GROUP BY b.account_id, date_trunc('hour', b.created_at)
      )
  `,
  // Daily downsample: poll rows older than 30 days, keep the earliest row in
  // each (account, day) bucket.
  `
    DELETE FROM account_snapshots s
    WHERE s.trigger = 'poll'
      AND s.created_at < now() - interval '30 days'
      AND s.id <> (SELECT min(m.id) FROM account_snapshots m WHERE m.account_id = s.account_id)
      AND s.id NOT IN (
        SELECT min(b.id)
        FROM account_snapshots b
        WHERE b.trigger = 'poll'
          AND b.created_at < now() - interval '30 days'
        GROUP BY b.account_id, date_trunc('day', b.created_at)
      )
  `,
];

/** Run the retention deletes immediately (no throttle). Throws on SQL
 *  failure — the throttled wrapper is what swallows errors. */
export async function runSnapshotPruneNow(): Promise<void> {
  for (const stmt of SNAPSHOT_PRUNE_STATEMENTS) {
    await db.execute(sql.raw(stmt));
  }
}

const SNAPSHOT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // at most every 6h
let lastSnapshotPruneMs = 0;

/** Test hook: reset the throttle so the next call actually prunes. */
export function __resetSnapshotPruneThrottle(): void {
  lastSnapshotPruneMs = 0;
}

/** Throttled, fire-and-forget-safe wrapper used by the account-pnl endpoint.
 *  Never throws; at most one prune per interval per process. `runner` is
 *  injectable for tests only — production callers pass nothing. */
export async function pruneAccountSnapshots(
  log: { error: (o: object, m: string) => void },
  runner: () => Promise<void> = runSnapshotPruneNow,
): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastSnapshotPruneMs < SNAPSHOT_PRUNE_INTERVAL_MS) return;
  lastSnapshotPruneMs = nowMs; // set first — a failing prune must not retry every request
  try {
    await runner();
  } catch (err) {
    log.error({ err }, "account snapshot prune failed");
  }
}
