---
name: OB test cache poisoning
description: Module-level discovery caches in order-book tests outlive the per-test fake-clock jump and poison later suites.
---

The order-book test file advances the fake clock only ~5 min between tests to expire the 5s/60s book and ticker caches. The cross-pair discovery cache has a 1h TTL, so any suite that mocks AssetPairs (e.g. with a synthetic pair set) leaves a poisoned lookup for every later suite — scans silently lose real cross pairs and cycles come back undefined.

**Why:** cost hours: new 4-leg suites failed with "cycle undefined" purely because an earlier discovery suite cached an INJ-only lookup.

**How to apply:** any suite that calls scanOrderBookCycles or discoverCrossPairs should `beforeEach(() => _testOnly_clearCrossCache())` (and `_testOnly_clearDynUniverse()` if the dynamic universe is involved), rather than relying on clock advancement.
