import { pgTable, serial, text, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  pair: text("pair"),                          // e.g. "SOL/USD", "BTC/USD" — null for old rows
  buyExchange: text("buy_exchange").notNull(),
  sellExchange: text("sell_exchange").notNull(),
  volume: numeric("volume", { precision: 18, scale: 8 }).notNull(),
  estimatedProfitUsd: numeric("estimated_profit_usd", { precision: 18, scale: 6 }).notNull(),
  netEdgePct: numeric("net_edge_pct", { precision: 10, scale: 4 }).notNull(),
  isDryRun: boolean("is_dry_run").notNull().default(true),
  krakenPrice: numeric("kraken_price", { precision: 18, scale: 6 }).notNull(),
  coinbasePrice: numeric("coinbase_price", { precision: 18, scale: 6 }).notNull(),
  buyOrderId: text("buy_order_id"),
  sellOrderId: text("sell_order_id"),
  // Ledger classification:
  //   verified  — every required leg has a confirmed exchange fill + order ID;
  //               realizedProfitUsd is real money.
  //   failed    — route attempted live but did not complete (incl. unwinds).
  //   simulated — dry runs / scanner estimates; never counts toward P&L.
  //   estimated — legacy live rows lacking full per-leg fill proof.
  status: text("status"),
  // Realized P&L from ACTUAL fills, fee-inclusive. Only set on verified rows
  // (and as the loss figure on failed rows when it is provably known).
  realizedProfitUsd: numeric("realized_profit_usd", { precision: 18, scale: 6 }),
  // Per-leg confirmed fill data: [{ leg, pair, side, price, volume, costUsd?,
  // fee, txid, unwind? }] — actual exchange numbers, never scanner estimates.
  legFills: jsonb("leg_fills"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
