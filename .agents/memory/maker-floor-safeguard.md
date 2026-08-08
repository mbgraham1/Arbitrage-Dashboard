---
name: Maker floor safeguard
description: Why maker-mode triangle attempts are gated by a raised profit floor
---
Rule: maker-mode Kraken triangle attempts must clear `makerFloorUsd = max(minProfitUsd, $0.25, 2.5%·size)` — a single helper in the arb routes used by the safeguarded executor, the adaptive maker branch, the legacy post-only triangular path, and exec-preview (preview must always mirror live gates).

**Why:** 2026-08-08 ledger audit: 9/9 verified live maker fills lost money (avg expected +$0.04 → realized −$0.19; completion/unwind cost ≈ $0.23 on $10; leg-1 fill rate ~3%). Thin maker edges are proven realized losers.

**How to apply:** any new maker execution entry point must reuse the shared floor helper; never gate maker paths on the generic minProfitUsd alone. Taker paths keep their own floor + scaled safety buffer. If the fee tier or unwind-cost data changes materially, re-derive the constants from trades/execution_quality tables, not assumptions.

**Update 2026-08-08:** By explicit user decision, the fixed max($0.25, 2.5%·size) floor was replaced in the maker-hedge engine by a configurable floor, `max(0.01, requested)` — never ≤ 0. The additive safety buffer (max($0.02, 0.2%·size)) is unchanged. Caveat given to the user: a $0.01 floor fires far more often but per-cycle edge is tiny and thin fills previously lost ~$0.19 each; realized P&L is the scoreboard. Scan/AUTO verdicts must mirror this exact gate (floor + buffer + freshness + inventory).
