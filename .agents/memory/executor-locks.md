---
name: Executor lock coverage
description: All trade execution paths (auto AND forced/manual) must hold the shared executor locks
---

The dashboard's three auto-executors (cross-exchange, triangular, OB Hunter) gate on shared lock refs. Forced/manual paths originally checked or skipped the locks without *acquiring* them, so an auto-executor could fire mid-forced-trade.

**Why:** A completion review caught that `forceTrade`/`forceTriangular` never set the lock refs the OB gate reads — a real double-fire risk with live orders.

**How to apply:** Any new execution path (manual button, new strategy, retry loop) must acquire the shared lock with guaranteed `finally` release — use `withExecutionLock` in cat-arb's store. When testing mutual exclusion, test the real lock object across paths, not supplied booleans.
