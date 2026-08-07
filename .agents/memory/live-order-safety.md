---
name: Live order execution safety pattern
description: Required invariants for any endpoint that places real exchange orders in this project
---

Rule: every live-order path must (1) validate order ACCEPTANCE (txid/orderId present, success flag), (2) confirm fills by polling to a terminal status, (3) size downstream legs from ACTUAL filled quantity (Kraken `volExec`, Coinbase `filled_size` — a FILLED/closed status alone carries no quantity), (4) unwind only the residual exposure on failure, and (5) persist a failure ledger row + report `executed: true` whenever any order was accepted.

**Why:** Two code-review rounds failed the graph-execute cross-exchange path for exactly these gaps (assumed fill volumes, clean-failure responses after real exposure). Also clamp client-supplied numbers server-side for live mode (size bounds, non-negative profit floor) — a negative `minProfitUsd` would let losing routes through the pre-flight gate.

**How to apply:** Reuse `runKrakenTriangle` / the graph-execute cross-exchange block in `arb.ts` as the reference implementation; `coinbaseOrderDetails()` in exchange.ts returns cumulative base fills.
