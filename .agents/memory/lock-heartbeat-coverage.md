---
name: Execution-lock heartbeat coverage
description: Every private exchange call must beat the live-lock heartbeat; stale window sized to one HTTP timeout.
---
Rule: any awaited private exchange call (Kraken AND Coinbase — placement, cancel, unwind, fee/status lookups) must beat the execution-lock heartbeat on start, finish, and every ≤5s during rate-limit backoff or paced-queue waits. The heartbeat hook lives in the exchange lib (`setPrivateCallHeartbeat`), wired by the arb router to `touchLiveLock`.

**Why:** Lock staleness eviction is silence-based; a single awaited call under rate-limit backoff used to go quiet ~60s, forcing a 90s stale window. With per-call beats the worst legitimate silence is one HTTP timeout (~10s), so the window is 30s (FORCE mode 15s). Evicting a live holder mid-order lets two executions double-spend the same balance.

**How to apply:** when adding a new exchange venue or a new private-call helper, route it through a beating wrapper (or add beat() around the fetch). Never tighten LIVE_LOCK_STALE_MS below ~3× the longest un-beaten await.

**Cooperative KILL + unwind:** the liveLockOwned checks between legs must UNWIND held inventory before throwing — an abort message claiming "unwound" without an actual market unwind strands inventory. Tests can fake only Date (vi.useFakeTimers({toFake:["Date"]})) to advance heartbeat silence past eviction thresholds while real timers keep executor poll loops alive.
