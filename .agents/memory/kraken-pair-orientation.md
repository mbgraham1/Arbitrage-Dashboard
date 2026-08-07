---
name: Kraken cross-pair orientation in OB Hunter ports
description: The Python bot versions have an orientation bug in cross-pair legs; the TS port fixed it — do not regress when porting future versions.
---

The user uploads successive Python "BUTTER PROTOCOL" versions to port. Their `simulate_triangular_cycle` always walks BIDS on the cross pair, treating asset A as the base — but Kraken cross symbols are oriented (e.g. ETHXBT = ETH base / BTC quote), so half of the 30 A→B directions are mathematically wrong in the Python.

**Why:** In every cross-pair mapping used (ETHXBT, SOLXBT, SOLETH, LINKSOL, …), the SECOND asset of the (A, B) tuple is the Kraken BASE and the first is the QUOTE. Going A→B with A as quote means BUYING the base → walk ASKS (price = A per B); A as base means SELLING → walk BIDS.

**How to apply:** When porting any future Python version's order-book/triangular logic, keep the corrected orientation-aware cross-leg math (CROSS_LOOKUP with `aIsQuote`) rather than transliterating the Python's bid-only walk. Also keep: full-fill rejection (partial fills return null) and surfacing failed order-book fetches (pairsScanned/pairsRequested) instead of silently reporting "no opportunity". Kraken lacks many exotic crosses (LINKSOL etc.), so ~12/21 pairs fetching is normal, not an error.
