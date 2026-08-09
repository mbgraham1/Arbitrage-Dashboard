/**
 * Pagination atomicity proof for GET /trades: page rows and total row count
 * MUST come from one PostgreSQL snapshot so "Showing X–Y of Z" can never
 * drift when a trade is recorded mid-request.
 *
 * Uses the REAL database (a mocked db would only test the mock):
 *   1. listTradesPage issues exactly ONE SQL statement — statement-level
 *      snapshot isolation is what makes items+total atomic in READ COMMITTED.
 *   2. total matches the true row count and stays consistent across pages.
 *   3. an empty out-of-range page still reports the correct total.
 *   4. numeric/string/date field mapping matches the previous drizzle-based
 *      response shape (camelCase keys, floats, ISO createdAt, pair fallback).
 *
 * Seeded rows use a unique per-run marker and are deleted in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, tradesTable } from "@workspace/db";
import { listTradesPage } from "./trades-page.js";

const MARKER = `test-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("listTradesPage (single-snapshot pagination)", () => {
  let baselineTotal = 0;

  beforeAll(async () => {
    const r = await db.execute(sql`SELECT count(*)::int AS c FROM trades`);
    baselineTotal = Number((r.rows[0] as { c: number }).c);
    // Seed 5 rows with a far-future createdAt so they occupy the first page
    // deterministically regardless of pre-existing ledger content.
    for (let i = 0; i < 5; i++) {
      await db.insert(tradesTable).values({
        createdAt: new Date(Date.UTC(2099, 0, 1, 0, 0, i)),
        pair: i === 0 ? null : "ETH/USD", // row 0 exercises the SOL/USD fallback
        buyExchange: MARKER,
        sellExchange: "kraken",
        volume: "1.23456789",
        estimatedProfitUsd: "0.5",
        netEdgePct: "0.1234",
        isDryRun: true,
        krakenPrice: "100.5",
        coinbasePrice: "100.7",
        status: "simulated",
      });
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM trades WHERE buy_exchange = ${MARKER}`);
  });

  it("issues exactly ONE SQL statement for page + total", async () => {
    const spy = vi.spyOn(db, "execute");
    await listTradesPage(50, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("returns total matching the true row count, atomic with the page", async () => {
    const page = await listTradesPage(3, 0);
    expect(page.total).toBe(baselineTotal + 5);
    expect(page.items).toHaveLength(3);
    // Seeded far-future rows lead, newest first
    expect(page.items[0]!.buyExchange).toBe(MARKER);
  });

  it("reports the correct total on an empty out-of-range page", async () => {
    const page = await listTradesPage(50, baselineTotal + 5 + 1000);
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(baselineTotal + 5);
  });

  it("maps fields exactly like the previous response shape", async () => {
    const page = await listTradesPage(5, 0);
    const seeded = page.items.filter(i => i.buyExchange === MARKER);
    expect(seeded).toHaveLength(5);
    const t = seeded[0]!;
    expect(typeof t.id).toBe("number");
    expect(t.volume).toBeCloseTo(1.23456789, 8);
    expect(t.estimatedProfitUsd).toBeCloseTo(0.5, 6);
    expect(t.netEdgePct).toBeCloseTo(0.1234, 4);
    expect(t.krakenPrice).toBeCloseTo(100.5, 6);
    expect(t.coinbasePrice).toBeCloseTo(100.7, 6);
    expect(t.isDryRun).toBe(true);
    expect(t.realizedProfitUsd).toBeNull();
    // ISO timestamp parseable and round-trips to the seeded instant
    expect(new Date(t.createdAt).toISOString()).toBe(t.createdAt);
    // Legacy null pair falls back to SOL/USD; others pass through
    const pairs = new Set(seeded.map(s => s.pair));
    expect(pairs.has("SOL/USD")).toBe(true);
    expect(pairs.has("ETH/USD")).toBe(true);
    // Newest-first ordering within the seeded block
    const times = seeded.map(s => new Date(s.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
