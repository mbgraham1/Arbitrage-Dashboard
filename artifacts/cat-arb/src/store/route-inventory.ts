/**
 * Cross-exchange inventory requirements for Graph Engine routes.
 *
 * Bridge hops model "you already hold this asset on the destination venue" —
 * no transfer happens mid-trade. So each bridge hop is an inventory
 * PREREQUISITE: `amountIn` of the bridged asset (hop.pair carries the asset
 * name for bridge hops) must already sit on the bridge's destination exchange
 * before the route can fire.
 *
 * Pure functions — unit-tested; shared by the table badges, the manual
 * EXECUTE gate, the AUTO gate, and the fallback-candidate gate so no live
 * execution path can bypass the inventory check.
 */

export interface InventoryRequirement {
  asset: string;
  exchange: "kraken" | "coinbase";
  amount: number;
}

interface RouteHopLike {
  exchange: string;
  pair: string;
  to: string;
  amountIn: number;
}

export interface BalancesLike {
  kraken: { currency: string; amount: number }[];
  coinbase: { currency: string; amount: number }[];
}

export function routeInventoryReqs(route: { hops: RouteHopLike[] }): InventoryRequirement[] {
  return route.hops
    .filter(h => h.exchange === "bridge")
    .map(h => ({
      asset: h.pair,
      exchange: (h.to.split(":")[0] === "coinbase" ? "coinbase" : "kraken") as "kraken" | "coinbase",
      amount: h.amountIn,
    }));
}

/** Kraken reports some assets under non-standard codes (BTC→XBT/XXBT, ETH→XETH…). */
export const KRAKEN_BALANCE_ALIASES: Record<string, string[]> = {
  BTC: ["XBT", "XXBT"],
  ETH: ["ETH", "XETH"],
  SOL: ["SOL", "SOL.S"],
};

/** Balance of `asset` on `exchange` from cached balances; null = balances not loaded. */
export function inventoryBalanceFor(
  balances: BalancesLike | null | undefined,
  exchange: "kraken" | "coinbase",
  asset: string,
): number | null {
  if (!balances) return null;
  const list = exchange === "kraken" ? balances.kraken : balances.coinbase;
  if (!Array.isArray(list)) return null;
  const codes = exchange === "kraken"
    ? (KRAKEN_BALANCE_ALIASES[asset.toUpperCase()] ?? [asset.toUpperCase()])
    : [asset.toUpperCase()];
  return list
    .filter(b => codes.includes(b.currency.toUpperCase()))
    .reduce((sum, b) => sum + b.amount, 0);
}

/**
 * Requirements of `route` that the cached balances PROVABLY fail to cover.
 * Unknown balances (null — bot idle / never fetched) do NOT count as missing:
 * the server pre-flight remains the final validator in that case.
 */
export function missingInventory(
  route: { hops: RouteHopLike[] },
  balances: BalancesLike | null | undefined,
): InventoryRequirement[] {
  return routeInventoryReqs(route).filter(req => {
    const held = inventoryBalanceFor(balances, req.exchange, req.asset);
    return held != null && held < req.amount;
  });
}

export const EX_LABEL: Record<"kraken" | "coinbase", string> = {
  kraken: "Kraken",
  coinbase: "Coinbase",
};

/** Human-readable summary, e.g. "0.000154 BTC on Coinbase, 2.5 SOL on Kraken". */
export function formatInventoryReqs(reqs: InventoryRequirement[]): string {
  return reqs
    .map(r => `${r.amount >= 1 ? r.amount.toFixed(4) : r.amount.toPrecision(3)} ${r.asset} on ${EX_LABEL[r.exchange]}`)
    .join(", ");
}
