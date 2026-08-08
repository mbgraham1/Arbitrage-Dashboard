// ── Canonical route-profit sanity guard ──────────────────────────────────────
// Every surface that DISPLAYS or ACTS ON a projected route net (graph scan,
// cross-venue scan, pre-fire, rebalance planner) must run its final number
// through this guard. A net profit that implies an implausible gain relative
// to the route's size — or that exceeds its own zero-fee gross — is a pricing
// bug (unit inversion, notional reset, stale/corrupt book), NEVER a real edge.
// Such rows are flagged "PRICING CONSISTENCY ERROR", blocked from execution,
// and shown with the reason instead of the impossible number.

/** Max believable net profit as % of route size. Cross-exchange crypto edges
 *  are basis points; 5% is already ~50x a great edge. Configurable via env. */
export const ROUTE_SANITY_MAX_NET_PCT: number = (() => {
  const v = parseFloat(process.env["ROUTE_SANITY_MAX_NET_PCT"] ?? "");
  return Number.isFinite(v) && v > 0 ? v : 5;
})();

const EPS_USD = 1e-6;

/** Returns a human-readable PRICING CONSISTENCY ERROR string when the numbers
 *  are impossible, or null when they pass. `grossProfitUsd` (zero-fee walk of
 *  the same books) is optional; when present, net must not exceed it. */
export function routeSanityError(
  startUsd: number,
  netProfitUsd: number,
  grossProfitUsd?: number | null,
): string | null {
  if (!Number.isFinite(startUsd) || startUsd <= 0)
    return `PRICING CONSISTENCY ERROR — route size $${String(startUsd)} is not a positive finite number.`;
  if (!Number.isFinite(netProfitUsd))
    return `PRICING CONSISTENCY ERROR — projected net is not a finite number.`;
  const capUsd = startUsd * (ROUTE_SANITY_MAX_NET_PCT / 100);
  if (netProfitUsd > capUsd)
    return `PRICING CONSISTENCY ERROR — projected net $${netProfitUsd.toFixed(2)} implies +${((netProfitUsd / startUsd) * 100).toFixed(1)}% on a $${startUsd.toFixed(2)} route, above the ${ROUTE_SANITY_MAX_NET_PCT}% sanity cap (ROUTE_SANITY_MAX_NET_PCT). This is a pricing/propagation bug, not an edge — route blocked.`;
  if (grossProfitUsd != null && Number.isFinite(grossProfitUsd) && netProfitUsd > grossProfitUsd + EPS_USD)
    return `PRICING CONSISTENCY ERROR — net after fees $${netProfitUsd.toFixed(2)} exceeds the zero-fee gross $${grossProfitUsd.toFixed(2)} from the same books. Impossible by construction — route blocked.`;
  return null;
}
