---
name: Live order execution safety pattern
description: Required invariants for any endpoint that places real exchange orders in this project
---

Rule: every live-order path must (1) validate order ACCEPTANCE (txid/orderId present, success flag), (2) confirm fills by polling to a terminal status, (3) size downstream legs from ACTUAL filled quantity (Kraken `volExec`, Coinbase `filled_size` — a FILLED/closed status alone carries no quantity), (4) unwind only the residual exposure on failure, and (5) persist a failure ledger row + report `executed: true` whenever any order was accepted.

**Why:** Two code-review rounds failed the graph-execute cross-exchange path for exactly these gaps (assumed fill volumes, clean-failure responses after real exposure). Also clamp client-supplied numbers server-side for live mode (size bounds, non-negative profit floor) — a negative `minProfitUsd` would let losing routes through the pre-flight gate.

**How to apply:** Reuse `runKrakenTriangle` / the graph-execute cross-exchange block in `arb.ts` as the reference implementation; `coinbaseOrderDetails()` in exchange.ts returns cumulative base fills.

## Scan-vs-execution economics must match leg-by-leg
- A route approved under maker (post-only join) economics must not be executed with any taker leg — refuse live execution instead of silently mixing styles. (Kraken triangles are all-post-only, so maker style is only allowed live there.)
- Depth-walked VWAP pricing: if the visible book cannot absorb the full trade size, DROP the edge entirely. A partial-depth VWAP applied to the whole size overstates the fillable edge — never fall back to top-of-book.
