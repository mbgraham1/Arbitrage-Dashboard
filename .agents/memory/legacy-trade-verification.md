---
name: Legacy trade verification
description: Rules for proving old "estimated" ledger rows against exchange order history
---

Rule: an "estimated" row may only be upgraded to "verified" by proving a genuine two-order USD round trip — both order IDs are Kraken txids, both orders `closed`, sides buy/sell, SAME pair, USD quote, executed volumes matching (≤2%). Everything else stays "estimated".

**Why:** legacy triangular routes (pair like `USD→ETH→XRP→USD`) persist only the first and last leg order IDs — two orders can never prove the middle conversion leg's fee/cash flow, and a leg1-buy/leg3-sell of the same asset can pass naive side/volume checks.

**How to apply:** any backfill/verification path must exclude multi-leg routes outright (pair contains `→`) and require same-pair legs. Kraken QueryOrders errors other than "Unknown order" (e.g. invalid key, rate limit) must propagate, never be treated as "order not found" — otherwise a credential problem silently leaves rows unproven.
