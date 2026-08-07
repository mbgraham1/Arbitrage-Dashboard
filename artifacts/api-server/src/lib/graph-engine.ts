/**
 * CAT_ARB Graph Opportunity Engine
 *
 * Builds a directed graph where every node is (exchange, asset) and every edge
 * is a tradeable pair weighted by the top-of-book exchange rate (net of fees).
 * DFS cycle search finds all USD→…→USD paths up to `maxHops` deep, covering:
 *   • Kraken-only triangular routes (34 assets, all verified cross pairs)
 *   • Coinbase-only routes (10 shared assets, USD legs only)
 *   • Cross-exchange routes via inventory bridge (kraken:A ↔ coinbase:A, no fee)
 *
 * This replaces the hardcoded 15-cycle OB Hunter with a full search that scales
 * automatically as more assets / exchanges are added.
 */

import {
  fetchOrderBook,
  OB_ASSETS,
  OB_USD_PAIRS,
  CROSS_LOOKUP,
  type ObAsset,
} from "./order-book";
import { getCoinbaseBidAsk, type Pair } from "./exchange";

// ── Coinbase asset overlap ────────────────────────────────────────────────────

/** Assets available on BOTH Kraken and Coinbase, mapped to their Coinbase Pair. */
const CB_ASSET_MAP: Partial<Record<ObAsset, Pair>> = {
  BTC:  "BTC/USD",
  ETH:  "ETH/USD",
  SOL:  "SOL/USD",
  AVAX: "AVAX/USD",
  DOT:  "DOT/USD",
  LINK: "LINK/USD",
  UNI:  "UNI/USD",
  ATOM: "ATOM/USD",
  ADA:  "ADA/USD",
};

// ── Graph types ───────────────────────────────────────────────────────────────

/** e.g. "kraken:BTC", "coinbase:ETH", "kraken:USD", "coinbase:USD" */
export type GraphNode = string;

export type ExchangeLabel = "kraken" | "coinbase" | "bridge";

export interface GraphEdge {
  to: GraphNode;
  exchange: ExchangeLabel;
  pair: string;         // raw pair/product name used for execution
  side: "buy" | "sell" | "bridge";
  /** Rate BEFORE fee: units of to-asset per unit of from-asset */
  grossRate: number;
  /** Rate AFTER fee: grossRate × (1 − feePct/100) */
  netRate: number;
  feePct: number;
  slippagePct: number;
  /** Best bid (for post-only sells) or ask (for post-only buys) */
  limitPrice: number;
}

export interface GraphRouteHop {
  from: GraphNode;
  to: GraphNode;
  exchange: ExchangeLabel;
  pair: string;
  side: "buy" | "sell" | "bridge";
  amountIn: number;
  amountOut: number;
  feePct: number;
  limitPrice: number;
}

export interface GraphRoute {
  hops: GraphRouteHop[];
  /** Human-readable path, e.g. "USD[K]→BTC[K]→ETH[CB]→USD[CB]" */
  description: string;
  startUsd: number;
  /** Raw USD profit if fees were zero */
  grossProfitUsd: number;
  /** Total USD fee drag across all legs */
  feeUsd: number;
  /** Net USD profit after fees (what you actually keep) */
  netProfitUsd: number;
  profitPct: number;
  slippagePct: number;
  /** Whether the net profit exceeds a positive threshold */
  status: "VIABLE" | "REJECTED";
}

export interface GraphScanResult {
  routes: GraphRoute[];
  tradeSizeUsd: number;
  krakenFeesPct: number;
  coinbaseFeesPct: number;
  assetsScanned: number;
  routesEvaluated: number;
  scannedAt: string;
}

// ── Node label helper ─────────────────────────────────────────────────────────

function nodeLabel(node: GraphNode): string {
  const [ex, asset] = node.split(":");
  const tag = ex === "kraken" ? "K" : "CB";
  return asset === "USD" ? `USD[${tag}]` : `${asset}[${tag}]`;
}

// ── Graph builder ─────────────────────────────────────────────────────────────

async function buildGraph(
  krakenFeesPct: number,
  coinbaseFeesPct: number,
): Promise<Map<GraphNode, GraphEdge[]>> {
  const graph = new Map<GraphNode, GraphEdge[]>();

  const add = (from: GraphNode, edge: GraphEdge) => {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from)!.push(edge);
  };

  // ── Fetch all data in parallel ────────────────────────────────────────────

  const krakenBooks = new Map<string, { asks: [number,number][]; bids: [number,number][] }>();
  const cbPrices    = new Map<string, { bid: number; ask: number }>();
  const crossBooks  = new Map<string, { asks: [number,number][]; bids: [number,number][] }>();

  await Promise.all([
    // Kraken USD order books for all 34 assets
    ...OB_ASSETS.map(async (asset) => {
      const book = await fetchOrderBook(OB_USD_PAIRS[asset], 20);
      if (book) krakenBooks.set(asset, book as { asks: [number,number][]; bids: [number,number][] });
    }),
    // Kraken cross-pair books (cached so cheap after USD books warm up)
    ...Array.from(new Set(Array.from(CROSS_LOOKUP.values()).map(c => c.pair))).map(async (pair) => {
      const book = await fetchOrderBook(pair, 10);
      if (book) crossBooks.set(pair, book as { asks: [number,number][]; bids: [number,number][] });
    }),
    // Coinbase tickers for the 9 shared assets
    ...Object.entries(CB_ASSET_MAP).map(async ([asset, cbPair]) => {
      try {
        const prices = await getCoinbaseBidAsk(cbPair as Pair);
        cbPrices.set(asset, prices);
      } catch { /* exchange may be unavailable */ }
    }),
  ]);

  // ── Kraken USD edges ──────────────────────────────────────────────────────

  for (const asset of OB_ASSETS) {
    const book = krakenBooks.get(asset);
    if (!book) continue;

    const bestAsk = book.asks[0]?.[0] ?? 0;
    const bestBid = book.bids[0]?.[0] ?? 0;
    if (!bestAsk || !bestBid) continue;

    // USD → Asset: buy asset with USD (walk asks)
    const buyGross = 1 / bestAsk;
    add("kraken:USD", {
      to: `kraken:${asset}`, exchange: "kraken",
      pair: OB_USD_PAIRS[asset], side: "buy",
      grossRate: buyGross, netRate: buyGross * (1 - krakenFeesPct / 100),
      feePct: krakenFeesPct, slippagePct: 0, limitPrice: bestBid, // post-only buys join best bid
    });

    // Asset → USD: sell asset for USD (walk bids)
    const sellGross = bestBid;
    add(`kraken:${asset}`, {
      to: "kraken:USD", exchange: "kraken",
      pair: OB_USD_PAIRS[asset], side: "sell",
      grossRate: sellGross, netRate: sellGross * (1 - krakenFeesPct / 100),
      feePct: krakenFeesPct, slippagePct: 0, limitPrice: bestAsk, // post-only sells join best ask
    });
  }

  // ── Kraken cross-pair edges ───────────────────────────────────────────────

  for (const [key, cross] of CROSS_LOOKUP.entries()) {
    const [fromAsset, toAsset] = key.split("-") as [ObAsset, ObAsset];
    const book = crossBooks.get(cross.pair);
    if (!book) continue;

    const bestAsk = book.asks[0]?.[0] ?? 0;
    const bestBid = book.bids[0]?.[0] ?? 0;
    if (!bestAsk || !bestBid) continue;

    if (cross.aIsQuote) {
      // fromAsset is quote, toAsset is base. Going from→to BUYs the base.
      // Rate: 1/ask (base units per quote unit)
      const grossRate = 1 / bestAsk;
      add(`kraken:${fromAsset}`, {
        to: `kraken:${toAsset}`, exchange: "kraken",
        pair: cross.pair, side: "buy",
        grossRate, netRate: grossRate * (1 - krakenFeesPct / 100),
        feePct: krakenFeesPct, slippagePct: 0, limitPrice: bestBid,
      });
    } else {
      // fromAsset is base, toAsset is quote. Going from→to SELLs the base.
      // Rate: bid (quote units per base unit)
      const grossRate = bestBid;
      add(`kraken:${fromAsset}`, {
        to: `kraken:${toAsset}`, exchange: "kraken",
        pair: cross.pair, side: "sell",
        grossRate, netRate: grossRate * (1 - krakenFeesPct / 100),
        feePct: krakenFeesPct, slippagePct: 0, limitPrice: bestAsk,
      });
    }
  }

  // ── Coinbase USD edges ────────────────────────────────────────────────────

  for (const [asset, prices] of cbPrices.entries()) {
    const { bid, ask } = prices;
    if (!bid || !ask) continue;

    // USD → Asset on Coinbase
    const buyGross = 1 / ask;
    add("coinbase:USD", {
      to: `coinbase:${asset}`, exchange: "coinbase",
      pair: `${asset}-USD`, side: "buy",
      grossRate: buyGross, netRate: buyGross * (1 - coinbaseFeesPct / 100),
      feePct: coinbaseFeesPct, slippagePct: 0, limitPrice: ask,
    });

    // Asset → USD on Coinbase
    const sellGross = bid;
    add(`coinbase:${asset}`, {
      to: "coinbase:USD", exchange: "coinbase",
      pair: `${asset}-USD`, side: "sell",
      grossRate: sellGross, netRate: sellGross * (1 - coinbaseFeesPct / 100),
      feePct: coinbaseFeesPct, slippagePct: 0, limitPrice: bid,
    });
  }

  // ── Inventory bridge edges ────────────────────────────────────────────────
  // Representing simultaneous holdings on both exchanges. No fee or transfer
  // delay — you buy on one side and sell on the other from existing inventory.

  for (const asset of Object.keys(CB_ASSET_MAP) as ObAsset[]) {
    if (krakenBooks.has(asset) && cbPrices.has(asset)) {
      const bridgeEdge = (to: GraphNode): GraphEdge => ({
        to, exchange: "bridge", pair: asset, side: "bridge",
        grossRate: 1, netRate: 1, feePct: 0, slippagePct: 0, limitPrice: 0,
      });
      add(`kraken:${asset}`,   bridgeEdge(`coinbase:${asset}`));
      add(`coinbase:${asset}`, bridgeEdge(`kraken:${asset}`));
    }
  }

  // No USD↔USD bridge edge: adding it creates spurious "start at CB-USD,
  // immediately hop to K-USD, do Kraken-only triangle" routes that are just
  // noisy duplicates of Kraken-start routes.  Cross-exchange routes naturally
  // end at the other venue's USD (e.g. USD[K]→BTC[K]→BTC[CB]→USD[CB]).

  return graph;
}

// ── DFS cycle finder ──────────────────────────────────────────────────────────

function findCycles(
  graph: Map<GraphNode, GraphEdge[]>,
  startNode: GraphNode,
  startUsd: number,
  maxHops: number,
): GraphRoute[] {
  const routes: GraphRoute[] = [];

  function dfs(
    current: GraphNode,
    path: GraphNode[],
    edges: GraphEdge[],
    netAmt: number,     // amount of current asset (net of fees so far)
    grossAmt: number,   // same, without fees
    slippage: number,
    visited: Set<GraphNode>,
    hopNets: number[],
    hopGross: number[],
  ) {
    if (edges.length > maxHops) return;

    for (const edge of graph.get(current) ?? []) {
      const { to, netRate, grossRate, slippagePct, exchange } = edge;
      const newNet   = netAmt   * netRate;
      const newGross = grossAmt * grossRate;
      const newSlip  = slippage + slippagePct;

      // ── Terminal: returned to any USD node with ≥2 real (non-bridge) hops ──
      if (to.endsWith(":USD") && edges.length >= 2) {
        const realHops = edges.filter(e => e.exchange !== "bridge").length + (exchange !== "bridge" ? 1 : 0);
        if (realHops < 2) continue;
        // Reject pure 2-leg round-trips (buy+sell same asset — always loses
        // money to spread). Require ≥3 real hops OR land at a different USD node.
        if (realHops === 2 && to === path[0]) continue;

        const allNodes  = [...path, to];
        const allNets   = [...hopNets, newNet];
        const allGross  = [...hopGross, newGross];
        const allEdges  = [...edges, edge];

        const hops: GraphRouteHop[] = allEdges.map((e, i) => ({
          from: allNodes[i],
          to:   allNodes[i + 1],
          exchange: e.exchange,
          pair:     e.pair,
          side:     e.side,
          amountIn:  i === 0 ? startUsd : allNets[i - 1],
          amountOut: allNets[i],
          feePct:    e.feePct,
          limitPrice: e.limitPrice,
        }));

        const netProfitUsd   = newNet   - startUsd;
        const grossProfitUsd = newGross - startUsd;
        const feeUsd         = grossProfitUsd - netProfitUsd;
        const desc           = allNodes.map(nodeLabel).join("→");

        routes.push({
          hops,
          description: desc,
          startUsd,
          grossProfitUsd,
          feeUsd,
          netProfitUsd,
          profitPct: (netProfitUsd / startUsd) * 100,
          slippagePct: newSlip,
          status: netProfitUsd > 0 ? "VIABLE" : "REJECTED",
        });
        continue;
      }

      // Don't revisit non-USD nodes; don't chain two bridge hops in a row.
      if (visited.has(to)) continue;
      if (exchange === "bridge" && edges[edges.length - 1]?.exchange === "bridge") continue;

      const newVisited = new Set(visited);
      newVisited.add(to);

      dfs(to, [...path, to], [...edges, edge], newNet, newGross, newSlip,
          newVisited, [...hopNets, newNet], [...hopGross, newGross]);
    }
  }

  const initVisited = new Set<GraphNode>([startNode]);
  dfs(startNode, [startNode], [], startUsd, startUsd, 0, initVisited, [], []);
  return routes;
}

// ── Public scan function ──────────────────────────────────────────────────────

export async function scanGraphOpportunities(
  tradeSizeUsd: number,
  krakenFeesPct: number,
  coinbaseFeesPct: number,
  maxHops = 4,
): Promise<GraphScanResult> {
  const graph = await buildGraph(krakenFeesPct, coinbaseFeesPct);

  // Search from both USD nodes so we find cross-exchange cycles that begin on
  // either Kraken or Coinbase (e.g. USD[CB]→BTC[CB]→BTC[K]→USD[K]).
  const allRoutes = [
    ...findCycles(graph, "kraken:USD",   tradeSizeUsd, maxHops),
    ...findCycles(graph, "coinbase:USD", tradeSizeUsd, maxHops),
  ];

  // Deduplicate by description (same cycle can be discovered from either start).
  const seen = new Set<string>();
  const unique = allRoutes.filter(r => {
    if (seen.has(r.description)) return false;
    seen.add(r.description);
    return true;
  });

  unique.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

  const assetsScanned =
    OB_ASSETS.filter(a => graph.has(`kraken:${a}`)).length +
    (Object.keys(CB_ASSET_MAP) as ObAsset[]).filter(a => graph.has(`coinbase:${a}`)).length;

  return {
    routes: unique.slice(0, 25),
    tradeSizeUsd,
    krakenFeesPct,
    coinbaseFeesPct,
    assetsScanned,
    routesEvaluated: allRoutes.length,
    scannedAt: new Date().toISOString(),
  };
}
