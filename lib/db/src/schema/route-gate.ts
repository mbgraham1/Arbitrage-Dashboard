import { pgTable, serial, text, integer, bigint, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Persistent per-route gate state (consecutive-failure blacklist + probe
 * cool-down), keyed by account+style+route. Backing store for the in-process
 * feedback-loop gates so a server restart (or a second process) doesn't reset
 * failure streaks or hand a bad route fresh probe attempts.
 */
export const routeGateStateTable = pgTable("route_gate_state", {
  id: serial("id").primaryKey(),
  /** Per-account scope (sha256 prefix of the Kraken API key); "legacy" when unknown */
  accountId: text("account_id").notNull(),
  style: text("style").notNull(),                 // "taker" | "maker"
  route: text("route").notNull(),                 // route description
  /** Consecutive failed LIVE cycles; a single success resets it */
  failStreak: integer("fail_streak").notNull().default(0),
  /** Unix ms until which the route is blacklisted; 0 when not banned */
  blacklistedUntilMs: bigint("blacklisted_until_ms", { mode: "number" }).notNull().default(0),
  /** Unix ms of the last probe attempt granted for this route; 0 when never */
  lastProbeAtMs: bigint("last_probe_at_ms", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("route_gate_state_key_idx").on(t.accountId, t.style, t.route),
]);

export const insertRouteGateStateSchema = createInsertSchema(routeGateStateTable).omit({ id: true, updatedAt: true });
export type InsertRouteGateState = z.infer<typeof insertRouteGateStateSchema>;
export type RouteGateState = typeof routeGateStateTable.$inferSelect;
