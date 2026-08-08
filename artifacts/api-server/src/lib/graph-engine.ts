/**
 * CAT_ARB Graph Opportunity Engine
 *
 * Builds a directed graph where every node is (exchange, asset) and every edge
 * is a tradeable pair. Edges carry the LIVE order book so route simulation can
 * depth-walk the ACTUAL propagated amount of each leg into the next — no
 * USD-mid approximations. DFS cycle search finds all USD→…→USD paths up to
 * `maxHops` deep, covering:
 *   • Kraken-only triangular routes (dynamic USD-quoted + cross universe)
 *   • Coinbase-only routes (shared assets, USD legs only)
 *   • Cross-exchange routes via inventory bridge (kraken:A ↔ coinbase:A, no fee)
 *
 * Money-safety honesty rules baked in here:
 *   • Insufficient depth for the actual propagated amount → the route is
 *     UNPRICEABLE and dropped (never partially approximated).
 *   • A safety buffer identical to the execution preflight
 *     (max(0.02, size×0.0005)) is subtracted into `netAfterBufferUsd` and the
 *     scan ranks on that.
 *   • Every route is labelled executable/researchReason. Executable requires:
 *     a live-executor-supported 3-hop shape, EVERY leg priced from a LIVE
 *     stream book, and caller-supplied detected fee tiers. Otherwise the route
 *     is research-only with an honest reason. 4-leg/mixed → always research.
 *   • Maker-mode routes are always research-only (fills are not guaranteed and
 *     there is no confirmed-fill integration).
 */

import {
  fetchOrderBook,
  discoverCrossPairs,
  getDynamicUniverse,
  getStreamBook,
  type ObAsset,
} from "./order-book";
import { getCoinbaseOrderBook, type Pair } from "./exchange";

// ── Gemini SCAN-ONLY input ────────────────────────────────────────────────────
// The graph route feeds Gemini live USD books in here so cross-venue hops
// through Gemini surface in ranked routes. STRICTLY scan-only: every route that
// touches a Gemini hop is forced research-only (executable:false) with a plain
// label — the graph executor has no Gemini wiring, so a Gemini edge must never
// yield actionable profit.
export interface GeminiEdgeBook {
  asks: BookLevels;
  bids: BookLevels;
  /** Age (ms) of the live Gemini book, measured from LOCAL ARRIVAL of the last
   *  l2 delta (Gemini v2 l2 carries no exchange-side timestamp — this is the
   *  honest freshness bound). */
  ageMs: number;
  /** Gemini exchange minimum order size in BASE units (from /v1/symbols/details). */
  minOrderSize: number;
}
export interface GeminiScanInput {
  /** UPPER asset codes Gemini actually LISTS with a live USD book (never guessed). */
  assets: string[];
  /** asset (UPPER) → live Gemini USD book + age + minimum. */
  books: Map<string, GeminiEdgeBook>;
  /** Gemini taker fee %/leg applied on notional. */
  feePct: number;
  /** True when Gemini keys were in the request (detected tier); false = assumed+labeled. */
  feesDetected: boolean;
}

/** Plain, non-actionable label carried by every route containing a Gemini hop. */
export const GEMINI_SCAN_ONLY_LABEL = "SCAN-ONLY — Gemini legs not wired to graph executor";

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
  XRP:  "XRP/USD",
  DOGE: "DOGE/USD",
  LTC:  "LTC/USD",
  BCH:  "BCH/USD",
  AAVE: "AAVE/USD",
  FIL:  "FIL/USD",
};

// ── Graph types ───────────────────────────────────────────────────────────────

/** e.g. "kraken:BTC", "coinbase:ETH", "kraken:USD", "coinbase:USD" */
export type GraphNode = string;

export type ExchangeLabel = "kraken" | "coinbase" | "gemini" | "bridge";

export type EdgePricingSide = "buyBaseWithQuote" | "sellBaseForQuote" | "bridge";

export interface GraphEdge {
  to: GraphNode;
  exchange: ExchangeLabel;
  pair: string;         // raw pair/product name used for execution
  side: "buy" | "sell" | "bridge";
  feePct: number;
  /** Best bid (for post-only sells) or ask (for post-only buys) */
  limitPrice: number;
  /** How to interpret the book when walking this edge for the actual amount. */
  pricingSide: EdgePricingSide;
  /** Live order book carried on the edge — walked with the ACTUAL propagated
   *  amount during DFS (empty for bridge edges). */
  asks: BookLevels;
  bids: BookLevels;
  /** True when this edge's book came from the LIVE WS stream (not REST). A
   *  route is only executable when EVERY real leg is stream-priced. Bridge
   *  edges are neutral (true). */
  streamed: boolean;
  /** Gemini exchange minimum order size in BASE units (Gemini edges only). A
   *  route whose Gemini leg would trade below this is UNPRICEABLE and dropped —
   *  never surfaced as tradable size the venue would reject. */
  minBaseSize?: number;
  /** Age (ms) of a live NON-Kraken-stream book (Gemini l2, local-arrival based).
   *  Recorded so the route's freshness fields can carry the oldest such leg. */
  bookAgeMs?: number;
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
  /** Whether this leg was priced from a LIVE stream book (false = REST fallback). */
  streamed: boolean;
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
  /** Net USD profit after fees (what you actually keep) — for display. */
  netProfitUsd: number;
  /** Safety buffer applied (mirrors execution preflight: max(0.02, size×0.0005)). */
  safetyBufferUsd: number;
  /** Net after subtracting the safety buffer — the value routes are RANKED on. */
  netAfterBufferUsd: number;
  profitPct: number;
  slippagePct: number;
  /** Whether the net profit exceeds a positive threshold */
  status: "VIABLE" | "REJECTED" | "PRICING CONSISTENCY ERROR";
  /** True ONLY when the route is safe to fire live: an executor-supported shape,
   *  every leg priced from a LIVE stream book, and caller-supplied detected fees. */
  executable: boolean;
  /** Non-null when NOT executable — an honest reason the route is research-only. */
  researchReason: string | null;
  /** Recent live execution attempts recorded for this route+style (max 20 considered). */
  histLiveAttempts?: number;
  /** Historical live fill rate 0..1; null until ≥10 live attempts (insufficient history). */
  histFillRate?: number | null;
  /** Ranking score: netProfitUsd × fill-rate multiplier — approximates expected realized profit. */
  effectiveScoreUsd?: number;
  /** Age (ms) of the streamed snapshot this route was re-priced from (executor-grade math); null/undefined when not stream-priced. */
  quoteAgeMs?: number | null;
  /** "stream" = executor's simulator on live streamed books (matches pre-fire exactly); "graph" = graph-engine estimate. */
  pricedFrom?: string | null;
  /** Snapshot identity: latest book-update ms of the streamed snapshot used for repricing. Lets the executor distinguish "same snapshot, different number = pricing bug" from "books ticked = market movement". */
  marketUpdateMs?: number | null;
  /** Taker fee %/leg the stream repricing used — the pre-fire must decide with the same fee or re-price. */
  repricedFeePct?: number | null;
  /** True when this route contains at least one Gemini hop. Such routes are
   *  ALWAYS research-only (executable:false) — the graph executor has no Gemini
   *  wiring. Additive field; K/CB routes leave it false. */
  hasGeminiLeg?: boolean;
  /** Whether Gemini fees on this route were DETECTED (keys present) or ASSUMED
   *  (labeled). Null when the route has no Gemini hop. */
  geminiFeesDetected?: boolean | null;
  /** Age (ms) of the OLDEST Gemini leg's live l2 book on this route, measured
   *  from LOCAL ARRIVAL (Gemini l2 carries no exchange timestamp — the honest
   *  freshness bound). Null when the route has no Gemini hop. */
  geminiBookAgeMs?: number | null;
  /** Honest caveat string for the Gemini book age (freshness field). Null when
   *  the route has no Gemini hop. */
  geminiBookAgeCaveat?: string | null;
}

/** Mirror of the live executor's dispatch predicate — keep in lockstep with
 * graph-execute in routes/arb.ts. */
export function isRouteExecutable(hops: GraphRouteHop[]): boolean {
  const asset = (node: string) => node.split(":")[1] ?? node;
  const realHops = hops.filter(h => h.exchange !== "bridge");
  const isKrakenTriangle = hops.length === 3 && realHops.length === 3 && realHops.every(h => h.exchange === "kraken");
  const isCrossInventory = realHops.length === 2 && hops.length === 3 &&
    realHops[0]!.side === "buy" && realHops[1]!.side === "sell" &&
    asset(realHops[0]!.to) === asset(realHops[1]!.from);
  return isKrakenTriangle || isCrossInventory;
}

export type ExecutionStyle = "taker" | "maker";

export interface GraphScanResult {
  routes: GraphRoute[];
  tradeSizeUsd: number;
  krakenFeesPct: number;
  coinbaseFeesPct: number;
  /** Fee model applied to Kraken legs: taker (market, depth-walked) or maker (post-only join) */
  executionStyle: ExecutionStyle;
  /** Whether the fee inputs came from detected Kraken tiers (true) or assumed
   *  defaults (false). When false EVERY route is research-only. */
  feesDetected: boolean;
  assetsScanned: number;
  routesEvaluated: number;
  /** Number of crypto cross pairs discovered dynamically via Kraken AssetPairs (0 = hardcoded fallback) */
  crossPairsDiscovered: number;
  /** Size of the dynamic scan universe (USD pairs) actually used. */
  universeUsdPairs: number;
  /** Count of Gemini USD assets fed into the scan (SCAN-ONLY). 0/undefined when
   *  no Gemini books were supplied. Additive — backward-compatible. */
  geminiAssetsScanned?: number;
  /** Whether Gemini fees used in the scan were detected (keys present) vs
   *  assumed+labeled. Undefined when no Gemini books were supplied. */
  geminiFeesDetected?: boolean;
  scannedAt: string;
}

// ── Depth-aware pricing ───────────────────────────────────────────────────────

export type BookLevels = [number, number][];

/**
 * Walk ask levels spending `quoteAmount`; returns the volume-weighted average
 * price actually paid, or null when the visible book CANNOT absorb the full
 * size — a partial-depth VWAP applied to the whole trade would overstate the
 * fillable edge, so insufficient depth invalidates the edge entirely.
 */
export function vwapBuy(asks: BookLevels, quoteAmount: number): number | null {
  let spent = 0, acquired = 0;
  for (const [price, qty] of asks) {
    const levelQuote = price * qty;
    const take = Math.min(levelQuote, quoteAmount - spent);
    spent += take;
    acquired += take / price;
    if (spent >= quoteAmount - 1e-12) break;
  }
  if (spent < quoteAmount - 1e-9) return null; // book too thin for this size
  return acquired > 0 ? spent / acquired : null;
}

/** Walk bid levels selling `baseAmount`; VWAP received, or null if too thin. */
export function vwapSell(bids: BookLevels, baseAmount: number): number | null {
  let sold = 0, received = 0;
  for (const [price, qty] of bids) {
    const take = Math.min(qty, baseAmount - sold);
    sold += take;
    received += take * price;
    if (sold >= baseAmount - 1e-12) break;
  }
  if (sold < baseAmount - 1e-9) return null; // book too thin for this size
  return sold > 0 ? received / sold : null;
}

// ── Edge pricing helpers (pure — unit-tested) ────────────────────────────────

export interface EdgeQuote {
  /** units of to-asset per unit of from-asset, before fees */
  grossRate: number;
  /** grossRate × (1 − feePct/100) */
  netRate: number;
  /** VWAP drift vs top-of-book, in percent; clamped to ≥ 0. Always 0 for maker. */
  slippagePct: number;
  /** The effective price used (VWAP for taker, join price for maker). */
  effPrice: number;
}

/** Taker BUY: depth-walked VWAP over asks for `quoteAmount` of quote currency.
 * Returns null when the visible book cannot absorb the size — the edge must
 * be DROPPED, never approximated. */
export function takerBuyQuote(asks: BookLevels, quoteAmount: number, feePct: number): EdgeQuote | null {
  const bestAsk = asks[0]?.[0] ?? 0;
  if (!bestAsk) return null;
  const vwap = vwapBuy(asks, quoteAmount);
  if (vwap == null) return null;
  const slip = ((vwap - bestAsk) / bestAsk) * 100;
  const grossRate = 1 / vwap;
  return { grossRate, netRate: grossRate * (1 - feePct / 100), slippagePct: Math.max(0, slip), effPrice: vwap };
}

/** Taker SELL: depth-walked VWAP over bids for `baseAmount` of base currency.
 * Returns null when the visible book cannot absorb the size. */
export function takerSellQuote(bids: BookLevels, baseAmount: number, feePct: number): EdgeQuote | null {
  const bestBid = bids[0]?.[0] ?? 0;
  if (!bestBid) return null;
  const vwap = vwapSell(bids, baseAmount);
  if (vwap == null) return null;
  const slip = ((bestBid - vwap) / bestBid) * 100;
  return { grossRate: vwap, netRate: vwap * (1 - feePct / 100), slippagePct: Math.max(0, slip), effPrice: vwap };
}

/** Maker BUY: post-only join at best BID (better price, fill not guaranteed). */
export function makerBuyQuote(bestBid: number, feePct: number): EdgeQuote | null {
  if (!bestBid) return null;
  const grossRate = 1 / bestBid;
  return { grossRate, netRate: grossRate * (1 - feePct / 100), slippagePct: 0, effPrice: bestBid };
}

/** Maker SELL: post-only join at best ASK. */
export function makerSellQuote(bestAsk: number, feePct: number): EdgeQuote | null {
  if (!bestAsk) return null;
  return { grossRate: bestAsk, netRate: bestAsk * (1 - feePct / 100), slippagePct: 0, effPrice: bestAsk };
}

/**
 * Price ONE leg with the ACTUAL amount of from-asset it will carry.
 * This is the money-safety core: no USD-mid sizing, no first-asset
 * approximation — the exact output of the previous leg is what we walk here.
 *
 * Returns { amountOut, slippagePct } or null when the visible book cannot
 * absorb `amountIn` (→ the route is UNPRICEABLE and must be dropped).
 */
export function priceLeg(edge: GraphEdge, amountIn: number, maker: boolean): { amountOut: number; slippagePct: number } | null {
  if (edge.pricingSide === "bridge") return { amountOut: amountIn, slippagePct: 0 };
  const fee = 1 - edge.feePct / 100;
  if (edge.pricingSide === "buyBaseWithQuote") {
    // amountIn is QUOTE currency; buy base.
    if (maker) {
      const bestBid = edge.bids[0]?.[0] ?? 0;
      if (!bestBid) return null;
      const out = (amountIn / bestBid) * fee;
      if (belowGeminiMin(edge, out)) return null;
      return { amountOut: out, slippagePct: 0 };
    }
    const q = takerBuyQuote(edge.asks, amountIn, edge.feePct);
    if (!q) return null;
    // grossRate = 1/vwap = base per quote; amountOut = amountIn × netRate.
    const out = amountIn * q.netRate;
    if (belowGeminiMin(edge, out)) return null;
    return { amountOut: out, slippagePct: q.slippagePct };
  }
  // sellBaseForQuote: amountIn is BASE currency; sell for quote.
  if (belowGeminiMin(edge, amountIn)) return null;
  if (maker) {
    const bestAsk = edge.asks[0]?.[0] ?? 0;
    if (!bestAsk) return null;
    return { amountOut: amountIn * bestAsk * fee, slippagePct: 0 };
  }
  const q = takerSellQuote(edge.bids, amountIn, edge.feePct);
  if (!q) return null;
  return { amountOut: amountIn * q.netRate, slippagePct: q.slippagePct };
}

/** Gemini leg below the venue's exchange minimum (base units) → the leg would
 *  be rejected, so the route is UNPRICEABLE and dropped rather than surfaced at
 *  an un-tradable size. Non-Gemini edges (no minBaseSize) are unaffected. */
function belowGeminiMin(edge: GraphEdge, baseQty: number): boolean {
  return edge.exchange === "gemini" && edge.minBaseSize != null && edge.minBaseSize > 0 && baseQty < edge.minBaseSize;
}

// ── Node label helper ─────────────────────────────────────────────────────────

function nodeLabel(node: GraphNode): string {
  const [ex, asset] = node.split(":");
  const tag = ex === "kraken" ? "K" : ex === "coinbase" ? "CB" : ex === "gemini" ? "GEM" : "?";
  return asset === "USD" ? `USD[${tag}]` : `${asset}[${tag}]`;
}

// ── Graph builder ─────────────────────────────────────────────────────────────

interface BuildResult {
  graph: Map<GraphNode, GraphEdge[]>;
  crossPairsDiscovered: number;
  universeUsdPairs: number;
}

/** Which Kraken REST pair keys have a fresh LIVE stream book right now. */
function isStreamedPair(pair: string): boolean {
  return getStreamBook(pair) != null;
}

async function buildGraph(
  krakenFeesPct: number,
  coinbaseFeesPct: number,
  gemini?: GeminiScanInput,
): Promise<BuildResult> {
  const graph = new Map<GraphNode, GraphEdge[]>();

  const add = (from: GraphNode, edge: GraphEdge) => {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from)!.push(edge);
  };

  // ── Dynamic scan universe (USD pairs + crypto crosses) with static fallback ──
  const universe = await getDynamicUniverse();
  // Cross lookup for the discovery-count diagnostic (unchanged semantics).
  const { crossMap } = await discoverCrossPairs();
  const crossPairsDiscovered = universe.fromDiscovery ? universe.crossPairs.length : crossMap.length;

  // ── Fetch all Kraken books in parallel (stream-first via fetchOrderBook) ────
  const krakenUsdBooks = new Map<string, { asks: BookLevels; bids: BookLevels }>(); // asset → book
  const crossBooks     = new Map<string, { asks: BookLevels; bids: BookLevels }>(); // pair → book
  const cbBooks        = new Map<string, { asks: BookLevels; bids: BookLevels }>(); // asset → book

  await Promise.all([
    // Kraken USD order books for every dynamic USD-quoted asset.
    ...Array.from(universe.usdPairs.entries()).map(async ([asset, pair]) => {
      const book = await fetchOrderBook(pair, 20);
      if (book) krakenUsdBooks.set(asset, book as { asks: BookLevels; bids: BookLevels });
    }),
    // Kraken cross-pair books — dynamic cross set.
    ...Array.from(new Set(universe.crossPairs.map(c => c.pair))).map(async (pair) => {
      const book = await fetchOrderBook(pair, 20);
      if (book) crossBooks.set(pair, book as { asks: BookLevels; bids: BookLevels });
    }),
    // Coinbase level-2 order books for the shared assets.
    ...Object.entries(CB_ASSET_MAP).map(async ([asset, cbPair]) => {
      try {
        const book = await getCoinbaseOrderBook(cbPair as Pair);
        cbBooks.set(asset, book);
      } catch { /* exchange may be unavailable */ }
    }),
  ]);

  // ── Kraken USD edges ──────────────────────────────────────────────────────

  for (const [asset, pair] of universe.usdPairs.entries()) {
    const book = krakenUsdBooks.get(asset);
    if (!book) continue;
    const bestAsk = book.asks[0]?.[0] ?? 0;
    const bestBid = book.bids[0]?.[0] ?? 0;
    if (!bestAsk || !bestBid) continue;
    const streamed = isStreamedPair(pair);

    // USD → asset (buy base with USD)
    add("kraken:USD", {
      to: `kraken:${asset}`, exchange: "kraken", pair, side: "buy",
      feePct: krakenFeesPct, limitPrice: bestBid,
      pricingSide: "buyBaseWithQuote", asks: book.asks, bids: book.bids, streamed,
    });
    // asset → USD (sell base for USD)
    add(`kraken:${asset}`, {
      to: "kraken:USD", exchange: "kraken", pair, side: "sell",
      feePct: krakenFeesPct, limitPrice: bestAsk,
      pricingSide: "sellBaseForQuote", asks: book.asks, bids: book.bids, streamed,
    });
  }

  // ── Kraken cross-pair edges ───────────────────────────────────────────────

  for (const [key, cross] of universe.crossLookup.entries()) {
    const [fromAsset, toAsset] = key.split("-");
    if (!fromAsset || !toAsset) continue;
    const book = crossBooks.get(cross.pair);
    if (!book) continue;
    const bestAsk = book.asks[0]?.[0] ?? 0;
    const bestBid = book.bids[0]?.[0] ?? 0;
    if (!bestAsk || !bestBid) continue;
    const streamed = isStreamedPair(cross.pair);

    if (cross.aIsQuote) {
      // fromAsset is quote, toAsset is base → BUY the base (walk asks).
      add(`kraken:${fromAsset}`, {
        to: `kraken:${toAsset}`, exchange: "kraken", pair: cross.pair, side: "buy",
        feePct: krakenFeesPct, limitPrice: bestBid,
        pricingSide: "buyBaseWithQuote", asks: book.asks, bids: book.bids, streamed,
      });
    } else {
      // fromAsset is base, toAsset is quote → SELL the base (walk bids).
      add(`kraken:${fromAsset}`, {
        to: `kraken:${toAsset}`, exchange: "kraken", pair: cross.pair, side: "sell",
        feePct: krakenFeesPct, limitPrice: bestAsk,
        pricingSide: "sellBaseForQuote", asks: book.asks, bids: book.bids, streamed,
      });
    }
  }

  // ── Coinbase USD edges ────────────────────────────────────────────────────
  // Coinbase books are always REST/L2 pulls here (not the Kraken WS stream), so
  // they are never `streamed` — cross-exchange routes are research-only.

  for (const [asset, book] of cbBooks.entries()) {
    const bestAsk = book.asks[0]?.[0] ?? 0;
    const bestBid = book.bids[0]?.[0] ?? 0;
    if (!bestAsk || !bestBid) continue;

    add("coinbase:USD", {
      to: `coinbase:${asset}`, exchange: "coinbase", pair: `${asset}-USD`, side: "buy",
      feePct: coinbaseFeesPct, limitPrice: bestAsk,
      pricingSide: "buyBaseWithQuote", asks: book.asks, bids: book.bids, streamed: false,
    });
    add(`coinbase:${asset}`, {
      to: "coinbase:USD", exchange: "coinbase", pair: `${asset}-USD`, side: "sell",
      feePct: coinbaseFeesPct, limitPrice: bestBid,
      pricingSide: "sellBaseForQuote", asks: book.asks, bids: book.bids, streamed: false,
    });
  }

  // ── Gemini USD edges (SCAN-ONLY) ──────────────────────────────────────────
  // Live Gemini USD books fed in by the graph route. Only assets Gemini
  // ACTUALLY lists (USD books) — no synthetic pairs. These edges are `streamed:
  // false` so they never satisfy the executable predicate, and every route
  // that touches one is force-labeled research-only downstream. The Gemini
  // exchange minimum rides on each edge (minBaseSize) so sub-minimum legs drop.
  const geminiAssets = new Set<string>();
  if (gemini) {
    for (const asset of gemini.assets) {
      const book = gemini.books.get(asset);
      if (!book) continue;
      const bestAsk = book.asks[0]?.[0] ?? 0;
      const bestBid = book.bids[0]?.[0] ?? 0;
      if (!bestAsk || !bestBid) continue;
      geminiAssets.add(asset);

      add("gemini:USD", {
        to: `gemini:${asset}`, exchange: "gemini", pair: `${asset.toLowerCase()}usd`, side: "buy",
        feePct: gemini.feePct, limitPrice: bestAsk,
        pricingSide: "buyBaseWithQuote", asks: book.asks, bids: book.bids, streamed: false,
        minBaseSize: book.minOrderSize, bookAgeMs: book.ageMs,
      });
      add(`gemini:${asset}`, {
        to: "gemini:USD", exchange: "gemini", pair: `${asset.toLowerCase()}usd`, side: "sell",
        feePct: gemini.feePct, limitPrice: bestBid,
        pricingSide: "sellBaseForQuote", asks: book.asks, bids: book.bids, streamed: false,
        minBaseSize: book.minOrderSize, bookAgeMs: book.ageMs,
      });
    }
  }

  // ── Inventory bridge edges ────────────────────────────────────────────────
  // Simultaneous holdings on both exchanges. No fee or transfer delay.

  for (const asset of Object.keys(CB_ASSET_MAP) as ObAsset[]) {
    if (krakenUsdBooks.has(asset) && cbBooks.has(asset)) {
      const bridgeEdge = (to: GraphNode): GraphEdge => ({
        to, exchange: "bridge", pair: asset, side: "bridge",
        feePct: 0, limitPrice: 0,
        pricingSide: "bridge", asks: [], bids: [], streamed: true,
      });
      add(`kraken:${asset}`,   bridgeEdge(`coinbase:${asset}`));
      add(`coinbase:${asset}`, bridgeEdge(`kraken:${asset}`));
    }
  }

  // ── Gemini inventory bridge edges (SCAN-ONLY) ─────────────────────────────
  // Bridge Gemini holdings to/from Kraken & Coinbase inventory of the SAME
  // asset so cross-venue cycles that route through Gemini surface in the scan.
  // A bridge is fee-free/neutral like the K↔CB bridge; the Gemini SIDE leg's
  // `streamed:false` keeps any such route research-only.
  for (const asset of geminiAssets) {
    const bridgeEdge = (to: GraphNode): GraphEdge => ({
      to, exchange: "bridge", pair: asset, side: "bridge",
      feePct: 0, limitPrice: 0,
      pricingSide: "bridge", asks: [], bids: [], streamed: true,
    });
    if (krakenUsdBooks.has(asset as ObAsset)) {
      add(`kraken:${asset}`, bridgeEdge(`gemini:${asset}`));
      add(`gemini:${asset}`, bridgeEdge(`kraken:${asset}`));
    }
    if (cbBooks.has(asset)) {
      add(`coinbase:${asset}`, bridgeEdge(`gemini:${asset}`));
      add(`gemini:${asset}`,   bridgeEdge(`coinbase:${asset}`));
    }
  }

  // No USD↔USD bridge edge (avoids spurious duplicate Kraken-only cycles).

  return { graph, crossPairsDiscovered, universeUsdPairs: universe.usdPairs.size };
}

// ── DFS cycle finder ──────────────────────────────────────────────────────────

interface CycleContext {
  maker: boolean;
  feesDetected: boolean;
  safetyBufferUsd: number;
  /** Whether Gemini fees came from detected tiers (keys present) or assumed. */
  geminiFeesDetected: boolean;
}

function findCycles(
  graph: Map<GraphNode, GraphEdge[]>,
  startNode: GraphNode,
  startUsd: number,
  maxHops: number,
  ctx: CycleContext,
): GraphRoute[] {
  const routes: GraphRoute[] = [];

  function dfs(
    current: GraphNode,
    path: GraphNode[],
    edges: GraphEdge[],
    netAmt: number,     // ACTUAL amount of current asset (net of fees so far)
    slippage: number,
    visited: Set<GraphNode>,
    hopNets: number[],
    unpriceable: boolean,
  ) {
    if (edges.length > maxHops) return;

    for (const edge of graph.get(current) ?? []) {
      const { to, exchange } = edge;

      // Depth-walk this leg with the ACTUAL propagated amount. If the visible
      // book can't absorb it, the route through this edge is unpriceable.
      const priced = unpriceable ? null : priceLeg(edge, netAmt, ctx.maker);
      const legUnpriceable = unpriceable || priced == null;
      const newNet  = priced ? priced.amountOut : 0;
      const newSlip = slippage + (priced ? priced.slippagePct : 0);

      // ── Terminal: returned to any USD node with ≥2 real (non-bridge) hops ──
      if (to.endsWith(":USD") && edges.length >= 2) {
        const realHops = edges.filter(e => e.exchange !== "bridge").length + (exchange !== "bridge" ? 1 : 0);
        if (realHops < 2) continue;
        // Reject pure 2-leg round-trips (buy+sell same asset — always loses to
        // spread). Require ≥3 real hops OR land at a different USD node.
        if (realHops === 2 && to === path[0]) continue;
        // Route the book couldn't absorb → UNPRICEABLE, never approximated: drop.
        if (legUnpriceable) continue;

        const allNodes = [...path, to];
        const allNets  = [...hopNets, newNet];
        const allEdges = [...edges, edge];

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
          streamed:  e.streamed,
        }));

        const netProfitUsd = newNet - startUsd;
        // Gross (fee-free) profit: re-walk each leg at zero fee for an honest
        // fee-drag figure. Uses the same actual-amount propagation.
        const grossProfitUsd = computeGrossProfit(allEdges, startUsd, ctx.maker);
        const feeUsd = grossProfitUsd - netProfitUsd;
        const desc = allNodes.map(nodeLabel).join("→");

        const netAfterBufferUsd = netProfitUsd - ctx.safetyBufferUsd;
        const { executable, researchReason } = classifyRoute(hops, ctx);

        // Gemini freshness/labeling (additive). Oldest Gemini leg age carried so
        // the freshness fields reflect the local-arrival bound honestly.
        const geminiEdges = allEdges.filter(e => e.exchange === "gemini");
        const hasGeminiLeg = geminiEdges.length > 0;
        const geminiBookAgeMs = hasGeminiLeg
          ? Math.max(...geminiEdges.map(e => e.bookAgeMs ?? 0))
          : null;

        routes.push({
          hops,
          description: desc,
          startUsd,
          grossProfitUsd,
          feeUsd,
          netProfitUsd,
          safetyBufferUsd: ctx.safetyBufferUsd,
          netAfterBufferUsd,
          profitPct: (netProfitUsd / startUsd) * 100,
          slippagePct: newSlip,
          status: netAfterBufferUsd > 0 ? "VIABLE" : "REJECTED",
          executable,
          researchReason,
          hasGeminiLeg,
          geminiFeesDetected: hasGeminiLeg ? ctx.geminiFeesDetected : null,
          geminiBookAgeMs,
          geminiBookAgeCaveat: hasGeminiLeg
            ? "Gemini l2 carries no exchange timestamp — age is local-arrival based"
            : null,
        });
        continue;
      }

      // Don't revisit non-USD nodes; don't chain two bridge hops in a row.
      if (visited.has(to)) continue;
      if (exchange === "bridge" && edges[edges.length - 1]?.exchange === "bridge") continue;

      const newVisited = new Set(visited);
      newVisited.add(to);

      dfs(to, [...path, to], [...edges, edge], newNet, newSlip,
          newVisited, [...hopNets, newNet], legUnpriceable);
    }
  }

  const initVisited = new Set<GraphNode>([startNode]);
  dfs(startNode, [startNode], [], startUsd, 0, initVisited, [], false);
  return routes;
}

/** Re-walk a completed edge chain at ZERO fee to get the fee-free output —
 *  used for an honest gross-profit / fee-drag figure. Returns startUsd (→ 0
 *  gross) if any leg can't be priced (never happens for a route that already
 *  priced net, but be safe). */
function computeGrossProfit(edges: GraphEdge[], startUsd: number, maker: boolean): number {
  let amt = startUsd;
  for (const e of edges) {
    const zeroFeeEdge: GraphEdge = { ...e, feePct: 0 };
    const priced = priceLeg(zeroFeeEdge, amt, maker);
    if (!priced) return startUsd; // shouldn't happen; keep gross == start (0 profit)
    amt = priced.amountOut;
  }
  return amt - startUsd;
}

/**
 * Decide executable/researchReason for a completed route. Money-safety honesty:
 * a route is executable ONLY when ALL of these hold:
 *   • the shape is one the live executor supports (Kraken triangle or 2-leg
 *     cross-exchange inventory) — isRouteExecutable();
 *   • it is NOT maker-mode (maker fills are not guaranteed, no confirmed-fill
 *     engine integration);
 *   • EVERY real (non-bridge) leg was priced from a LIVE stream book;
 *   • the caller supplied DETECTED fee tiers (feesDetected).
 * Otherwise the route is research-only with the most important honest reason.
 */
function classifyRoute(hops: GraphRouteHop[], ctx: CycleContext): { executable: boolean; researchReason: string | null } {
  const realHops = hops.filter(h => h.exchange !== "bridge");
  // Any Gemini hop → ALWAYS research-only. The graph executor has no Gemini
  // wiring; a Gemini edge must never yield actionable profit. This check comes
  // FIRST so it cannot be shadowed by any other classification.
  if (hops.some(h => h.exchange === "gemini")) {
    return { executable: false, researchReason: GEMINI_SCAN_ONLY_LABEL };
  }
  if (!isRouteExecutable(hops)) {
    return { executable: false, researchReason: "unsupported route shape (4-leg / mixed) — projection only" };
  }
  if (ctx.maker) {
    return { executable: false, researchReason: "maker fills not guaranteed — projection only" };
  }
  if (realHops.some(h => !h.streamed)) {
    return { executable: false, researchReason: "priced from REST/non-stream books — research only" };
  }
  if (!ctx.feesDetected) {
    return { executable: false, researchReason: "fees assumed — connect Kraken keys" };
  }
  return { executable: true, researchReason: null };
}

// ── Public scan function ──────────────────────────────────────────────────────

export async function scanGraphOpportunities(
  tradeSizeUsd: number,
  krakenFeesPct: number,
  coinbaseFeesPct: number,
  maxHops = 4,
  executionStyle: ExecutionStyle = "taker",
  feesDetected = false,
  gemini?: GeminiScanInput,
): Promise<GraphScanResult> {
  const { graph, crossPairsDiscovered, universeUsdPairs } = await buildGraph(krakenFeesPct, coinbaseFeesPct, gemini);

  // Safety buffer identical to the execution preflight in routes/arb.ts:
  //   Math.max(0.02, tradeSizeUsd * 0.0005)
  const safetyBufferUsd = Math.max(0.02, tradeSizeUsd * 0.0005);
  const ctx: CycleContext = {
    maker: executionStyle === "maker",
    feesDetected,
    safetyBufferUsd,
    geminiFeesDetected: gemini?.feesDetected ?? false,
  };

  // Search from every USD node so we find cross-exchange cycles that begin on
  // any venue (e.g. USD[CB]→BTC[CB]→BTC[K]→USD[K], or a Gemini SCAN-ONLY hop).
  const allRoutes = [
    ...findCycles(graph, "kraken:USD",   tradeSizeUsd, maxHops, ctx),
    ...findCycles(graph, "coinbase:USD", tradeSizeUsd, maxHops, ctx),
    ...(gemini ? findCycles(graph, "gemini:USD", tradeSizeUsd, maxHops, ctx) : []),
  ];

  // Deduplicate by description (same cycle can be discovered from either start).
  const seen = new Set<string>();
  const unique = allRoutes.filter(r => {
    if (seen.has(r.description)) return false;
    seen.add(r.description);
    return true;
  });

  // Executable routes first (the top route is what Execute Top Route fires),
  // then by BUFFERED net (netAfterBufferUsd) within each group — rank on the
  // pessimistic, post-buffer number, not the raw net.
  unique.sort((a, b) => (Number(b.executable) - Number(a.executable)) || (b.netAfterBufferUsd - a.netAfterBufferUsd));

  const assetsScanned = graph.size; // number of nodes with outgoing edges

  return {
    routes: unique.slice(0, 25),
    tradeSizeUsd,
    krakenFeesPct,
    coinbaseFeesPct,
    executionStyle,
    feesDetected,
    assetsScanned,
    crossPairsDiscovered,
    universeUsdPairs,
    geminiAssetsScanned: gemini ? gemini.books.size : undefined,
    geminiFeesDetected: gemini ? gemini.feesDetected : undefined,
    routesEvaluated: allRoutes.length,
    scannedAt: new Date().toISOString(),
  };
}
