import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// ── Startup migrations ────────────────────────────────────────────────────────
// Idempotent: rename volume_sol → volume when the old column still exists.
pool.connect().then(async (client) => {
  try {
    const res = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'trades' AND column_name = 'volume_sol'
    `);
    if ((res.rowCount ?? 0) > 0) {
      await client.query(`ALTER TABLE trades RENAME COLUMN volume_sol TO volume`);
    }
  } finally {
    client.release();
  }
}).catch(() => { /* DB not yet up; drizzle will handle schema push */ });

export * from "./schema";
