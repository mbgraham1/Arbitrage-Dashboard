---
name: Maker floor safeguard
description: Why maker-mode triangle attempts are gated by a raised profit floor
---
Rule: maker-mode Kraken triangle attempts must clear `makerFloorUsd = max(minProfitUsd, $0.25, 2.5%·size)` — a single helper in the arb routes used by the safeguarded executor, the adaptive maker branch, the legacy post-only triangular path, and exec-preview (preview must always mirror live gates).

**Why:** 2026-08-08 ledger audit: 9/9 verified live maker fills lost money (avg expected +$0.04 → realized −$0.19; completion/unwind cost ≈ $0.23 on $10; leg-1 fill rate ~3%). Thin maker edges are proven realized losers.

**How to apply:** any new maker execution entry point must reuse the shared floor helper; never gate maker paths on the generic minProfitUsd alone. Taker paths keep their own floor + scaled safety buffer. If the fee tier or unwind-cost data changes materially, re-derive the constants from trades/execution_quality tables, not assumptions.
