---
name: Maker-post/taker-hedge cross-exchange rules
description: Money-safety rules for the Kraken maker → Coinbase hedge strategy (cross-mm)
---

Rules for the maker-post + taker-hedge strategy:
- **Never hedge before a confirmed maker fill**; hedge size = actual volExec, never planned qty.
- **Partial hedge is NOT realized P&L.** If the hedge fills less than the maker fill, record the cycle as `unhedged` with the exact residual — never `verified`/`hedged` with a fee-mismatched P&L number. Review caught this mislabeling; it corrupts the scoreboard and hides open exposure.
- **Hedges must be bounded IOC limit orders** (Coinbase `sor_limit_ioc`, exact base_size, ~0.5% price collar from a fresh depth-walked VWAP). Never market BUY with quote_size derived from the *other* venue's price — an adverse move makes it reject for insufficient funds or buy the wrong quantity.
- Cancel ACK is not terminal; unconfirmable cancel → pending-indeterminate blocks all live execution.
- Strategy scoreboard is segregated via execution_quality style `cross-mm` and trades pair prefix `MM:`.

**Why:** hedged-structure strategies only avoid unwind risk if the hedge is guaranteed sized/funded off the actual fill and live book; anything else silently converts "arbitrage" into directional exposure.
**How to apply:** any new hedged or multi-leg live execution path — same fill-truth, bounded-hedge, honest-partial rules.
