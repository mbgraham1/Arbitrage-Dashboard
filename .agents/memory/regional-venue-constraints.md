---
name: Regional venue constraints (Puerto Rico)
description: Which exchanges are actionable for this user and how region-blocked venues must be presented
---

The user trades from Puerto Rico. Their app reports **Binance.US is unavailable in their region** — treat it as non-actionable market context only, clearly labeled, never in requires_setup/candidate/executable lists and never counted toward "needs account" upside.

**Why:** user stated it directly ("binance isn't in my region", 2026-08-08); presenting a region-blocked venue as an actionable opportunity would be dishonest and waste their setup effort.

**How to apply:** venue metadata carries `regionOk`/`candidate` flags (lib/venues layer). PR-accessible candidate venues the user cares about: **Gemini** (stablecoin fee schedule dramatically below spot — ~0.03% taker, assumed until verified) and **Crypto.com** (entry tier 0.25% maker / 0.50% taker assumed). Candidates stay public-data-only until account + API access is connected and verified — nothing new auto-trades. Offshore USDT venues (KuCoin/MEXC/Gate.io/OKX) carry "verify PR eligibility" notes and must not be presented as straightforward account options.
