---
name: Kraken cross-pair orientation in OB Hunter ports
description: The Python bot versions have an orientation bug in cross-pair legs; the TS port fixed it — do not regress when porting future versions.
---

The user uploads successive Python "BUTTER PROTOCOL" versions to port. Their `simulate_triangular_cycle` always walks BIDS on the cross pair, treating asset A as the base — but Kraken cross symbols are oriented (e.g. ETHXBT = ETH base / BTC quote), so half of the 30 A→B directions are mathematically wrong in the Python.

**Why:** In every cross-pair mapping used (ETHXBT, SOLXBT, SOLETH, LINKSOL, …), the SECOND asset of the (A, B) tuple is the Kraken BASE and the first is the QUOTE. Going A→B with A as quote means BUYING the base → walk ASKS (price = A per B); A as base means SELLING → walk BIDS.

**How to apply:** When porting any future Python version's order-book/triangular logic, keep the corrected orientation-aware cross-leg math (CROSS_LOOKUP with `aIsQuote`) rather than transliterating the Python's bid-only walk. Also keep: full-fill rejection (partial fills return null) and surfacing failed order-book fetches (pairsScanned/pairsRequested) instead of silently reporting "no opportunity". Kraken lacks many exotic crosses (LINKSOL etc.), so ~12/21 pairs fetching is normal, not an error.

## Ticker response keys are INTERNAL names
Kraken's /0/public/Ticker keys its result by internal pair names even when you
request altnames: ETHUSD→XETHZUSD, XRPUSD→XXRPZUSD, LTCUSD→XLTCZUSD,
XBTUSD→XXBTZUSD; DOGE is XDGUSD (no Z form). Match by explicit mapping, never
suffix heuristics. Also: Ticker field "p" is VWAP, NOT 24h change — the Python
bots misuse it; compute change as (c[0]−o)/o. Verify pair existence via
/0/public/AssetPairs (gives authoritative base/quote) instead of guessing
symbol names like the Python versions do.

## Listing changes seen live (2026-08)
- MKR has NO Kraken pairs anymore (Maker→SKY migration) — excluded from OB_ASSETS.
- RNDR renamed: USD pair altname is RENDERUSD (asset symbol kept as RNDR in our code).
- New-gen listings (PEPE, WIF, BONK, INJ, SEI, APT, LDO, FET, TAO, GALA, BEAM, JUP) have USD pairs only — no BTC/ETH crosses, so they cannot form triangular routes; they only widen ticker/volatility coverage.

## Pair precision (price/volume decimals)
- Kraken rejects orders exceeding pair_decimals ("EOrder:Invalid price: ETH/USD up to 2 decimals" — ETH/USD 2, BTC/USD 1). Normalize price AND volume inside the shared AddOrder wrappers (covers reprices, retries, fallbacks, unwinds) via cached AssetPairs metadata; never hardcode decimals or use toFixed(8).
- Refuse to submit when metadata is missing rather than guess; enforce ordermin at submission AND pre-check every planned leg's volume ≥ ordermin BEFORE leg 1 — a rejection on leg 2/3 strands inventory, and a residual below ordermin can't be unwound at all (surface as unresolved exposure, never claim recovery).
