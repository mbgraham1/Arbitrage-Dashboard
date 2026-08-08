---
name: WS book streaming & latency layer
description: Design rules for the Kraken/Coinbase streaming book layer, quote-freshness semantics, and stale→skip execution policy
---

# Streaming book layer & latency rules

- **Kraken WS v2 symbols ≠ AssetPairs wsname.** v2 uses standardized symbols (`BTC/USD`, `DOGE/USD`); AssetPairs `wsname` still reports legacy `XBT/USD` / `XDG/USD`. Subscribing with raw wsnames silently fails for all BTC/DOGE pairs (no error, just no books). Always translate XBT→BTC, XDG→DOGE per symbol part.
- **Quote "age" = connection currency, not last book change.** Kraken pushes every change; an unchanged book on a quiet pair is CURRENT as of the connection's last message (~1s heartbeats). Staleness = min(book-update age, last-any-message age). Books must be cleared on disconnect so a present book always belongs to the live connection.
- **Stale → SKIP, never fire blind.** Executor micro-check reads the same timestamped in-memory snapshot the scanner sees (zero network). Quotes older than the trader's threshold (default 250ms) skip the fire. Stream unavailable (WS down/warming) → REST fallback with a loud warning — degraded latency, never degraded safety.
- **Scaled buffer must ride the whole path.** The safety buffer scales with the scanner edge (bigger stale edge → bigger margin, never a bypass). **Why:** a buffer computed at the decision gate but not passed into the executor lets routes between the small default buffer and the scaled one fire live — the executor's own preflight must enforce the exact buffer that authorized the fire.
- **Latency probe hygiene.** Module-scoped submit/ack probe on the first AddOrder is safe only because live executions are serialized by the execution lock; always disarm in `finally` or a leaked probe stamps a later unrelated order.
- Coinbase caveat: only ticker (best bid/ask) is streamed; L2 depth still REST (public level2 WS needs auth). Kraken book checksums not validated — reconnect resyncs via fresh snapshot.
