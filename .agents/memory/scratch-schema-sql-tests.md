---
name: Scratch-schema harness for global retention SQL
description: How to safely integration-test unqualified DELETE/retention SQL without touching real rows
---

Retention/prune SQL that references tables unqualified (e.g. `DELETE FROM account_snapshots ...`) must NOT be run as-is in tests against the shared dev database — it deletes eligible rows for EVERY account, and a before/after count only detects damage after the fact (a completion review rejected exactly this).

**How to apply:** export the exact SQL strings from the production module; in the test, create a throwaway schema with a mirror table, grab dedicated pool clients, `SET search_path TO <scratch>` (+ `SET timezone TO 'UTC'` so `date_trunc` buckets are deterministic), run the identical statements there, and `release(true)` the clients so the altered search_path never returns to the pool. This also enables real concurrency tests: race several clients over freshly seeded deletable rows BEFORE any serial run — racing after a first prune proves nothing.

Also: seed bucket rows on hour/day-aligned timestamps, or offsets can straddle a `date_trunc` boundary and flake. Make throttled wrappers take an injectable runner so throttle tests need no DB.
