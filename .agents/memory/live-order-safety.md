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
- Auto-execution needs BOTH a synchronous client in-flight ref (React state lags a render) and a server-side global lease for live orders — otherwise a manual click racing an auto-fire double-spends.
- Feedback-loop penalties must be size-normalized (shortfall as % of trade size, scaled to the current size); pooling absolute USD shortfalls across sizes mis-gates.
- Balance-based P&L endpoints must scope snapshots per account (hash of API key) — a global snapshot table mixes baselines across credentials and leaks account values.
- "Realized P&L" from account-value deltas includes market moves on holdings and deposits/withdrawals; label honestly or subtract cash flows via the exchange Ledgers API.

**Preflight must price the way orders execute.** Post-only (maker) legs fill at their join limit prices — simulating them with a taker depth-walk understates the edge by the spread, and using the taker fee tier instead of maker overstated fees (~2x). Scanner, ranking, and executor preflight must share one fee + price model per execution style, and fee tiers must come from the route's actual pairs, not a hardcoded sample.

## Cancel is not terminal
A Kraken CancelOrder ACK is not proof the order stopped — it can still fill in the race. After cancelling, poll QueryOrders until a TERMINAL status (closed/canceled/expired); if unconfirmable, fail closed (no retry, no unwind on assumed volumes — surface for manual review).

## Single-flight live execution
Only one live multi-leg execution per process: a module-level lock prevents AUTO + manual (or two tabs) from interleaving orders or double-spending the same balance. Any shared execution-status snapshot must be reset only by the lock owner.

## Fill-history queries must be account-scoped
Any ranking/gating built on the execution-quality history must filter by the account scope (sha256-prefix of held keys, "legacy" rows included for continuity). A global aggregate lets one account's fill behavior rank or block another account's routes — review flagged this as a trading-safety issue. The client derives the same non-reversible hash via Web Crypto to pass on GET scans (never raw keys in query strings).
