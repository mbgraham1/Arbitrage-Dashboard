import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const triScanTable = pgTable("tri_scans", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  exchange: text("exchange").notNull(),
  loop: text("loop").notNull(),
  profitPct: numeric("profit_pct", { precision: 12, scale: 6 }).notNull(),
  solUsd: numeric("sol_usd", { precision: 18, scale: 6 }).notNull(),
  /** ethUsd holds BTC/USD mid for the "btc" variant */
  ethUsd: numeric("eth_usd", { precision: 18, scale: 6 }).notNull(),
  /** ethSol holds SOL/BTC mid for the "btc" variant */
  ethSol: numeric("eth_sol", { precision: 18, scale: 8 }).notNull(),
  /** null → ETH/SOL loop; "btc" → BTC/SOL loop */
  variant: text("variant"),
  /** ISO timestamp captured at scan time (from TriOpp.timestamp) */
  scannedAt: text("scanned_at").notNull(),
});

export const insertTriScanSchema = createInsertSchema(triScanTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTriScan = z.infer<typeof insertTriScanSchema>;
export type TriScan = typeof triScanTable.$inferSelect;
