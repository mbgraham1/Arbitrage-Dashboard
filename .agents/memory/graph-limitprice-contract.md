---
name: Graph edge limitPrice contract
description: Convention for GraphEdge/GraphRouteHop.limitPrice and how maker executors must price resting orders.
---

**Rule:** `limitPrice` on graph edges/hops is ALWAYS the marketable TAKER-side top-of-book — best ASK for a buy, best BID for a sell — identical on every exchange (Kraken, Coinbase, Gemini). Maker executors must never rest a post-only order at `limitPrice`; they derive a fresh join price (opposite side of book) at execution time and may only use `limitPrice` as an approved-price cap.

**Why:** Kraken edges once stamped the opposite side (buy→bid) while Coinbase stamped the taker side (buy→ask). Depending on the consumer, a buy "limit" at the bid never fills, or a marketable-limit intent is inverted — and the Coinbase market-IOC buy sizes its quote spend from `limitPrice`, which requires the ask.

**How to apply:** When adding new venues/edges to the graph engine, stamp buy→ask, sell→bid. When adding executor paths that rest maker orders, fetch a fresh join price (e.g. `freshJoinPrice`) and cap at the hop's `limitPrice`. A regression test in `graph-engine.test.ts` locks the convention down.
