import { pgTable, serial, text, numeric, boolean, timestamp, index, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * One row per execution ATTEMPT of a graph route (live or dry).
 * The feedback loop aggregates these per route+style to learn:
 *  - fill rate (did the orders actually complete?)
 *  - realized shortfall (expected − realized profit) for slippage learning.
 */
export const executionQualityTable = pgTable("execution_quality", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /** Per-account scope (sha256 prefix of the Kraken API key); "legacy" for pre-scoping rows */
  accountId: text("account_id").notNull().default("legacy"),
  route: text("route").notNull(),                 // route description, e.g. "USD[K]→BTC[K]→USD[CB]"
  style: text("style").notNull(),                 // "taker" | "maker"
  isDryRun: boolean("is_dry_run").notNull().default(true),
  filled: boolean("filled").notNull(),            // all legs confirmed filled
  tradeSizeUsd: numeric("trade_size_usd", { precision: 18, scale: 2 }).notNull(),
  expectedProfitUsd: numeric("expected_profit_usd", { precision: 18, scale: 6 }).notNull(),
  /** Realized USD profit from ACTUAL fills (cost/fee accounting); null when unknown (dry runs, failures before fills) */
  realizedProfitUsd: numeric("realized_profit_usd", { precision: 18, scale: 6 }),
  /** Depth-walked slippage % of the route at attempt time (0 for maker joins) */
  slippagePct: numeric("slippage_pct", { precision: 10, scale: 4 }),
  /** How many legs of the cycle CONFIRMED filled (0–3 for triangles); null when
   * unknown (dry runs, cross-inventory routes, rows recorded before tracking).
   * Diagnoses WHERE routes die: leg-1 never fills vs leg-2/3 killing the cycle. */
  legsFilled: integer("legs_filled"),
  note: text("note"),
}, (t) => [
  index("execution_quality_account_created_idx").on(t.accountId, t.createdAt),
]);

export const insertExecutionQualitySchema = createInsertSchema(executionQualityTable).omit({ id: true, createdAt: true });
export type InsertExecutionQuality = z.infer<typeof insertExecutionQualitySchema>;
export type ExecutionQuality = typeof executionQualityTable.$inferSelect;
