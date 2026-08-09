import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export interface TradePageItem {
  id: number;
  createdAt: string;
  pair: string;
  buyExchange: string;
  sellExchange: string;
  volume: number;
  estimatedProfitUsd: number;
  netEdgePct: number;
  isDryRun: boolean;
  krakenPrice: number;
  coinbasePrice: number;
  buyOrderId: string | null;
  sellOrderId: string | null;
  status: string | null;
  realizedProfitUsd: number | null;
  legFills: unknown;
}

export interface TradePage {
  items: TradePageItem[];
  total: number;
}

/**
 * Fetch one page of the trade ledger AND the total row count in a SINGLE SQL
 * statement. PostgreSQL executes a statement against one snapshot, so a trade
 * committed while the request is in flight can never produce rows from one
 * ledger state and a total from another — total is always consistent with the
 * page, including an empty out-of-range page (the scalar COUNT subquery does
 * not depend on the page CTE producing rows).
 */
export async function listTradesPage(limit: number, offset: number): Promise<TradePage> {
  const result = await db.execute(sql`
    WITH page AS (
      SELECT * FROM trades
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    )
    SELECT
      (SELECT count(*)::int FROM trades) AS total,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id',                 p.id,
          'createdAt',          to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'pair',               COALESCE(p.pair, 'SOL/USD'),
          'buyExchange',        p.buy_exchange,
          'sellExchange',       p.sell_exchange,
          'volume',             p.volume::float8,
          'estimatedProfitUsd', p.estimated_profit_usd::float8,
          'netEdgePct',         p.net_edge_pct::float8,
          'isDryRun',           p.is_dry_run,
          'krakenPrice',        p.kraken_price::float8,
          'coinbasePrice',      p.coinbase_price::float8,
          'buyOrderId',         p.buy_order_id,
          'sellOrderId',        p.sell_order_id,
          'status',             p.status,
          'realizedProfitUsd',  p.realized_profit_usd::float8,
          'legFills',           p.leg_fills
        ) ORDER BY p.created_at DESC, p.id DESC)
        FROM page p
      ), '[]'::json) AS items
  `);
  const row = (result.rows?.[0] ?? {}) as { total?: number; items?: TradePageItem[] | string };
  const items = typeof row.items === "string" ? (JSON.parse(row.items) as TradePageItem[]) : (row.items ?? []);
  return { items, total: Number(row.total ?? 0) };
}
