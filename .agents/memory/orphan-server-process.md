---
name: Orphan server process serving stale code
description: EADDRINUSE after a workflow restart means an old node child may still be serving the port with pre-fix code
---
Rule: if a workflow restart fails with EADDRINUSE (or behavior looks pre-fix after a deploy), an ORPHANED old node child may still be bound to the port serving stale code — `fuser -k <port>/tcp` (or ps aux | grep dist/index.mjs) then restart.
**Why:** 2026-08-08 — an orphaned pre-fix api-server kept serving port 8080 after restarts; it submitted a below-minimum BONK rebalance order and displayed impossible $30+ profits, making an already-fixed bug look un-fixed.
**How to apply:** after every restart that matters for money-safety, verify exactly one server process exists and smoke an endpoint whose behavior changed with the fix.
