---
name: Multi-venue discovery scan
description: Read-only public-exchange scanning constraints — geo-blocks, USDT basis, assumed fees
---
- From this server, Bybit and Binance.com public APIs are geo-blocked; Binance.US, OKX, KuCoin, Gemini, Bitstamp, Crypto.com, MEXC, Gate.io work without creds.
- OKX/KuCoin/MEXC/Gate.io quote in USDT, not USD — cross-quote nets must carry a basis haircut (~0.10%/leg) or they overstate the edge.
- Venue fees without connected keys are entry-tier ASSUMPTIONS and must be labeled as such in UI/API; only detected Kraken/Coinbase tiers may mark a route executable.
**Why:** the profit gate depends on exact fees; assumed tiers + USDT basis were the two easiest ways to show a phantom positive net.
**How to apply:** any new venue added to discovery gets: reachability check from this server, quote-currency flag, labeled assumed fee, depth-walked books, null-on-exhausted-depth.
