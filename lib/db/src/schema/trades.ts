import { pgTable, serial, text, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  buyExchange: text("buy_exchange").notNull(),
  sellExchange: text("sell_exchange").notNull(),
  volumeSol: numeric("volume_sol", { precision: 18, scale: 8 }).notNull(),
  estimatedProfitUsd: numeric("estimated_profit_usd", { precision: 18, scale: 6 }).notNull(),
  netEdgePct: numeric("net_edge_pct", { precision: 10, scale: 4 }).notNull(),
  isDryRun: boolean("is_dry_run").notNull().default(true),
  krakenPrice: numeric("kraken_price", { precision: 18, scale: 6 }).notNull(),
  coinbasePrice: numeric("coinbase_price", { precision: 18, scale: 6 }).notNull(),
  buyOrderId: text("buy_order_id"),
  sellOrderId: text("sell_order_id"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
