/**
 * Snapshot-prune retention proof: the pruning SQL must NEVER delete a P&L
 * baseline or a post_trade audit row, and downsampling must keep exactly one
 * poll row per (account, hour) bucket at 7–30 days and one per (account, day)
 * bucket beyond 30 days.
 *
 * Isolation: runs the EXACT production statements (SNAPSHOT_PRUNE_STATEMENTS
 * — the same strings runSnapshotPruneNow executes) against a scratch schema
 * on dedicated pg connections whose search_path resolves the unqualified
 * `account_snapshots` name to the scratch table. The shared database's real
 * account_snapshots table is never read or written; the schema is dropped in
 * afterAll.
 *
 * Concurrency: the account-pnl endpoint fires the prune fire-and-forget on
 * every poll, so overlapping runs are real. The FIRST test races three
 * dedicated connections over freshly seeded, deletable redundant rows —
 * before any serial prune — and asserts exactly one keeper per bucket
 * survives along with every baseline and post_trade row. A later test
 * re-runs the statements serially to prove idempotence, and the throttle
 * wrapper is tested with an injected runner (no DB side effects).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { pool } from "@workspace/db";

// Minimal structural client type (pg's own types aren't a direct dependency
// of this package; the pool from @workspace/db returns a compatible client).
interface PoolClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean): void;
}
import { SNAPSHOT_PRUNE_STATEMENTS, pruneAccountSnapshots, __resetSnapshotPruneThrottle } from "./snapshot-prune.js";

const SCHEMA = `prune_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const ACCT_A = "acct-A";
const ACCT_B = "acct-B";
const ACCT_C = "acct-C"; // post_trade-first baseline account
const DAY = 24 * 3600 * 1000;

// Three dedicated clients — enough to genuinely race the two DELETE
// statements across separate backend processes.
const clients: PoolClient[] = [];

async function newClient(): Promise<PoolClient> {
  const c: PoolClient = await pool.connect();
  // Unqualified account_snapshots resolves ONLY to the scratch schema on this
  // connection — the real table is unreachable from these sessions.
  await c.query(`SET search_path TO ${SCHEMA}`);
  // Deterministic date_trunc bucketing regardless of server default TZ.
  await c.query(`SET timezone TO 'UTC'`);
  return c;
}

/** Run both production prune statements, in order, on one connection. */
async function runPruneOn(c: PoolClient): Promise<void> {
  for (const stmt of SNAPSHOT_PRUNE_STATEMENTS) await c.query(stmt);
}

// label ↔ inserted id bookkeeping (labels aren't a schema column)
const idByLabel = new Map<string, number>();
const mustSurvive = new Set<string>();
const mustDelete = new Set<string>();

async function insertRow(c: PoolClient, accountId: string, createdAt: Date, trigger: string, label: string): Promise<void> {
  const r = await c.query(
    `INSERT INTO account_snapshots (account_id, created_at, total_usd, usd_balance, holdings_usd, trigger, has_unpriced)
     VALUES ($1, $2, 1000, 1000, 0, $3, false) RETURNING id`,
    [accountId, createdAt.toISOString(), trigger],
  );
  idByLabel.set(label, Number((r.rows[0] as { id: number | string }).id));
}

async function survivingLabels(c: PoolClient): Promise<Set<string>> {
  const r = await c.query(`SELECT id FROM account_snapshots`);
  const alive = new Set(r.rows.map(x => Number((x as { id: number | string }).id)));
  const out = new Set<string>();
  for (const [label, id] of idByLabel) if (alive.has(id)) out.add(label);
  return out;
}

describe("account snapshot pruning (isolated schema, production SQL)", () => {
  beforeAll(async () => {
    const admin: PoolClient = await pool.connect();
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    // Mirror of lib/db/src/schema/account-snapshots.ts — same columns/types.
    await admin.query(`
      CREATE TABLE ${SCHEMA}.account_snapshots (
        id serial PRIMARY KEY,
        account_id text NOT NULL DEFAULT 'legacy',
        created_at timestamptz NOT NULL DEFAULT now(),
        total_usd numeric(18,6) NOT NULL,
        usd_balance numeric(18,6) NOT NULL,
        holdings_usd numeric(18,6) NOT NULL,
        trigger text NOT NULL,
        has_unpriced boolean NOT NULL DEFAULT false
      )
    `);
    admin.release();

    for (let i = 0; i < 3; i++) clients.push(await newClient());
    const c = clients[0]!;

    // ── Seed: 2 accounts with every protected + every deletable row kind ────
    const now = Date.now();
    for (const [acct, tag] of [[ACCT_A, "A"], [ACCT_B, "B"]] as const) {
      // 1. Lifetime baseline: FIRST-EVER row (smallest id for the account,
      //    matching production), a poll deep inside the daily-prune window —
      //    maximally exposed to a regression.
      await insertRow(c, acct, new Date(now - 60 * DAY), "poll", `${tag}-baseline`);
      mustSurvive.add(`${tag}-baseline`);
      // 2. post_trade audit rows in every age band — never deletable.
      for (const [age, name] of [[45, "old"], [15, "mid"], [2, "recent"]] as const) {
        await insertRow(c, acct, new Date(now - age * DAY), "post_trade", `${tag}-pt-${name}`);
        mustSurvive.add(`${tag}-pt-${name}`);
      }
      // 3. Hourly bucket (7–30d): 3 poll rows inside ONE hour, 10 days ago.
      //    Earliest survives; the two later ones must be pruned.
      // Hour-aligned so all three rows share one date_trunc('hour') bucket.
      const hourBase = Math.floor((now - 10 * DAY) / 3600_000) * 3600_000;
      for (let i = 0; i < 3; i++) {
        const label = `${tag}-hour-${i}`;
        await insertRow(c, acct, new Date(hourBase + i * 60_000), "poll", label);
        (i === 0 ? mustSurvive : mustDelete).add(label);
      }
      // 4. Lone poll row in a different hour of the same window — sole member
      //    of its bucket, must survive.
      await insertRow(c, acct, new Date(hourBase + 5 * 3600_000), "poll", `${tag}-hour-lone`);
      mustSurvive.add(`${tag}-hour-lone`);
      // 5. Daily bucket (>30d): 3 poll rows on ONE day 40 days ago, spread by
      //    HOURS so they'd land in different hourly buckets — proving the
      //    daily pass (not the hourly one) collapses them.
      // UTC-day-aligned so rows spread by hours stay in one 'day' bucket.
      const dayBase = Math.floor((now - 40 * DAY) / DAY) * DAY;
      for (let i = 0; i < 3; i++) {
        const label = `${tag}-day-${i}`;
        await insertRow(c, acct, new Date(dayBase + i * 3600_000), "poll", label);
        (i === 0 ? mustSurvive : mustDelete).add(label);
      }
      // 6. Recent poll rows (<7d): kept in full — today's baseline lives here.
      for (const [age, name] of [[0.02, "now"], [1, "1d"], [6, "6d"]] as const) {
        await insertRow(c, acct, new Date(now - age * DAY), "poll", `${tag}-poll-${name}`);
        mustSurvive.add(`${tag}-poll-${name}`);
      }
    }
    // ── Account C: FIRST-EVER row is post_trade (live-trade-first account) ──
    const cDay = Math.floor((now - 50 * DAY) / DAY) * DAY;
    await insertRow(c, ACCT_C, new Date(cDay), "post_trade", "C-baseline-pt");
    mustSurvive.add("C-baseline-pt");
    await insertRow(c, ACCT_C, new Date(cDay + 3600_000), "poll", "C-day-keep");
    mustSurvive.add("C-day-keep");
    await insertRow(c, ACCT_C, new Date(cDay + 2 * 3600_000), "poll", "C-day-drop");
    mustDelete.add("C-day-drop");
  });

  afterAll(async () => {
    // Destroy (not recycle) the search_path-modified connections so the
    // scratch path can never leak back into the shared pool.
    for (const c of clients) c.release(true);
    const admin: PoolClient = await pool.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    admin.release();
  });

  it("concurrent polls racing over deletable rows: baselines + post_trade survive, exactly one keeper per bucket", async () => {
    // Race three dedicated connections BEFORE any serial prune — the seeded
    // redundant rows are all still deletable here, so the race is real.
    await Promise.all(clients.map(c => runPruneOn(c)));
    const alive = await survivingLabels(clients[0]!);
    for (const label of mustSurvive) expect(alive, `expected survivor ${label}`).toContain(label);
    for (const label of mustDelete) expect(alive, `expected ${label} deleted`).not.toContain(label);
    expect(alive.size).toBe(mustSurvive.size);
  });

  it("re-seeded redundant rows are pruned again identically (idempotent policy)", async () => {
    const c = clients[0]!;
    const now = Date.now();
    // Fresh redundant rows in already-pruned buckets: a second hourly-window
    // row in the surviving A-hour-0 keeper's bucket, and a daily-window row
    // in A-day-0's bucket. Both are later than their keepers → must be
    // deleted. Same alignment math as the seed so the buckets coincide.
    const hourBase = Math.floor((now - 10 * DAY) / 3600_000) * 3600_000;
    const dayBase = Math.floor((now - 40 * DAY) / DAY) * DAY;
    await insertRow(c, ACCT_A, new Date(hourBase + 30 * 60_000), "poll", "A-hour-reseed");
    await insertRow(c, ACCT_A, new Date(dayBase + 90 * 60_000), "poll", "A-day-reseed");
    mustDelete.add("A-hour-reseed");
    mustDelete.add("A-day-reseed");
    await runPruneOn(c);
    const alive = await survivingLabels(c);
    expect(alive).not.toContain("A-hour-reseed");
    expect(alive).not.toContain("A-day-reseed");
    // Survivor set unchanged — running the policy again never over-deletes.
    for (const label of mustSurvive) expect(alive).toContain(label);
    expect(alive.size).toBe(mustSurvive.size);
  });

  it("throttled wrapper collapses a burst of calls into one run and never throws", async () => {
    __resetSnapshotPruneThrottle();
    const log = { error: vi.fn() };
    let runs = 0;
    const runner = async () => { runs++; };
    await Promise.all([
      pruneAccountSnapshots(log, runner),
      pruneAccountSnapshots(log, runner),
      pruneAccountSnapshots(log, runner),
    ]);
    expect(runs).toBe(1); // burst collapsed
    // A later call inside the interval is a no-op.
    await pruneAccountSnapshots(log, runner);
    expect(runs).toBe(1);
    expect(log.error).not.toHaveBeenCalled();

    // A failing prune is swallowed (fire-and-forget safety) and does NOT
    // retry until the interval elapses.
    __resetSnapshotPruneThrottle();
    const bad = async () => { throw new Error("boom"); };
    await pruneAccountSnapshots(log, bad);
    expect(log.error).toHaveBeenCalledTimes(1);
    let ranAfterFailure = 0;
    await pruneAccountSnapshots(log, async () => { ranAfterFailure++; });
    expect(ranAfterFailure).toBe(0);
  });
});
