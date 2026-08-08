---
name: Pre-fire freshness & consistency rules
description: Unified live-execution gates — 200ms per-leg freshness, consecutive re-projection consistency check, decision logging, buffer-inclusive display nets.
---

- Hard rule (explicit user decision, 2026-08-08): if ANY required leg's exchange-update age exceeds **200 ms**, the whole route is stale — do not execute. Applies to every live path (maker-hedge, 2x, generic inventory) and must also be re-checked AFTER the consistency re-projection, or a route can age past the limit mid-decision.
- Consistency gate: immediately re-project the chosen route with the identical function on the live books; if nets diverge > ~$0.005, block and log "PRICING CONSISTENCY ERROR". **Do not call this a "shared snapshot"** — stream books are mutable; it is two consecutive reads (reviewer flagged the overstated wording twice).
- Decision log before every fire decision: per-leg ages, route age (oldest leg), scanner net, executable net, floor, buffer.
- Display-net convention: buffer-inclusive everywhere (discovery, inventory scan, 2x `netAfterBufferUsd`). Keyless Coinbase taker assumption = conservative 1.20%, never 0.60%.
- Per-credential caches (fees, balances) must key on a SHA-256 of the FULL key strings — truncated prefixes can serve one account another account's fee tier (reviewer-caught live-money bug).
- `detectFees` lives in `lib/fees.ts` specifically to avoid a routes-level import cycle (cb-maker-hedge → arb lock fns is the pre-existing one-way edge; never import from cb-maker-hedge into arb).
- Profit Hunter persists every tick and auto-resumes an open 24h window after restart WITHOUT creds (creds never persist), labeling fees as assumed.

**Why:** real money at $10 sizes; user demanded strictly truthful displayed profit and stricter execution even if the bot fires less.
**How to apply:** any new scanner/executor must reuse these gates and the buffer-inclusive display convention; never add an optimistic fee default or top-of-book preview.

## Canonical route-sanity guard (2026-08-08)
`lib/route-sanity.ts` routeSanityError(startUsd, net, gross?) — blocks nets above ROUTE_SANITY_MAX_NET_PCT (default 5% of size) or net>gross as "PRICING CONSISTENCY ERROR". Wired at: graph-scan display, xv-scan blocker chain, xv execute re-projection, triangle preflight, cross pre-fire. Force/big-edge bypasses skip history gates only — never this. Test fixtures must use sub-cap profits.
