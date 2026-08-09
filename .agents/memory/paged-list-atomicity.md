---
name: Paged list atomicity
description: items+total envelopes must come from one SQL statement, not two parallel queries
---
Rule: when an endpoint returns `{ items, total }` for pagination, fetch both in ONE SQL statement (CTE page + scalar COUNT subquery, json_agg with COALESCE '[]' so an empty out-of-range page still reports total). Two statements via Promise.all get separate READ COMMITTED snapshots and the count can drift from the page.

**Why:** completion review rejected a Promise.all(select, count) implementation as non-atomic; the single-statement version passed. Pattern lives in the trades ledger page helper with a real-db test.

**How to apply:** any new/updated paged endpoint claiming an atomic total (e.g. the triangular history endpoint still uses the two-statement Promise.all pattern — fix if its atomicity ever matters).
