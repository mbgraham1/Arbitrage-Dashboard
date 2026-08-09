---
name: Iteration-bounded polling under fake-Date tests
description: API-server tests fake only Date; wall-clock deadlines in poll loops never expire and hang tests
---

Rule: in the API server's exchange poll/confirm loops, bound retries by ITERATION COUNT, never by a `Date.now()` deadline alone.

**Why:** the force-lock/executor test suites use `vi.useFakeTimers({ toFake: ["Date"] })` — real setTimeout keeps loops alive but `Date.now()` never advances, so a `while (Date.now() < deadline)` loop spins forever and the test times out. A wall-clock-bounded confirmation added to an unwind path hung all three lock-eviction tests until it was rewritten as N polls × short sleep. Bounded iteration also keeps KILL/HARD RESET recovery fast (a slow status API can't hold recovery hostage).

**How to apply:** any new confirm/poll added to order placement, cancel-confirm, or unwind paths → `for (let i = 0; i < N; i++)` with short sleeps; record accepted-but-unconfirmed evidence (txid, zero volume, "unconfirmed" label) instead of waiting longer.
