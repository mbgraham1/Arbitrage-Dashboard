/**
 * Realized-P&L exclusion proof for FAILED ledger rows — behavioral, real SQL.
 *
 * GET /trades/summary computes realizedPnlUsd with a hard SQL gate:
 *   SUM(realized_profit_usd) FILTER (WHERE status='verified'
 *                                      AND realized_profit_usd IS NOT NULL)
 * This test runs the EXACT drizzle expressions the route uses (same
 * tradesTable schema, same FILTER clauses) against a scratch-schema copy of
 * the trades table and proves that inserting every failed-row shape a live
 * triangle can produce (realized NULL, realized "0", and even a failed row
 * carrying a provable loss figure) NEVER changes realizedPnlUsd /
 * liveRealizedPnlUsd / verifiedTrades — only failedTrades moves.
 *
 * Isolation: a dedicated pg connection whose search_path resolves the
 * unqualified `trades` name to the scratch schema; the real trades table is
 * never read or written. The schema is dropped in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, count, sum, avg, max } from "drizzle-orm";
import { pool, tradesTable } from "@workspace/db";

interface PoolClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean): void;
}

const SCHEMA = `trades_sum_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

let client: PoolClient;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  // Mirror of lib/db/src/schema/trades.ts (columns the summary reads).
  await client.query(`CREATE TABLE trades (
    id serial PRIMARY KEY,
    created_at timestamp DEFAULT now() NOT NULL,
    pair text,
    buy_exchange text NOT NULL,
    sell_exchange text NOT NULL,
    volume numeric(18,8) NOT NULL,
    estimated_profit_usd numeric(18,6) NOT NULL,
    net_edge_pct numeric(10,4) NOT NULL,
    is_dry_run boolean NOT NULL DEFAULT true,
    kraken_price numeric(18,6) NOT NULL,
    coinbase_price numeric(18,6) NOT NULL,
    buy_order_id text,
    sell_order_id text,
    status text,
    realized_profit_usd numeric(18,6),
    leg_fills jsonb
  )`);
  db = drizzle(client as never);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  client.release();
});

/** EXACT copy of the /trades/summary aggregation (routes/arb.ts). */
async function summaryStats() {
  const [statsRow] = await db
    .select({
      totalTrades: count(),
      liveTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.isDryRun} = false)`,
      dryRunTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.isDryRun} = true)`,
      totalProfitUsd: sum(tradesTable.estimatedProfitUsd),
      avgNetEdgePct: avg(tradesTable.netEdgePct),
      bestTradeProfitUsd: max(tradesTable.estimatedProfitUsd),
      verifiedTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL)`,
      failedTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'failed')`,
      simulatedTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'simulated' OR ${tradesTable.status} = 'estimated' OR ${tradesTable.status} IS NULL)`,
      realizedPnlUsd: sql<string | null>`SUM(${tradesTable.realizedProfitUsd}) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL)`,
      bestVerifiedProfitUsd: sql<string | null>`MAX(${tradesTable.realizedProfitUsd}) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL)`,
      liveCompletedCycles: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL AND ${tradesTable.isDryRun} = false)`,
      liveRealizedPnlUsd: sql<string | null>`SUM(${tradesTable.realizedProfitUsd}) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL AND ${tradesTable.isDryRun} = false)`,
    })
    .from(tradesTable);
  return statsRow!;
}

const baseRow = {
  buyExchange: "kraken", sellExchange: "kraken",
  volume: "2.00000000", estimatedProfitUsd: "0.300000", netEdgePct: "0",
  isDryRun: false, krakenPrice: "0", coinbasePrice: "0",
} as const;

describe("/trades/summary realized P&L gate — failed rows can never count", () => {

  it("baseline: one verified live cycle sets realizedPnlUsd", async () => {
    await db.insert(tradesTable).values({
      ...baseRow, pair: "USD→ATOM→BTC→USD",
      buyOrderId: "V1", sellOrderId: "V3",
      status: "verified", realizedProfitUsd: "5.000000",
      legFills: [{ leg: 1 }, { leg: 2 }, { leg: 3 }],
    });
    const s = await summaryStats();
    expect(Number(s.verifiedTrades)).toBe(1);
    expect(parseFloat(String(s.realizedPnlUsd))).toBeCloseTo(5, 6);
    expect(parseFloat(String(s.liveRealizedPnlUsd))).toBeCloseTo(5, 6);
    expect(Number(s.failedTrades)).toBe(0);
  });

  it("failed rows in every live-failure shape leave realizedPnlUsd UNCHANGED; only failedTrades moves", async () => {
    // Shape 1 — leg-2/leg-3 death with confirmed partial fills: realized NULL.
    await db.insert(tradesTable).values({
      ...baseRow, pair: "USD→ATOM→BTC→USD [FAILED: EOrder:Rejected]",
      buyOrderId: "L1", status: "failed", realizedProfitUsd: null,
      legFills: [{ leg: 1, volume: 2, costUsd: 10, txid: "L1" }],
    });
    // Shape 2 — accepted order, PROVEN zero fill: realized exactly 0.
    await db.insert(tradesTable).values({
      ...baseRow, pair: "USD→ATOM→BTC→USD [FAILED: lock revoked]",
      volume: "0.00000000", status: "failed", realizedProfitUsd: "0",
      legFills: [{ leg: 1, volume: 0, txid: "Z1" }],
    });
    // Shape 3 — failed row carrying a provable LOSS figure (unwind reconciled):
    // still excluded — losses on failed rows are diagnostics, not Realized P&L.
    await db.insert(tradesTable).values({
      ...baseRow, pair: "USD→ATOM→BTC→USD [FAILED: unwound at a loss]",
      status: "failed", realizedProfitUsd: "-0.750000",
      legFills: [{ leg: 1, volume: 2, txid: "L1", unwind: true }],
    });

    const s = await summaryStats();
    expect(Number(s.failedTrades)).toBe(3);
    // The money invariant: realized P&L is EXACTLY the verified baseline.
    expect(parseFloat(String(s.realizedPnlUsd))).toBeCloseTo(5, 6);
    expect(parseFloat(String(s.liveRealizedPnlUsd))).toBeCloseTo(5, 6);
    expect(Number(s.verifiedTrades)).toBe(1);
    expect(Number(s.liveCompletedCycles)).toBe(1);
    expect(parseFloat(String(s.bestVerifiedProfitUsd))).toBeCloseTo(5, 6);
  });

  it("a verified-status row with NULL realized (indeterminate) is also excluded — the NOT NULL clause is the hard gate", async () => {
    await db.insert(tradesTable).values({
      ...baseRow, pair: "XV indeterminate",
      status: "verified", realizedProfitUsd: null,
    });
    const s = await summaryStats();
    expect(Number(s.verifiedTrades)).toBe(1); // still just the baseline
    expect(parseFloat(String(s.realizedPnlUsd))).toBeCloseTo(5, 6);
  });
});
