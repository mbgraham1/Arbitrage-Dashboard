---
name: Read-only service token gate
description: How the external-agent read token works and why GET != read-only in this API
---

The API supports a read-only service token (`X-Service-Token` header) for external agents (Hermes). Verified by constant-time SHA-256 compare against a `HERMES_TOKEN_SHA256` env hash (raw token never stored); grants GET-only access to an explicit allowlist; everything else 403s; missing token falls through to Clerk auth.

**Why:** the user hands external agents API access without exposing trading power; widening `PUBLIC_API_PATHS` was rejected as it opens the API to everyone.

**How to apply:**
- GET ≠ read-only in this codebase: some GETs mutate state (triangular scan writes rows, cointegration advances Kalman state, rebalance/status clears the preflight latch) and graph-scan accepts exchange creds as query params. Never allowlist a route without reading its handler for side effects.
- Rotate the token by writing a new SHA-256 hex to the env var; no code change needed.
- Any new "give X access" request: extend the allowlist pattern, never the public paths.

## Hermes execution webhook (2026-08-09)
Rule: external monitors may trigger executions ONLY via POST /api/hermes/spike — a SEPARATE X-Exec-Token (env HERMES_EXEC_TOKEN_SHA256, constant-time, fail-closed), coin-name-only body, keys from server env (user explicitly chose to store exchange keys in Secrets), rate-limited, funneled into run2xExecute (the exact /arb/2x-execute flow: real fee tiers, 200ms freshness, floor+buffer, shared live lock, $10 cap).
**Why:** Hermes twice supplied unauthenticated executor scripts that forwarded keys and fired on claimed spreads; user still chose check+execute. The compromise: alerts are hints, never trusted inputs.
**How to apply:** never let the read token trigger it; never accept spread/size/credentials from the caller; run2xExecute must stay behaviorally identical to the route.
