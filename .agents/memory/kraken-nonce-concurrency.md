---
name: Kraken nonce concurrency
description: Kraken nonces are per API key account-wide; multi-process key sharing causes EAPI:Invalid nonce and shared rate budget.
---

- Kraken private-API nonces are per API KEY and account-wide. Any in-process limiter only keeps nonces monotonic within ONE process; a deployed app + dev workspace sharing a key interleave nonces (`EAPI:Invalid nonce`) and share one rate budget (`EAPI:Rate limit exceeded`).
- **Why:** cannot be fixed in code across processes — only mitigated (per-key strictly-increasing BigInt nonces, one safe retry) and detected (repeated nonce errors within a window ⇒ concurrent use suspected, surfaced in the dashboard).
- **How to apply:** nonce failures are rejected BEFORE Kraken processes the request (no order placed), so a single retry is safe even for AddOrder. Recommend one key per environment; a Kraken nonce window (~5000 ms) reduces but does not eliminate collisions.
