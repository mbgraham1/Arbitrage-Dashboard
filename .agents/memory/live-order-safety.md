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

**Post-only price ticks:** a post-only limit price must be normalized to the exchange tick in the SAFE direction (floor for buys) and clamped strictly below the ask BEFORE submission — helper-level rounding (e.g. toFixed(2)) can round a sub-cent bid UP into the ask and turn the maker order into a taker/rejection.
**Indeterminate cancels:** releasing an execution lock is not enough after an unconfirmed cancel — persist a gate keyed to the specific order id that blocks all live execution until that order is verified terminal, and make KILL paths cancel on every venue involved, not just the primary exchange.
## Lock adoption + revoked-run order ban
- A single-flight execution lock checked both by an outer route handler AND inside the executor it calls will SELF-BLOCK (executor sees its caller's lock). Pass the held generation token down (`heldLockGen`); only the acquirer releases.
- A run whose lock was revoked (KILL/eviction) may cancel its own resting order and unwind ACTUAL confirmed fills, but must NEVER place new orders (taker fallbacks, retries). Enforce with a typed LockRevokedError carrying the confirmed fill so catch blocks can unwind without guessing volumes; re-check ownership immediately before every fallback order.
- Leg 1 (no inventory at risk) can rest a post-only order long (30s) IF paired with a periodic fresh-edge re-check that cancels early — time patience, edge discipline. Inventory-holding legs keep short windows.

## Maker fill quality
- Joining the best bid puts a small order at the BACK of the queue — it ~never fills. Improve one tick inside the spread (post-only still holds) with a tick-premium guard: only improve when profit still clears the floor at the improved price. Quantize tick-snapped prices to the tick's decimals (float dust gets rejected by Kraken).
- Reprice loop: cancel + re-place at the freshest aggressive price every ~2.5s with a FULL pre-flight each time; bounded by max-reprices + wall-clock deadline; exhaustion falls through to the next-best route client-side (error-prefix contract with the dashboard).

## Verified trade ledger classification
Ledger rows carry status: verified | failed | simulated | estimated. Rules that must hold:
- **verified** requires per-leg confirmed fill evidence (txid + real volume for every leg), real USD in/out — never just bookkeeping flags or order IDs. Only verified rows sum into realized P&L.
- Expected/scanner profit lives only in the estimate column; realized profit comes only from actual fills.
- Any run where an order was ACCEPTED (txid returned) must leave a ledger row even if fills were zero/indeterminate/revoked — track accepted txids in a fn-scoped fail context declared OUTSIDE the try so the catch can write the FAILED row (catch can't see try-scoped vars).
- LockRevoked/Indeterminate errors can carry confirmed partial fills — capture evidence in the leg wrapper's catch before rethrowing.
- Legacy live rows without fill proof are "estimated", excluded from realized P&L; they cannot be retroactively verified without exchange order-history lookup.

## Partial-fill tolerance (trader-tuned)
- Leg completion threshold is trader-tuned (percent, server-clamped 50–100; default 99.9). A tolerance-accepted partial must: proceed sized to the ACTUAL fill, sweep residual inventory back to USD with CONFIRMED fills (proceeds counted in realized P&L), and — if any non-dust residual (>0.5% of held volume) can't be confirmed flat — record the trade as estimated (realized null), never verified.
- **Why:** ignoring a residual leaves inventory on account and the USD delta stops representing the round trip; counting it as verified P&L misstates profit.

## Leg-conditional risk gating
- Full-cycle fill rate hides the costly failure mode: leg 1 fills, leg 2 dies, unwind eats ~1.5% of size. Gate live executions on Laplace-smoothed P(leg1)·P(leg2|leg1)·P(leg3|leg1+2): block when risk-adjusted EV (edge×P(all) − P(strand-after-leg1)×unwind cost) ≤ 0, and hard-block routes with <50% leg2|leg1 completion (≥5 conditional samples). Recovery attempts after decay must run as tight-timeout PROBES, never full-window trades, or each decay window buys one full-capital loss.
- **Why:** confirmed realized losses (−$0.16/−$0.18 on $10) from leg-2 strandings that the aggregate fill-rate gate let through.

## Taker-only / adaptive execution mode
- Every NEW cycle-advancing market/IOC order must re-verify the live lock immediately before placement (put the check inside the shared market-fill helper). Residual sweeps back to USD are exempt — they equal the money-safe unwind action.
- Market BUYS have no spend ceiling; always convert to an IOC limit capped ~0.2% above the fresh ask and re-size volume so worst-case spend ≈ trade size incl. fees.
- When a mode decision (adaptive) resolves scan style ≠ execution style, all downstream profit/history gates must be fed the RESOLVED style's fresh numbers — a maker-priced net overstates a taker fire's edge (fees ~3× maker).
- Any pre-fire preview shown to the trader must apply the same floor and decision logic as the live path, or it will advertise fires that the server would refuse.

## Adaptive is profitability-first (trader-mandated, Aug 2026)
Trader's rule ordering: fresh taker breakdown (real fees/leg, depth-walked slip, buffer) BEFORE any maker order; taker net ≥ floor → taker immediately; else maker expected realized (net × fill prob − unwind cost) ≥ floor → maker; else skip. Unavailable fresh books = SKIP, never a maker authorization. The adaptive decision is terminal — don't let generic downstream floor gates re-reject it (double-counts the buffer). Stale scanner edge never overrides the fresh pre-flight.

## Submit ambiguity classification (added 2026-08-08)
Only EXPLICIT API-level rejections (Kraken `EOrder:`/`EAPI:Invalid`/etc., Coinbase `success:false`) may be reported as "nothing traded". Any other post-submit failure (timeout, network, parse) means the order MAY exist: latch live runs off (sticky reconcile flag), write an auditable indeterminate ledger row, and require manual verification before trading again.
**Why:** a lost response after acceptance otherwise lets the trader safely-looking rerun and double-buy.
