/**
 * v14 "Order Book Hunter" — port of Python v14 simulate_triangular_cycle().
 *
 * Fetches L2 order book depth from Kraken public Depth API and walks the book
 * level-by-level to get realistic average fill prices at a given trade size.
 * Scans all 30 permutations of 6 assets: BTC, ETH, SOL, LINK, ADA, MATIC.
 */

// ── Asset definitions ─────────────────────────────────────────────────────────

export const OB_ASSETS = ["BTC", "ETH", "SOL", "LINK", "ADA", "MATIC"] as const;
export type ObAsset = typeof OB_ASSETS[number];

/** Kraken REST pair symbols for the USD leg of each asset. */
export const OB_USD_PAIRS: Record<ObAsset, string> = {
  BTC:   "XXBTZUSD",
  ETH:   "ETHUSD",
  SOL:   "SOLUSD",
  LINK:  "LINKUSD",
  ADA:   "ADAUSD",
  MATIC: "MATICUSD",
};

/**
 * Cross-pair definitions matching Python v14 CROSS_PAIRS.
 * Layout: [assetA, assetB, krakenPairSymbol]
 * Bid side of this pair = "sell A, receive B" (B per A).
 */
const OB_CROSS_MAP: Array<[ObAsset, ObAsset, string]> = [
  ["BTC",  "ETH",   "ETHXBT"],
  ["BTC",  "SOL",   "SOLXBT"],
  ["BTC",  "LINK",  "LINKXBT"],
  ["BTC",  "ADA",   "ADAXBT"],
  ["BTC",  "MATIC", "MATICXBT"],
  ["ETH",  "SOL",   "SOLETH"],
  ["ETH",  "LINK",  "LINKETH"],
  ["ETH",  "ADA",   "ADAETH"],
  ["ETH",  "MATIC", "MATICETH"],
  ["SOL",  "LINK",  "LINKSOL"],
  ["SOL",  "ADA",   "ADASOL"],
  ["SOL",  "MATIC", "MATICSOL"],
  ["LINK", "ADA",   "ADALINK"],
  ["LINK", "MATIC", "MATICLINK"],
  ["ADA",  "MATIC", "MATICADA"],
];

/**
 * Two-way lookup with orientation.
 * In every OB_CROSS_MAP entry [a, b, pair], the Kraken symbol's BASE asset is
 * `b` and its QUOTE asset is `a` (e.g. ["BTC","ETH","ETHXBT"] — ETH base, XBT quote).
 *
 * Going A→B when A is the quote → we BUY the base (walk ASKS).
 * Going A→B when A is the base  → we SELL the base (walk BIDS).
 */
export interface CrossRoute { pair: string; aIsQuote: boolean; }
export const CROSS_LOOKUP = new Map<string, CrossRoute>();
for (const [a, b, pair] of OB_CROSS_MAP) {
  CROSS_LOOKUP.set(`${a}-${b}`, { pair, aIsQuote: true });   // hold quote, buy base
  CROSS_LOOKUP.set(`${b}-${a}`, { pair, aIsQuote: false });  // hold base, sell base
}

// ── Order book fetch with short cache ─────────────────────────────────────────

type Level = [number, number]; // [price, volume]

interface OrderBook { asks: Level[]; bids: Level[]; }

const OB_CACHE_TTL_MS = 5_000; // 5 s — fast enough for live dashboard
const obCache = new Map<string, { book: OrderBook; fetchedAt: number }>();

/**
 * Fetches Kraken public L2 order book (up to `count` levels per side).
 * Port of Python v14 fetch_order_book().
 * Returns null on any network/parse error so callers can skip missing pairs.
 */
export async function fetchOrderBook(pair: string, count = 8): Promise<OrderBook | null> {
  const cached = obCache.get(pair);
  if (cached && Date.now() - cached.fetchedAt < OB_CACHE_TTL_MS) return cached.book;
  try {
    const r = await fetch(
      `https://api.kraken.com/0/public/Depth?pair=${pair}&count=${count}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (!r.ok) return null;
    const data = await r.json() as {
      error?: string[];
      result?: Record<string, { asks: string[][]; bids: string[][] }>;
    };
    if (data.error?.length || !data.result) return null;
    const raw = Object.values(data.result)[0];
    if (!raw) return null;
    const book: OrderBook = {
      asks: raw.asks.map(([p, v]) => [parseFloat(p), parseFloat(v)] as Level),
      bids: raw.bids.map(([p, v]) => [parseFloat(p), parseFloat(v)] as Level),
    };
    obCache.set(pair, { book, fetchedAt: Date.now() });
    return book;
  } catch { return null; }
}

// ── Cycle simulation ──────────────────────────────────────────────────────────

/** v15 status classification for a simulated cycle. */
export type ObCycleStatus = "READY" | "HIGH_SLIPPAGE" | "LOW_PROFIT";

export interface ObCycleEntry {
  route: string;
  assetA: string;
  assetB: string;
  estimatedProfitUsd: number;
  profitPct: number;
  /** Average fill price for leg 1: USD per A */
  avgPriceA: number;
  /** Average fill rate for leg 2: B per A (cross rate) */
  avgCrossRate: number;
  /** Average fill price for leg 3: USD per B */
  avgPriceB: number;
  /** Amount of A acquired in leg 1 (used for execution sizing) */
  volumeA: number;
  /** v15: total execution slippage across 3 legs (avg vs best price), % */
  slippagePct: number;
  /** v15: READY / HIGH_SLIPPAGE / LOW_PROFIT */
  status: ObCycleStatus;
}

export interface ObScanResult {
  cycles: ObCycleEntry[];
  tradeSizeUsd: number;
  feesPct: number;
  /** v15: minimum net profit ($) for READY status */
  minProfitUsd: number;
  /** v15: maximum tolerated total slippage (%) for READY status */
  maxSlippagePct: number;
  /** v15: number of cycles with READY status */
  readyCount: number;
  /** Number of pairs whose order book fetch succeeded */
  pairsScanned: number;
  /** Number of pairs the scan attempted to fetch */
  pairsRequested: number;
  scannedAt: string;
}

/**
 * Port of Python v14 simulate_triangular_cycle().
 * Walks the order book for each leg:
 *   Leg 1 — buy A with USD  → walks ASKS of A/USD
 *   Leg 2 — sell A for B    → walks BIDS of A/B cross pair
 *   Leg 3 — sell B for USD  → walks BIDS of B/USD
 *
 * Returns null when any book is missing or has insufficient depth.
 */
function simulateCycle(
  assetA: ObAsset,
  assetB: ObAsset,
  startUsd: number,
  orderbooks: Map<string, OrderBook>,
  feesPct: number,
): { profitUsd: number; avg1: number; avg2: number; avg3: number; volA: number; slippagePct: number } | null {
  const usdPairA = OB_USD_PAIRS[assetA];
  const usdPairB = OB_USD_PAIRS[assetB];
  const cross    = CROSS_LOOKUP.get(`${assetA}-${assetB}`);
  if (!cross) return null;

  const obAUsd  = orderbooks.get(usdPairA);
  const obCross = orderbooks.get(cross.pair);
  const obBUsd  = orderbooks.get(usdPairB);
  if (!obAUsd || !obCross || !obBUsd) return null;

  // ── Leg 1: Buy A with USD (walk asks of A/USD) ────────────────────────────
  let remainingUsd = startUsd;
  let aAmt = 0;
  let totalSpent = 0;
  for (const [price, vol] of obAUsd.asks) {
    const cost = price * vol;
    if (remainingUsd <= cost) {
      aAmt   += remainingUsd / price;
      totalSpent += remainingUsd;
      remainingUsd = 0;
      break;
    }
    aAmt   += vol;
    totalSpent += cost;
    remainingUsd -= cost;
  }
  // Require a FULL fill — a partial fill is not an executable cycle.
  if (aAmt === 0 || remainingUsd > 0) return null;
  const avg1  = totalSpent / aAmt; // USD per A
  const best1 = obAUsd.asks[0]![0];

  // ── Leg 2: Convert A → B on the cross pair, respecting orientation ───────
  let remainingA = aAmt;
  let bAmt = 0;
  // Best achievable cross rate (B per A) at the top of the relevant side.
  // When buying base with A, ask price is A-per-B → best B-per-A = 1/askTop.
  const crossTop = cross.aIsQuote ? obCross.asks[0] : obCross.bids[0];
  if (!crossTop) return null;
  const best2 = cross.aIsQuote ? 1 / crossTop[0] : crossTop[0];
  if (cross.aIsQuote) {
    // A is the QUOTE asset, B is the BASE: we buy base with A → walk ASKS.
    // Ask price = A per B; vol is in B.
    for (const [price, vol] of obCross.asks) {
      const cost = price * vol; // cost in A
      if (remainingA <= cost) {
        bAmt      += remainingA / price;
        remainingA = 0;
        break;
      }
      bAmt      += vol;
      remainingA -= cost;
    }
  } else {
    // A is the BASE asset, B is the QUOTE: we sell base → walk BIDS.
    // Bid price = B per A; vol is in A.
    for (const [price, vol] of obCross.bids) {
      if (remainingA <= vol) {
        bAmt      += remainingA * price;
        remainingA = 0;
        break;
      }
      bAmt      += vol * price;
      remainingA -= vol;
    }
  }
  if (bAmt === 0 || remainingA > 0) return null;
  const avg2 = bAmt / aAmt; // B per A (cross rate)

  // ── Leg 3: Sell B for USD (walk bids of B/USD) ───────────────────────────
  let remainingB = bAmt;
  let usdFinal = 0;
  for (const [price, vol] of obBUsd.bids) {
    if (remainingB <= vol) {
      usdFinal  += remainingB * price;
      remainingB = 0;
      break;
    }
    usdFinal  += vol * price;
    remainingB -= vol;
  }
  if (usdFinal === 0 || remainingB > 0) return null;
  const avg3  = usdFinal / bAmt; // USD per B
  const best3 = obBUsd.bids[0]![0];

  // Gross profit, then apply flat fee deduction (Python: profit * (1 - feesPct/100))
  const grossProfit = usdFinal - startUsd;
  const netProfit   = grossProfit * (1 - feesPct / 100);

  // v15: total slippage = per-leg |avg − best| / best, summed across 3 legs.
  const slip = (avg: number, best: number) => best > 0 ? Math.abs(avg - best) / best * 100 : 0;
  const slippagePct = slip(avg1, best1) + slip(avg2, best2) + slip(avg3, best3);

  return { profitUsd: netProfit, avg1, avg2, avg3, volA: aAmt, slippagePct };
}

// ── Full scan ─────────────────────────────────────────────────────────────────

/**
 * Port of Python v15 main loop: fetches all order books in parallel and
 * simulates all 30 triangular cycles across 6 assets (A × B permutations).
 * v15: ALL simulatable cycles are ranked (top 15) with a status
 * classification, instead of filtering to profitable ones only.
 * Sorted by estimatedProfitUsd descending.
 */
export async function scanOrderBookCycles(
  tradeSizeUsd   = 10,
  feesPct        = 0.50,
  minProfitUsd   = 0.01,
  maxSlippagePct = 0.50,
): Promise<ObScanResult> {
  // Deduplicated list of all pairs we need
  const allPairs = [...new Set([
    ...Object.values(OB_USD_PAIRS),
    ...OB_CROSS_MAP.map(([,, pair]) => pair),
  ])];

  // Fetch all order books in parallel
  const fetched = await Promise.all(allPairs.map(p => fetchOrderBook(p, 8)));
  const orderbooks = new Map<string, OrderBook>();
  let pairsScanned = 0;
  for (let i = 0; i < allPairs.length; i++) {
    if (fetched[i]) { orderbooks.set(allPairs[i], fetched[i]!); pairsScanned++; }
  }

  // All A≠B permutations
  const cycles: ObCycleEntry[] = [];
  for (const assetA of OB_ASSETS) {
    for (const assetB of OB_ASSETS) {
      if (assetA === assetB) continue;
      const r = simulateCycle(assetA, assetB, tradeSizeUsd, orderbooks, feesPct);
      if (r) {
        // v15 status classification
        let status: ObCycleStatus;
        if (r.profitUsd > minProfitUsd && r.slippagePct <= maxSlippagePct) {
          status = "READY";
        } else if (r.profitUsd > minProfitUsd) {
          status = "HIGH_SLIPPAGE";
        } else {
          status = "LOW_PROFIT";
        }
        cycles.push({
          route:               `USD→${assetA}→${assetB}→USD`,
          assetA,
          assetB,
          estimatedProfitUsd:  r.profitUsd,
          profitPct:           (r.profitUsd / tradeSizeUsd) * 100,
          avgPriceA:           r.avg1,
          avgCrossRate:        r.avg2,
          avgPriceB:           r.avg3,
          volumeA:             r.volA,
          slippagePct:         r.slippagePct,
          status,
        });
      }
    }
  }

  cycles.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
  // readyCount reflects ALL simulatable cycles, computed before top-15 truncation
  const readyCount = cycles.filter(c => c.status === "READY").length;
  const top = cycles.slice(0, 15); // Python v15 shows top 15 ranked

  return {
    cycles: top,
    tradeSizeUsd,
    feesPct,
    minProfitUsd,
    maxSlippagePct,
    readyCount,
    pairsScanned,
    pairsRequested: allPairs.length,
    scannedAt: new Date().toISOString(),
  };
}
