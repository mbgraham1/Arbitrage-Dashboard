---
name: Coinbase level2 book maintenance
description: Rules for maintaining Coinbase level2_batch depth books safely for cross-exchange pricing
---

**Rule:** Never keep a truncated top-N copy of a Coinbase level2 book. l2update deltas reference ANY price level; if discarded depth can't backfill a removed top level, the book silently corrupts and can overstate an edge. Retain the FULL price→qty maps and project sorted top-N on read.

**Why:** Code review caught this as an execution blocker when cross-exchange pricing first went live off stream books; a "fresh" (age-gated) but structurally incomplete book passes freshness gates while being wrong.

**How to apply:** Any venue whose depth feed sends full-book deltas (Coinbase level2/level2_batch style) needs full-state retention + projection. Also: subscribe level2 per product individually — one invalid product id in a batched subscribe rejects the whole request, and the tracked asset list includes Kraken-only assets. Clear books on disconnect; l2update `time` field is the exchange event timestamp for per-leg age.

Cross-route pre-fire (graph-execute) mirrors triangles: stream-only reprice on both venues, oldest-leg age vs maxQuoteAgeMs with wait-a-tick, same-snapshot consistency gate, safety buffer + floor, then a both-venue balance check — all before any order.
