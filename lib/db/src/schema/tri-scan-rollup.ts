import { pgTable, serial, integer, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Daily aggregate of PRUNED tri_scans rows. When retention deletes old scan
 * rows, their count/sum/best are folded in here first (atomically, in the same
 * SQL statement), so the history summary endpoint can report exact lifetime
 * totals (total scans, avg, best, counterfactual P&L) after pruning.
 */
export const triScanRollupTable = pgTable("tri_scan_rollups", {
  id: serial("id").primaryKey(),
  /** UTC day bucket (date_trunc('day', created_at) of the pruned rows) */
  bucketDay: timestamp("bucket_day").notNull(),
  scanCount: integer("scan_count").notNull(),
  sumProfitPct: numeric("sum_profit_pct", { precision: 18, scale: 6 }).notNull(),
  bestProfitPct: numeric("best_profit_pct", { precision: 12, scale: 6 }).notNull(),
}, (t) => [uniqueIndex("tri_scan_rollups_bucket_day_idx").on(t.bucketDay)]);

export type TriScanRollup = typeof triScanRollupTable.$inferSelect;
