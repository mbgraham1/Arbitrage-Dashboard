---
name: Exchange id casing mismatch
description: Server maps keyed by lowercase exchange ids vs display-cased labels on opportunities — normalize before indexing
---
The triangular scan's per-exchange maps (e.g. priceSource) use lowercase ids ("kraken", "coinbase"), while opportunity objects carry display-cased labels ("Kraken", "Coinbase").

**Why:** A live-trade safety gate indexed `priceSource[opp.exchange]`, got undefined, and silently failed open — caught only in code review.

**How to apply:** Whenever indexing a per-exchange map with an opportunity/route's exchange field, lowercase the key (or use a canonical id). Prefer extracting such gates into pure helpers with unit tests covering the cased-label case.
