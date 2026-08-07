import { pgTable, serial, timestamp, text, numeric, boolean, index } from "drizzle-orm/pg-core";

/**
 * Point-in-time Kraken account valuations — the ground truth for realized
 * P&L. Every completed live execution records one, and the dashboard's P&L
 * poll records one. P&L is ALWAYS computed as differences between snapshots
 * (actual exchange balances), never from scanner estimates.
 */
export const accountSnapshotsTable = pgTable("account_snapshots", {
  id: serial("id").primaryKey(),
  /** SHA-256 prefix of the Kraken API key — scopes snapshots per account so
   * baselines and P&L never mix across different credentials. */
  accountId: text("account_id").notNull().default("legacy"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Total account value in USD (cash + priced holdings) */
  totalUsd: numeric("total_usd", { precision: 18, scale: 6 }).notNull(),
  /** USD + stablecoin cash balance */
  usdBalance: numeric("usd_balance", { precision: 18, scale: 6 }).notNull(),
  /** USD value of non-cash holdings at live ticker prices */
  holdingsUsd: numeric("holdings_usd", { precision: 18, scale: 6 }).notNull(),
  /** What produced this snapshot: "poll" | "post_trade" */
  trigger: text("trigger").notNull(),
  /** True when some assets couldn't be priced (totalUsd under-counts) */
  hasUnpriced: boolean("has_unpriced").notNull().default(false),
}, (t) => [index("account_snapshots_account_created_idx").on(t.accountId, t.createdAt)]);

export type AccountSnapshotRow = typeof accountSnapshotsTable.$inferSelect;
