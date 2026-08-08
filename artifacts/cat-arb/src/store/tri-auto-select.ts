import type { TriangularOpportunity } from "@workspace/api-client-react";

/**
 * Pick the best triangular opportunity for the LIVE auto-executor.
 *
 * Priority: BTC-variant loops first (liquid SOLXBT market), then ETH loops.
 *
 * ETH-variant loops price the ETH/SOL leg from the scan's per-exchange price
 * source. When that source is "synthetic" (ETH/USD ÷ SOL/USD cross rate, not a
 * live market), the edge is estimated — never auto-fire a live trade on it.
 * Mirrors the Force Triangular button's synthetic-price block.
 *
 * `priceSource` keys are lowercase exchange ids ("kraken"/"coinbase") while
 * opportunity `exchange` labels are display-cased ("Kraken"/"Coinbase"), so
 * the lookup is case-insensitive by design.
 *
 * `warn` is invoked once per skipped synthetic ETH opportunity with a
 * human-readable reason (callers wire it to the activity log).
 */
export function selectTriAutoOpportunity(
  opps: TriangularOpportunity[],
  priceSource: Record<string, "direct" | "synthetic">,
  minNetEdge: number,
  warn: (message: string) => void,
): TriangularOpportunity | undefined {
  const qualified = opps.filter(o => o.profitPct >= minNetEdge);
  const bestBtc = qualified
    .filter(o => o.variant === "btc")
    .sort((a, b) => b.profitPct - a.profitPct)[0];

  const ethTradable = qualified
    .filter(o => o.variant !== "btc")
    .filter(o => {
      const source = priceSource[o.exchange.toLowerCase()];
      if (source !== "synthetic") return true;
      warn(
        `[TRI·ETH·AUTO] Skipped ${o.exchange} ${o.loop} (+${o.profitPct.toFixed(3)}%) — ` +
        `ETH/SOL priced from synthetic cross-rate (ETH/USD ÷ SOL/USD); live auto-execute blocked on estimated prices`,
      );
      return false;
    });
  const bestEth = ethTradable.sort((a, b) => b.profitPct - a.profitPct)[0];

  return bestBtc ?? bestEth;
}
