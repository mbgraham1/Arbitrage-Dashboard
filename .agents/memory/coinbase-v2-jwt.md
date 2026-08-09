---
name: Coinbase v2 API auth with CDP keys
description: The Advanced Trade CDP JWT also authenticates Coinbase App (v2) endpoints — do not add legacy HMAC auth.
---

The same CDP API key + ES256 Bearer JWT used for Advanced Trade (`/api/v3/brokerage/...`) authenticates the Coinbase App v2 API (`/v2/accounts`, `/v2/accounts/{id}/transactions`).

**Why:** A code review rejected this as impossible, claiming v2 requires legacy HMAC signing. Coinbase's official docs (docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication) show `curl -H "Authorization: Bearer $JWT" https://api.coinbase.com/v2/accounts/...` with a CDP key — identical JWT construction (uri claim `METHOD api.coinbase.com/path`, path signed WITHOUT query string).

**How to apply:** Reuse the existing `coinbaseRequest` helper for v2 endpoints (transactions ledger, addresses, etc.). v2 pagination uses `pagination.next_uri` (a ready-to-fetch path incl. query), unlike v3's `cursor`. External-flow tx types: send, fiat_deposit/withdrawal, deposit/withdrawal, exchange_/pro_ moves; `native_amount` gives USD spot at transaction time (prefer over current-price approximations).
