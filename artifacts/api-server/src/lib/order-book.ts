/**
 * v17 "420-Route Hunter" — port of Python v17 (originally v14 simulate_triangular_cycle()).
 *
 * Fetches L2 order book depth from Kraken public Depth API and walks the book
 * level-by-level to get realistic average fill prices at a given trade size.
 * v17: 21 assets (420 A×B permutations), volatility filter (24h change),
 * per-cycle confidence score (top-of-book liquidity coverage).
 *
 * Pairs below are the FULL verified set from Kraken /0/public/AssetPairs
 * (checked 2026-08) — the Python guesses symbol names and lets fetches fail;
 * we only list real pairs. MATIC was delisted from Kraken (no MATICUSD), so it
 * was dropped in v17's asset list. Many v17 assets (AVAX, SUI, HBAR, TON, ARB,
 * OP, NEAR) have NO cross pairs on Kraken — they can't form cycles yet.
 */

// ── Asset definitions ─────────────────────────────────────────────────────────

export const OB_ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "LINK", "DOGE", "AVAX", "SUI", "LTC", "ADA",
  "DOT", "UNI", "AAVE", "NEAR", "ATOM", "HBAR", "TON", "BCH", "FIL", "ARB", "OP",
] as const;
export type ObAsset = typeof OB_ASSETS[number];

/** Kraken REST pair symbols for the USD leg of each asset (verified altnames). */
export const OB_USD_PAIRS: Record<ObAsset, string> = {
  BTC:  "XXBTZUSD",
  ETH:  "ETHUSD",
  SOL:  "SOLUSD",
  XRP:  "XRPUSD",
  LINK: "LINKUSD",
  DOGE: "XDGUSD",  // Kraken's DOGE code is XDG
  AVAX: "AVAXUSD",
  SUI:  "SUIUSD",
  LTC:  "LTCUSD",
  ADA:  "ADAUSD",
  DOT:  "DOTUSD",
  UNI:  "UNIUSD",
  AAVE: "AAVEUSD",
  NEAR: "NEARUSD",
  ATOM: "ATOMUSD",
  HBAR: "HBARUSD",
  TON:  "TONUSD",
  BCH:  "BCHUSD",
  FIL:  "FILUSD",
  ARB:  "ARBUSD",
  OP:   "OPUSD",
};

/**
 * Cross-pair definitions.
 * Layout: [quoteAsset, baseAsset, krakenPairSymbol] — the Kraken symbol's BASE
 * is the second element, QUOTE is the first.
 * Complete verified list of crosses among OB_ASSETS on Kraken (2026-08).
 */
const OB_CROSS_MAP: Array<[ObAsset, ObAsset, string]> = [
  // vs BTC
  ["BTC", "ETH",  "ETHXBT"],
  ["BTC", "SOL",  "SOLXBT"],
  ["BTC", "XRP",  "XRPXBT"],
  ["BTC", "LINK", "LINKXBT"],
  ["BTC", "DOGE", "XDGXBT"],
  ["BTC", "LTC",  "LTCXBT"],
  ["BTC", "ADA",  "ADAXBT"],
  ["BTC", "DOT",  "DOTXBT"],
  ["BTC", "UNI",  "UNIXBT"],
  ["BTC", "AAVE", "AAVEXBT"],
  ["BTC", "ATOM", "ATOMXBT"],
  ["BTC", "BCH",  "BCHXBT"],
  ["BTC", "FIL",  "FILXBT"],
  // vs ETH
  ["ETH", "SOL",  "SOLETH"],
  ["ETH", "XRP",  "XRPETH"],
  ["ETH", "LINK", "LINKETH"],
  ["ETH", "LTC",  "LTCETH"],
  ["ETH", "ADA",  "ADAETH"],
  ["ETH", "DOT",  "DOTETH"],
  ["ETH", "UNI",  "UNIETH"],
  ["ETH", "AAVE", "AAVEETH"],
  ["ETH", "ATOM", "ATOMETH"],
  ["ETH", "BCH",  "BCHETH"],
  ["ETH", "FIL",  "FILETH"],
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

// ── v17: 24h change (volatility filter) ──────────────────────────────────────

/**
 * Kraken's INTERNAL pair keys for assets with legacy X/Z-prefixed codes.
 * The Ticker endpoint keys its result by these even when you request the
 * altname (e.g. requesting ETHUSD returns key XETHZUSD). Assets not listed
 * here use their altname as the internal key too.
 */
const TICKER_INTERNAL_KEYS: Partial<Record<ObAsset, string>> = {
  BTC:  "XXBTZUSD",
  ETH:  "XETHZUSD",
  XRP:  "XXRPZUSD",
  LTC:  "XLTCZUSD",
  DOGE: "XDGUSD", // XDG has no Z-suffixed USD form
};

const TICKER_CACHE_TTL_MS = 60_000;
let tickerCache: { changes: Map<ObAsset, number>; fetchedAt: number } | null = null;

/**
 * Fetches 24h price change % for all assets in ONE batched Ticker request.
 * NOTE: the Python v17 reads ticker field "p" (that's the VWAP, not a change %)
 * — a bug that makes its filter nearly a no-op. We port the stated intent:
 * change % = (last close − today's open) / open × 100.
 * Returns a map; assets missing from the response are simply absent.
 */
export async function get24hChanges(): Promise<Map<ObAsset, number>> {
  if (tickerCache && Date.now() - tickerCache.fetchedAt < TICKER_CACHE_TTL_MS) {
    return tickerCache.changes;
  }
  const changes = new Map<ObAsset, number>();
  try {
    const pairList = Object.values(OB_USD_PAIRS).join(",");
    const r = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${pairList}`,
      { signal: AbortSignal.timeout(4_000) },
    );
    if (!r.ok) return changes;
    const data = await r.json() as {
      error?: string[];
      result?: Record<string, { c: string[]; o: string }>;
    };
    if (data.error?.length || !data.result) return changes;
    for (const [asset, pair] of Object.entries(OB_USD_PAIRS) as Array<[ObAsset, string]>) {
      // Kraken keys the response by INTERNAL pair names (e.g. XETHZUSD for
      // ETHUSD). Try the requested altname first, then the known internal key.
      const t = data.result[pair] ?? data.result[TICKER_INTERNAL_KEYS[asset] ?? ""];
      if (!t) continue;
      const close = parseFloat(t.c?.[0] ?? "");
      const open  = parseFloat(t.o ?? "");
      if (Number.isFinite(close) && Number.isFinite(open) && open > 0) {
        changes.set(asset, ((close - open) / open) * 100);
      }
    }
    if (changes.size > 0) tickerCache = { changes, fetchedAt: Date.now() };
  } catch { /* leave whatever we collected */ }
  return changes;
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
  /**
   * v17: 0–100 liquidity confidence — average top-of-book coverage across the
   * 3 legs (how many times over the best level alone could fill the leg,
   * capped at 100%). Higher = deeper book = more reliable fill estimate.
   * NOTE: the Python computes consumed/available (inverted vs its stated
   * intent); we port the intent.
   */
  confidencePct: number;
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
  /** v17: whether the volatility filter was requested */
  volatilityFilter: boolean;
  /** v17: assets actually scanned after the volatility filter (all if filter off or fallback) */
  activeAssets: string[];
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
): { profitUsd: number; avg1: number; avg2: number; avg3: number; volA: number; slippagePct: number; confidencePct: number } | null {
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

  // v17: liquidity confidence — top-of-book coverage per leg (available/needed,
  // capped at 1), averaged. Needed amounts are denominated in each book's BASE
  // asset units to match the level volumes.
  const coverage = (topVol: number | undefined, needed: number) =>
    topVol && needed > 0 ? Math.min(1, topVol / needed) : 0;
  const cov1 = coverage(obAUsd.asks[0]?.[1], aAmt);                       // leg 1: A units
  const cov2 = cross.aIsQuote
    ? coverage(obCross.asks[0]?.[1], bAmt)                                // buying base B: B units
    : coverage(obCross.bids[0]?.[1], aAmt);                               // selling base A: A units
  const cov3 = coverage(obBUsd.bids[0]?.[1], bAmt);                       // leg 3: B units
  const confidencePct = Math.round(((cov1 + cov2 + cov3) / 3) * 100);

  return { profitUsd: netProfit, avg1, avg2, avg3, volA: aAmt, slippagePct, confidencePct };
}

// ── Full scan ─────────────────────────────────────────────────────────────────

const VOLATILITY_THRESHOLD_PCT = 1.5; // v17: |24h change| must exceed this
const VOLATILITY_MIN_ASSETS    = 3;   // v17: fallback to all assets below this

/**
 * Port of Python v17 main loop: fetches all order books in parallel and
 * simulates all A × B permutations across 21 assets (up to 420 routes;
 * only routes with a real Kraken cross pair are simulatable).
 * v17: optional volatility filter — only assets that moved >1.5% in 24h are
 * scanned (falls back to ALL assets when fewer than 3 qualify).
 * All simulatable cycles are ranked (top 15) with status + confidence.
 * Sorted by estimatedProfitUsd descending.
 */
export async function scanOrderBookCycles(
  tradeSizeUsd   = 10,
  feesPct        = 0.50,
  minProfitUsd   = 0.05, // v16: wait for a real edge (> $0.05 on $10)
  maxSlippagePct = 0.50,
  volatilityFilter = true, // v17
): Promise<ObScanResult> {
  // v17: volatility filter — restrict to assets that actually moved
  let activeAssets: readonly ObAsset[] = OB_ASSETS;
  if (volatilityFilter) {
    const changes = await get24hChanges();
    const moving = OB_ASSETS.filter(a => {
      const chg = changes.get(a);
      return chg !== undefined && Math.abs(chg) > VOLATILITY_THRESHOLD_PCT;
    });
    // Python falls back to all assets only when <3 qualify; we also fall back
    // when the moving set can't form a single triangle (no cross pair among
    // them) — otherwise the scan would return 0 cycles despite a live market.
    const movingSet = new Set(moving);
    const canFormCycle = OB_CROSS_MAP.some(([a, b]) => movingSet.has(a) && movingSet.has(b));
    if (moving.length >= VOLATILITY_MIN_ASSETS && canFormCycle) activeAssets = moving;
  }
  const activeSet = new Set<ObAsset>(activeAssets);

  // Deduplicated list of pairs needed for the active asset set
  const allPairs = [...new Set([
    ...activeAssets.map(a => OB_USD_PAIRS[a]),
    ...OB_CROSS_MAP.filter(([a, b]) => activeSet.has(a) && activeSet.has(b))
                   .map(([,, pair]) => pair),
  ])];

  // Fetch all order books in parallel
  const fetched = await Promise.all(allPairs.map(p => fetchOrderBook(p, 8)));
  const orderbooks = new Map<string, OrderBook>();
  let pairsScanned = 0;
  for (let i = 0; i < allPairs.length; i++) {
    if (fetched[i]) { orderbooks.set(allPairs[i], fetched[i]!); pairsScanned++; }
  }

  // All A≠B permutations among active assets
  const cycles: ObCycleEntry[] = [];
  for (const assetA of activeAssets) {
    for (const assetB of activeAssets) {
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
          confidencePct:       r.confidencePct,
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
    volatilityFilter,
    activeAssets: [...activeAssets],
    scannedAt: new Date().toISOString(),
  };
}
