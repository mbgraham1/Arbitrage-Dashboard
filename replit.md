# CAT Arbitrage Dashboard (BUTTER_PROTOCOL)

A live SOL/USD crypto arbitrage bot dashboard that monitors price spreads between Kraken and Coinbase, executes trades (dry run or live), and tracks P&L history.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **One Kraken API key per running app instance.** Kraken nonces are per key, account-wide. If the published (deployed) app and the dev workspace both run the bot with the same key, their nonces interleave (`EAPI:Invalid nonce`) and they share one private-API rate budget (`EAPI:Rate limit exceeded` lockouts). Run the bot from ONE environment at a time, or create a separate Kraken API key for each environment (Kraken → Settings → API). Setting a nonce window (~5000 ms) on the key reduces but does not eliminate collisions. The server detects repeated nonce errors and the dashboard shows an amber "Kraken API key used by another app instance" banner when concurrent use is suspected.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
