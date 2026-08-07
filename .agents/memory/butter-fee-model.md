---
name: BUTTER fee model bug
description: The Python bot's triangular fee formula understates fees ~100x; fees must apply per-leg on notional, not on profit.
---

The original Python BUTTER PROTOCOL computed triangular-cycle net profit as `gross_profit * (1 - fee%/100)` — deducting fees from the few-cent *profit* instead of from the *traded notional*. Real exchanges charge fee% of each leg's notional (~3 × trade size × fee%), so a "profitable" $0.05 edge on a $50 cycle actually loses ~$0.55 at 0.40%/leg taker fees. This caused real-money losses when live execution was added (confirmed against the user's Kraken activity, Aug 2026).

**Why:** Fee formula bug in every ported Python version (v14–v18); any future port of Python profit math must be checked for this.

**How to apply:** Net profit = gross − fee% × (leg1 + leg2 + leg3 notionals). Kraken base taker tier is 0.40%/leg; the executor queries the account's actual tier via /0/private/TradeVolume and prefers it over assumptions. Be suspicious of any ported formula that multiplies profit by (1 − fee).
