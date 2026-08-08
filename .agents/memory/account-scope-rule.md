---
name: Per-account history scope rules
description: Rules for scoping trading history (fill rates, gates, snapshots) to an account
---

Two durable rules for anything keyed by per-account trading history:

1. A Coinbase key participates in the account scope ONLY when its secret is also held.
   **Why:** A lone key can't trade or be valued; when derivation sites disagreed, a trader was gated under one scope while fills were recorded under another — their own history became invisible to their own gate.

2. Pre-scoping "legacy" (unattributed) history must never influence any scoped account's ranking, penalties, risk, or gates — use the neutral prior until the account builds its own history.
   **Why:** Unknown-owner fills are potentially another trader's; "continuity" via shared legacy rows re-introduces exactly the cross-account leakage the scoping exists to prevent.

**How to apply:** Derive the scope through the one shared helper on each side (server and client mirror each other); filter history strictly by the derived accountId. Regression/parity tests live next to the route and helper code — extend them for any new scoped feature.
