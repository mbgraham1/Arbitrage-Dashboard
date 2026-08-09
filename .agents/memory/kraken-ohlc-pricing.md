---
name: Kraken OHLC historical pricing
description: Gotchas when using Kraken /0/public/OHLC to price ledger entries historically
---
Rule: Kraken's OHLC response always includes the CURRENT, still-forming candle — its close is just a live price. Never treat it as a finalized historical close; and any cache of OHLC candles must expire at the UTC day boundary, or the just-finalized day is served with a stale pre-midnight close.
**Why:** Deposit-day valuation was rejected twice in review for (1) treating today's candle as final, (2) a TTL cache serving yesterday's in-progress close after midnight.
**How to apply:** Filter candles to dayStart < current UTC day at LOOKUP time, and invalidate caches when the UTC day of caching differs from now. `since` is exclusive — back off one day to cover the entry's own candle.
