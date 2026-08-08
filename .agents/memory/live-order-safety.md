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

## Bounded taker fallbacks
When a maker leg times out and falls back to a taker fill: a plain market BUY has no maximum quote spend, so on cross pairs it can silently draw pre-existing account inventory when the price moves past the sizing estimate. Use an IOC limit with an explicit worst-case price cap (spend hard-bounded at volume × cap) sized from the inventory THIS RUN holds. Also pass Kraken oflags "fciq" (fee in quote) on all orders so cost±fee accounting is exact regardless of account fee preference. Preserve maker+fallback txids (comma-join) for reconciliation.

## Single-flight lock eviction
Never time-clear a live execution lock on age alone. Use generation tokens (release is a no-op unless gen matches) plus a heartbeat refreshed by every status update AND every poll-loop iteration in EVERY live executor; staleness = long heartbeat silence (set above the worst legitimate stall, e.g. Kraken rate-limit backoff ~60s), not long runtime. A stale eviction must bump the generation so the dead holder's finally can't release the new holder's lock.

## History gates need a fresh re-quote to bypass
Any 'current edge beats history' bypass of fill-rate gates/blacklists must be limited to execution paths that re-validate the edge with a fresh order-book preflight immediately before placing orders — otherwise a stale scanner edge can authorize a historically-failing route.

## Lock heartbeat + kill switch (Aug 2026)
- Rate-limit backoff sleeps must beat the lock heartbeat (hook in the private-API limiter). Without it, any "evict silent lock" threshold shorter than the max backoff (~60s) risks double-spend.
- Manual lock-clear/kill endpoints on an unauthenticated server must require exchange credentials (verified via a private call) — clearing a concurrency lock is a money-safety control.
- KILL = CancelAll BEFORE releasing the lock (a resting maker leg could fill after release), plus cooperative generation checks in executors before each new leg so an evicted run stops committing capital and unwinds.

## Lock adoption + revoked-run order ban
- A single-flight execution lock checked both by an outer route handler AND inside the executor it calls will SELF-BLOCK (executor sees its caller's lock). Pass the held generation token down (`heldLockGen`); only the acquirer releases.
- A run whose lock was revoked (KILL/eviction) may cancel its own resting order and unwind ACTUAL confirmed fills, but must NEVER place new orders (taker fallbacks, retries). Enforce with a typed LockRevokedError carrying the confirmed fill so catch blocks can unwind without guessing volumes; re-check ownership immediately before every fallback order.
- Leg 1 (no inventory at risk) can rest a post-only order long (30s) IF paired with a periodic fresh-edge re-check that cancels early — time patience, edge discipline. Inventory-holding legs keep short windows.
