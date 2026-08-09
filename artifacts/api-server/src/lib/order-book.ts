/**
 * v17 "420-Route Hunter" — port of Python v17 (originally v14 simulate_triangular_cycle()).
 *
 * Fetches L2 order book depth from Kraken public Depth API and walks the book
 * level-by-level to get realistic average fill prices at a given trade size.
 * v17+: 34 assets (A×B permutations), volatility filter (24h change),
 * per-cycle confidence score (top-of-book liquidity coverage).
 *
 * Pairs below are the FULL verified set from Kraken /0/public/AssetPairs
 * (checked 2026-08) — the Python guesses symbol names and lets fetches fail;
 * we only list real pairs. MATIC was delisted from Kraken (no MATICUSD), so it
 * was dropped in v17's asset list. Many v17 assets (AVAX, SUI, HBAR, TON, ARB,
 * OP, NEAR) have NO cross pairs on Kraken — they can't form cycles yet.
 */

import { getStreamBook, onBookUpdate, startKrakenBookStream, startCoinbaseTickerStream, krakenStreamStats } from "./book-stream";

// ── Asset definitions ─────────────────────────────────────────────────────────

export const OB_ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "LINK", "DOGE", "AVAX", "SUI", "LTC", "ADA",
  "DOT", "UNI", "AAVE", "NEAR", "ATOM", "HBAR", "TON", "BCH", "FIL", "ARB", "OP",
  "PEPE", "WIF", "BONK", "INJ", "SEI", "APT", "LDO", "FET", "RNDR",
  "TAO", "GALA", "BEAM", "JUP",
  // MKR intentionally excluded — Kraken has no MKR pairs anymore (Maker→SKY migration)
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
  PEPE: "PEPEUSD",
  WIF:  "WIFUSD",
  BONK: "BONKUSD",
  INJ:  "INJUSD",
  SEI:  "SEIUSD",
  APT:  "APTUSD",
  LDO:  "LDOUSD",
  FET:  "FETUSD",
  RNDR: "RENDERUSD", // Kraken renamed the asset RNDR→RENDER
  TAO:  "TAOUSD",
  GALA: "GALAUSD",
  BEAM: "BEAMUSD",
  JUP:  "JUPUSD",
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

/** Hardcoded fallback CROSS_LOOKUP — used when AssetPairs discovery fails. */
export const CROSS_LOOKUP = new Map<string, CrossRoute>();
for (const [a, b, pair] of OB_CROSS_MAP) {
  CROSS_LOOKUP.set(`${a}-${b}`, { pair, aIsQuote: true });   // hold quote, buy base
  CROSS_LOOKUP.set(`${b}-${a}`, { pair, aIsQuote: false });  // hold base, sell base
}

// ── Dynamic cross-pair discovery via Kraken /0/public/AssetPairs ─────────────

/**
 * Maps Kraken wsname components (e.g. "XBT", "RENDER") to our ObAsset names.
 * The wsname field in AssetPairs uses these cleaner symbols rather than
 * Kraken's internal codes (XXBT, XETH, etc.) or the full altnames.
 */
const KRAKEN_WS_TO_ASSET: Partial<Record<string, ObAsset>> = {
  XBT:    "BTC",  ETH:    "ETH",  SOL:    "SOL",  XRP:    "XRP",
  LINK:   "LINK", XDG:    "DOGE", DOGE:   "DOGE", AVAX:   "AVAX",
  SUI:    "SUI",  LTC:    "LTC",  ADA:    "ADA",  DOT:    "DOT",
  UNI:    "UNI",  AAVE:   "AAVE", NEAR:   "NEAR", ATOM:   "ATOM",
  HBAR:   "HBAR", TON:    "TON",  BCH:    "BCH",  FIL:    "FIL",
  ARB:    "ARB",  OP:     "OP",   PEPE:   "PEPE", WIF:    "WIF",
  BONK:   "BONK", INJ:    "INJ",  SEI:    "SEI",  APT:    "APT",
  LDO:    "LDO",  FET:    "FET",  RENDER: "RNDR", RNDR:   "RNDR",
  TAO:    "TAO",  GALA:   "GALA", BEAM:   "BEAM", JUP:    "JUP",
};

/** Fiat / stablecoin quote assets to exclude when looking for crypto cross pairs. */
const FIAT_WSNAMES = new Set([
  "USD", "ZUSD", "EUR", "ZEUR", "GBP", "ZGBP", "CAD", "ZCAD",
  "JPY", "ZJPY", "CHF", "ZCHF", "AUD", "ZAUD", "USDT", "USDC",
]);

interface DiscoveredCrossPairs {
  lookup:   Map<string, CrossRoute>;
  crossMap: Array<[ObAsset, ObAsset, string]>;
  cachedAt: number;
}

const ASSET_PAIRS_CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour — pairs rarely change
let crossPairsCache: DiscoveredCrossPairs | null = null;

/** Exposed for tests only — clears the module-level discovery cache. */
export function _testOnly_clearCrossCache(): void { crossPairsCache = null; }

/**
 * Queries Kraken /0/public/AssetPairs and returns a CROSS_LOOKUP covering ALL
 * real cross pairs among OB_ASSETS.  Result is cached for 1 hour.
 *
 * Orientation rule (same as the hardcoded map):
 *   entry [quoteAsset, baseAsset, altname]
 *   → quoteAsset-baseAsset: aIsQuote=true  (buy base)
 *   → baseAsset-quoteAsset: aIsQuote=false (sell base)
 *
 * Falls back to the hardcoded CROSS_LOOKUP / OB_CROSS_MAP on any error.
 *
 * @param forceRefresh — bypass the cache and re-query Kraken now. On failure
 * the previous cache (if any) is kept so a failed forced refresh never
 * downgrades the scanner to the hardcoded fallback.
 */
export async function discoverCrossPairs(forceRefresh = false): Promise<DiscoveredCrossPairs> {
  if (!forceRefresh && crossPairsCache && Date.now() - crossPairsCache.cachedAt < ASSET_PAIRS_CACHE_TTL_MS) {
    return crossPairsCache;
  }
  try {
    const r = await fetch("https://api.kraken.com/0/public/AssetPairs", {
      signal: AbortSignal.timeout(6_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as {
      error?: string[];
      result?: Record<string, {
        altname: string;
        wsname?:  string;
        base:     string;
        quote:    string;
        status:   string;
      }>;
    };
    if (data.error?.length || !data.result) throw new Error("API error");

    const crossMap: Array<[ObAsset, ObAsset, string]> = [];
    const lookup   = new Map<string, CrossRoute>();

    for (const pairInfo of Object.values(data.result)) {
      if (pairInfo.status !== "online") continue;
      const wsname = pairInfo.wsname;
      if (!wsname) continue;

      const slash = wsname.indexOf("/");
      if (slash < 0) continue;
      const wBase  = wsname.slice(0, slash);
      const wQuote = wsname.slice(slash + 1);

      // Skip fiat / stablecoin quotes — we want pure crypto cross pairs.
      if (FIAT_WSNAMES.has(wBase) || FIAT_WSNAMES.has(wQuote)) continue;

      const assetBase  = KRAKEN_WS_TO_ASSET[wBase];
      const assetQuote = KRAKEN_WS_TO_ASSET[wQuote];
      if (!assetBase || !assetQuote) continue;

      // Use the REST altname as the pair symbol for order-book fetches.
      const pairSymbol = pairInfo.altname;

      // Layout: [quoteAsset, baseAsset, pairSymbol] — matches OB_CROSS_MAP convention.
      crossMap.push([assetQuote, assetBase, pairSymbol]);
      lookup.set(`${assetQuote}-${assetBase}`, { pair: pairSymbol, aIsQuote: true  });
      lookup.set(`${assetBase}-${assetQuote}`, { pair: pairSymbol, aIsQuote: false });
    }

    if (lookup.size > 0) {
      const result: DiscoveredCrossPairs = { lookup, crossMap, cachedAt: Date.now() };
      crossPairsCache = result;
      console.log(`[OB] AssetPairs discovery: ${crossMap.length} crypto cross pairs among OB_ASSETS`);
      // Validate precision metadata for every newly-discovered tradable pair —
      // orders on a pair without metadata are refused at submission time.
      void import("./exchange").then(({ validateKrakenPrecision }) =>
        validateKrakenPrecision([...new Set([...lookup.values()].map(c => c.pair))]).then(missing => {
          if (missing.length) console.error(`[OB] ⚠️ Kraken precision metadata MISSING for discovered cross pairs: ${missing.join(", ")} — live orders on these will be refused`);
        }),
      ).catch(err => console.warn("[OB] cross-pair precision validation failed:", err));
      return result;
    }
    throw new Error("discovery returned 0 cross pairs");
  } catch (err) {
    // On a failed FORCED refresh, keep serving the previous good cache rather
    // than downgrading to the hardcoded fallback.
    if (crossPairsCache) {
      console.warn("[OB] AssetPairs refresh failed — keeping previous discovered set:", err);
      return crossPairsCache;
    }
    console.warn("[OB] AssetPairs discovery failed — using hardcoded fallback:", err);
    // Return a cache-skipping wrapper so each scan retries on the next call
    // (but use the hardcoded map in the meantime).
    return { lookup: CROSS_LOOKUP, crossMap: OB_CROSS_MAP, cachedAt: 0 };
  }
}

// ── Background cross-pair auto-refresh ────────────────────────────────────────

const CROSS_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1_000; // 4 hours
const CROSS_REFRESH_RETRY_MS    = 10 * 60 * 1_000;     // retry sooner on failure

let crossRefreshTimer: NodeJS.Timeout | null = null;

/**
 * Starts a background loop that force-refreshes the discovered cross-pair
 * list every 4 hours (retrying after 10 minutes when Kraken is unreachable),
 * so new Kraken listings appear without a server restart. Idempotent.
 */
export function startCrossPairsAutoRefresh(): void {
  if (crossRefreshTimer) return;
  const tick = async (): Promise<void> => {
    let ok = false;
    try {
      const d = await discoverCrossPairs(true);
      // cachedAt > 0 means a real discovered set (fresh or previous good cache)
      ok = d.cachedAt > 0;
    } catch { /* discoverCrossPairs never throws, but be safe */ }
    const delay = ok ? CROSS_REFRESH_INTERVAL_MS : CROSS_REFRESH_RETRY_MS;
    crossRefreshTimer = setTimeout(() => { void tick(); }, delay);
    crossRefreshTimer.unref?.();
  };
  // First refresh happens one full interval from startup — the first scan's
  // own discoverCrossPairs() call populates the cache immediately anyway.
  crossRefreshTimer = setTimeout(() => { void tick(); }, CROSS_REFRESH_INTERVAL_MS);
  crossRefreshTimer.unref?.();
  console.log(`[OB] Cross-pair auto-refresh started (every ${CROSS_REFRESH_INTERVAL_MS / 3_600_000}h)`);
}

// ── Dynamic scan universe via Kraken /0/public/AssetPairs ────────────────────
//
// The static OB_ASSETS / OB_USD_PAIRS above are the hand-verified set that the
// WS book stream subscribes to (see startBookStreamLayer). For DISCOVERY we
// scan a much broader, dynamically-derived universe: EVERY online USD-quoted
// pair on Kraken, plus every online crypto cross pair between two assets that
// both have a USD pair (so a triangle can round-trip to USD).
//
// Money-safety: dynamic-only pairs are NOT subscribed on the WS feed (that
// would mean hundreds of book channels). They are priced from the REST depth
// fallback in fetchOrderBook, and the graph engine marks any route touching a
// non-stream pair as research-only. When AssetPairs is unreachable we fall
// back to the static set and never crash.

/** One dynamically-discovered USD-quoted pair. `asset` is our cleaned symbol
 *  (wsname base), `pair` the REST altname used for Depth fetches. */
export interface DynUsdPair { asset: string; pair: string; wsBase: string; }

/** One dynamically-discovered crypto cross pair between two USD-quoted assets.
 *  Orientation matches CrossRoute: buying `base` costs `quote`. */
export interface DynCrossPair { base: string; quote: string; pair: string; }

export interface DynamicUniverse {
  /** All online USD-quoted pairs (asset → REST altname). */
  usdPairs: Map<string, string>;
  /** All online crypto cross pairs among USD-quoted assets. */
  crossPairs: DynCrossPair[];
  /** Cross lookup (same orientation convention as CROSS_LOOKUP), keyed by
   *  cleaned asset symbols "A-B". */
  crossLookup: Map<string, CrossRoute>;
  /** 0 when this is the static fallback; epoch-ms of the successful fetch otherwise. */
  cachedAt: number;
  /** true when derived live from AssetPairs; false when the static fallback. */
  fromDiscovery: boolean;
}

const DYN_UNIVERSE_TTL_MS = 6 * 60 * 60 * 1_000; // refresh every 6 hours
let dynUniverseCache: DynamicUniverse | null = null;

/** Exposed for tests only — clears the dynamic-universe cache. */
export function _testOnly_clearDynUniverse(): void { dynUniverseCache = null; }

/** Build the static-set fallback universe from OB_ASSETS / OB_USD_PAIRS /
 *  OB_CROSS_MAP so the scanner keeps working when AssetPairs is unreachable. */
function staticUniverse(): DynamicUniverse {
  const usdPairs = new Map<string, string>();
  for (const a of OB_ASSETS) usdPairs.set(a, OB_USD_PAIRS[a]);
  const crossPairs: DynCrossPair[] = OB_CROSS_MAP.map(([quote, base, pair]) => ({ base, quote, pair }));
  const crossLookup = new Map(CROSS_LOOKUP);
  return { usdPairs, crossPairs, crossLookup, cachedAt: 0, fromDiscovery: false };
}

/**
 * Returns the dynamic scan universe (cached 6h). Queries Kraken AssetPairs for
 * every online USD-quoted pair and every online crypto cross pair among those
 * USD-quoted assets. Falls back to the static set on any error (logged, never
 * throws). `asset` symbols are the wsname base (e.g. "XBT", "RENDER") so they
 * are stable identifiers — they are NOT mapped to OB_ASSETS names.
 */
export async function getDynamicUniverse(forceRefresh = false): Promise<DynamicUniverse> {
  if (!forceRefresh && dynUniverseCache && Date.now() - dynUniverseCache.cachedAt < DYN_UNIVERSE_TTL_MS && dynUniverseCache.fromDiscovery) {
    return dynUniverseCache;
  }
  try {
    const r = await fetch("https://api.kraken.com/0/public/AssetPairs", { signal: AbortSignal.timeout(6_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as {
      error?: string[];
      result?: Record<string, { altname: string; wsname?: string; base: string; quote: string; status: string }>;
    };
    if (data.error?.length || !data.result) throw new Error("API error");

    const usdPairs   = new Map<string, string>();
    const crossPairs: DynCrossPair[] = [];
    const crossLookup = new Map<string, CrossRoute>();
    // First pass: collect every online USD-quoted pair.
    const usdQuoteNames = new Set(["USD", "ZUSD"]);
    const pairs: Array<{ wBase: string; wQuote: string; altname: string }> = [];
    for (const info of Object.values(data.result)) {
      if (info.status !== "online" || !info.wsname) continue;
      const slash = info.wsname.indexOf("/");
      if (slash < 0) continue;
      const wBase  = info.wsname.slice(0, slash);
      const wQuote = info.wsname.slice(slash + 1);
      pairs.push({ wBase, wQuote, altname: info.altname });
      if (usdQuoteNames.has(wQuote) && !FIAT_WSNAMES.has(wBase)) {
        // Keep the first altname seen for an asset (Kraken lists e.g. XBTUSD once).
        if (!usdPairs.has(wBase)) usdPairs.set(wBase, info.altname);
      }
    }
    if (usdPairs.size === 0) throw new Error("discovery returned 0 USD pairs");

    // Second pass: crypto cross pairs where BOTH legs have a USD pair.
    for (const { wBase, wQuote, altname } of pairs) {
      if (FIAT_WSNAMES.has(wBase) || FIAT_WSNAMES.has(wQuote)) continue;
      if (!usdPairs.has(wBase) || !usdPairs.has(wQuote)) continue;
      crossPairs.push({ base: wBase, quote: wQuote, pair: altname });
      crossLookup.set(`${wQuote}-${wBase}`, { pair: altname, aIsQuote: true });  // hold quote, buy base
      crossLookup.set(`${wBase}-${wQuote}`, { pair: altname, aIsQuote: false }); // hold base, sell base
    }

    const universe: DynamicUniverse = { usdPairs, crossPairs, crossLookup, cachedAt: Date.now(), fromDiscovery: true };
    dynUniverseCache = universe;
    console.log(`[OB] Dynamic universe: ${usdPairs.size} USD pairs, ${crossPairs.length} crypto cross pairs`);
    return universe;
  } catch (err) {
    if (dynUniverseCache) {
      console.warn("[OB] Dynamic-universe refresh failed — keeping previous set:", err);
      return dynUniverseCache;
    }
    console.warn("[OB] Dynamic-universe discovery failed — using static fallback:", err);
    return staticUniverse();
  }
}

// ── Background dynamic-universe auto-refresh (every 6h) ───────────────────────

const DYN_UNIVERSE_RETRY_MS = 10 * 60 * 1_000;
let dynUniverseTimer: NodeJS.Timeout | null = null;

/** Starts a background loop that force-refreshes the dynamic scan universe
 *  every 6 hours (retry after 10 min on failure). Idempotent. */
export function startDynamicUniverseAutoRefresh(): void {
  if (dynUniverseTimer) return;
  const tick = async (): Promise<void> => {
    let ok = false;
    try { ok = (await getDynamicUniverse(true)).fromDiscovery; } catch { /* never throws */ }
    const delay = ok ? DYN_UNIVERSE_TTL_MS : DYN_UNIVERSE_RETRY_MS;
    dynUniverseTimer = setTimeout(() => { void tick(); }, delay);
    dynUniverseTimer.unref?.();
  };
  dynUniverseTimer = setTimeout(() => { void tick(); }, DYN_UNIVERSE_TTL_MS);
  dynUniverseTimer.unref?.();
  console.log(`[OB] Dynamic-universe auto-refresh started (every ${DYN_UNIVERSE_TTL_MS / 3_600_000}h)`);
}

// ── Live stream layer + event-driven scanning ─────────────────────────────────

/** Latest event-driven scan result — recomputed from in-memory stream books
 *  whenever a relevant bid/ask changes (debounced), NOT on a poll timer. */
export interface EventScan {
  computedAtMs: number;
  /** Timestamp of the book update that triggered this recompute. */
  marketUpdateMs: number;
  /** market update → routes recomputed (detection latency). */
  detectLatencyMs: number;
  updatesSeen: number;
  scansRun: number;
  topRoutes: Array<{ assetA: ObAsset; assetB: ObAsset; netProfitUsd: number }>;
}
let latestEventScan: EventScan | null = null;
export function getEventScan(): EventScan | null { return latestEventScan; }
export { getStreamBook, krakenStreamStats };

const EVENT_SCAN_SIZE_USD = Number(process.env.STREAM_SCAN_SIZE_USD ?? 10);
const EVENT_SCAN_FEE_PCT = 0.40;   // conservative taker tier for detection ranking
const EVENT_SCAN_DEBOUNCE_MS = 100; // coalesce bursts; recompute ≤10×/s

let eventScanDirty = false;
let eventScanTriggerMs = 0;
let eventUpdatesSeen = 0;
let eventScansRun = 0;
let eventScanTimer: NodeJS.Timeout | null = null;
let eventScanRunning = false;

/** Recompute all Kraken triangle cycles from IN-MEMORY stream books only. */
async function runEventScan(): Promise<void> {
  if (eventScanRunning) { eventScanDirty = true; return; }
  eventScanRunning = true;
  const trigger = eventScanTriggerMs;
  try {
    const { lookup, crossMap } = await discoverCrossPairs(); // cached; no network in steady state
    const books = new Map<string, OrderBook>();
    const routes: EventScan["topRoutes"] = [];
    for (const [a, b] of crossMap) {
      const cross = lookup.get(`${a}-${b}`);
      if (!cross) continue;
      for (const p of [OB_USD_PAIRS[a], cross.pair, OB_USD_PAIRS[b]]) {
        if (!books.has(p)) {
          const sb = getStreamBook(p);
          if (sb) books.set(p, { asks: sb.asks, bids: sb.bids });
        }
      }
      const sim = simulateCycle(a, b, EVENT_SCAN_SIZE_USD, books, EVENT_SCAN_FEE_PCT, lookup);
      if (sim) routes.push({ assetA: a, assetB: b, netProfitUsd: sim.profitUsd });
    }
    routes.sort((x, y) => y.netProfitUsd - x.netProfitUsd);
    const now = Date.now();
    eventScansRun++;
    latestEventScan = {
      computedAtMs: now,
      marketUpdateMs: trigger,
      detectLatencyMs: trigger ? now - trigger : 0,
      updatesSeen: eventUpdatesSeen,
      scansRun: eventScansRun,
      topRoutes: routes.slice(0, 5),
    };
    const best = routes[0];
    if (best && best.netProfitUsd > 0) {
      console.log(`[LATENCY] market update → opportunity detected: ${latestEventScan.detectLatencyMs}ms — USD→${best.assetA}→${best.assetB}→USD net $${best.netProfitUsd.toFixed(4)} @ $${EVENT_SCAN_SIZE_USD}`);
    }
  } catch { /* event scan must never crash the stream */ }
  eventScanRunning = false;
  if (eventScanDirty) { eventScanDirty = false; scheduleEventScan(); }
}

function scheduleEventScan(): void {
  if (eventScanTimer) return;
  eventScanTimer = setTimeout(() => { eventScanTimer = null; void runEventScan(); }, EVENT_SCAN_DEBOUNCE_MS);
  eventScanTimer.unref?.();
}

/**
 * Starts the WebSocket book streams (Kraken depth-10 books for every scanner
 * pair, Coinbase public ticker for streaming bid/ask) and the event-driven
 * scanner that recalculates routes the moment a relevant bid/ask changes.
 */
export async function startBookStreamLayer(): Promise<void> {
  const pairs = new Set<string>(Object.values(OB_USD_PAIRS));
  try {
    const { lookup } = await discoverCrossPairs();
    for (const c of lookup.values()) pairs.add(c.pair);
  } catch { /* fall back to USD pairs only; cross refresh will extend later */ }
  onBookUpdate(() => {
    eventUpdatesSeen++;
    eventScanTriggerMs = Date.now();
    scheduleEventScan();
  });
  await startKrakenBookStream([...pairs]);
  startCoinbaseTickerStream(OB_ASSETS.map(a => `${a}-USD`));
}

// ── Order book fetch with short cache ─────────────────────────────────────────

type Level = [number, number]; // [price, volume]

interface OrderBook { asks: Level[]; bids: Level[]; }

const OB_CACHE_TTL_MS = 5_000; // 5 s — REST fallback cache when the stream is down
const obCache = new Map<string, { book: OrderBook; fetchedAt: number }>();

/** Max age for a STREAM book to be preferred over REST in general reads.
 *  Kraken heartbeats ~1s; a quiet-but-connected book older than this falls
 *  back to REST out of caution. */
const STREAM_READ_MAX_AGE_MS = 2_000;

/** One timestamped snapshot — scanner and executor read the SAME object. */
export interface BookSnapshot { book: OrderBook; updatedAtMs: number; ageMs: number; source: "stream" | "rest"; }

/** Stream-first snapshot for one pair. `streamMaxAgeMs` bounds acceptable
 *  stream age; when the stream can't serve it and `allowRest` is true, falls
 *  back to a REST fetch (cache-bypassing). Returns null otherwise. */
export async function bookSnapshot(pair: string, streamMaxAgeMs: number, allowRest: boolean): Promise<BookSnapshot | null> {
  const sb = getStreamBook(pair);
  if (sb && sb.ageMs <= streamMaxAgeMs) return { book: { asks: sb.asks, bids: sb.bids }, updatedAtMs: sb.updatedAtMs, ageMs: sb.ageMs, source: "stream" };
  if (!allowRest) return null;
  obCache.delete(pair);
  const book = await fetchOrderBook(pair, 10);
  if (!book) return null;
  return { book, updatedAtMs: Date.now(), ageMs: 0, source: "rest" };
}

/**
 * Fetches Kraken public L2 order book (up to `count` levels per side).
 * Stream-first: a live WebSocket book fresher than 2s is returned with zero
 * network cost; REST (with a 5s cache) is the fallback.
 * Returns null on any network/parse error so callers can skip missing pairs.
 */
export async function fetchOrderBook(pair: string, count = 8): Promise<OrderBook | null> {
  const sb = getStreamBook(pair);
  if (sb && sb.ageMs <= STREAM_READ_MAX_AGE_MS) return { asks: sb.asks, bids: sb.bids };
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
  /** Raw triangle edge in $ before fees (order-book slippage already included) */
  grossProfitUsd: number;
  /** Total 3-leg fee drag in $ at the scan's per-leg fee rate */
  feeUsd: number;
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
  /** v20: number of legs in the route — 3 (USD→A→B→USD) or 4 (USD→A→M→B→USD) */
  legs: number;
  /** v21: full asset chain between the USD legs, e.g. [A] crosses [B] or [A, M1, M2] — pass to ob-execute for 4-leg routes */
  path: string[];
}

/** v18: scaling analysis status at a given trade size. */
export type ObScalingStatus = "VIABLE" | "HIGH_SLIPPAGE" | "REJECTED";

/** v18: one row of the top-route scaling table. */
export interface ObScalingRow {
  sizeUsd: number;
  profitUsd: number;
  slippagePct: number;
  confidencePct: number;
  /** VIABLE: profit > minProfitUsd×(size/10) and slippage ≤ max; HIGH_SLIPPAGE: profitable but slippage too high; REJECTED otherwise */
  status: ObScalingStatus;
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
  /** v18: route of the top-ranked cycle the scaling table was computed for (null when no cycles) */
  scalingRoute: string | null;
  /** v18: top route re-simulated at $10/$50/$100/$500/$1,000; sizes the book can't absorb are omitted */
  scaling: ObScalingRow[];
  /** v19: number of crypto cross pairs discovered via Kraken AssetPairs (0 = hardcoded fallback) */
  crossPairsDiscovered: number;
  scannedAt: string;
}

interface CycleSimResult {
  profitUsd: number;
  grossProfitUsd: number;
  feeUsd: number;
  avg1: number;
  avg2: number;
  avg3: number;
  volA: number;
  slippagePct: number;
  confidencePct: number;
  legs: number;
  /** Per-leg pricing diagnostic: pair, side, top-of-book and VWAP price in the
   *  pair's native quote units. Lets scanner and pre-fire assert they priced
   *  the same route the same way on the same books. */
  legDiag: LegDiag[];
}

export interface LegDiag { pair: string; side: "buy" | "sell"; topPx: number; vwapPx: number }

/** Per-leg |avg − best| / best in %. */
const slip = (avg: number, best: number) => best > 0 ? Math.abs(avg - best) / best * 100 : 0;

/** Top-of-book coverage: available/needed capped at 1 (0 when unknown). */
const coverage = (topVol: number | undefined, needed: number) =>
  topVol && needed > 0 ? Math.min(1, topVol / needed) : 0;

/**
 * v20 generic USD-anchored cycle simulator (superset of Python v14
 * simulate_triangular_cycle()). `path` is the chain of crypto assets between
 * the two USD legs — [A, B] for a 3-leg triangle, [A, M1, M2] for a 4-leg run.
 * Walks the order book for each leg:
 *   Leg 1        — buy path[0] with USD          → walks ASKS of path[0]/USD
 *   Cross leg(s) — convert path[i] → path[i+1]   → walks ASKS or BIDS of the
 *                  cross pair depending on orientation
 *   Final leg    — sell path[last] for USD       → walks BIDS of path[last]/USD
 *
 * Returns null when any book/cross pair is missing or has insufficient depth.
 */
function simulatePath(
  path: ObAsset[],
  startUsd: number,
  orderbooks: Map<string, OrderBook>,
  feesPct: number,
  crossLookup: Map<string, CrossRoute> = CROSS_LOOKUP,
): CycleSimResult | null {
  if (path.length < 2) return null;
  const first = path[0]!;
  const last  = path[path.length - 1]!;
  const obFirst = orderbooks.get(OB_USD_PAIRS[first]);
  const obLast  = orderbooks.get(OB_USD_PAIRS[last]);
  if (!obFirst || !obLast) return null;

  // ── Leg 1: Buy path[0] with USD (walk asks) ───────────────────────────────
  let remainingUsd = startUsd;
  let aAmt = 0;
  let totalSpent = 0;
  for (const [price, vol] of obFirst.asks) {
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
  const legDiag: LegDiag[] = [{ pair: OB_USD_PAIRS[first], side: "buy", topPx: obFirst.asks[0]![0], vwapPx: avg1 }];
  let slippagePct = slip(avg1, obFirst.asks[0]![0]);
  let covSum = coverage(obFirst.asks[0]?.[1], aAmt); // leg 1: A units

  // ── Cross legs: convert path[i] → path[i+1], respecting orientation ──────
  let holding = aAmt;          // amount of path[i] currently held
  let firstCrossRate = 0;      // avg rate of the FIRST cross leg (B per A)
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i]!;
    const to   = path[i + 1]!;
    const cross = crossLookup.get(`${from}-${to}`);
    if (!cross) return null;
    const obCross = orderbooks.get(cross.pair);
    if (!obCross) return null;

    // Best achievable cross rate (to-per-from) at the top of the relevant side.
    // When buying base with `from`, ask price is from-per-to → best = 1/askTop.
    const crossTop = cross.aIsQuote ? obCross.asks[0] : obCross.bids[0];
    if (!crossTop) return null;
    const best = cross.aIsQuote ? 1 / crossTop[0] : crossTop[0];

    let remaining = holding;
    let outAmt = 0;
    if (cross.aIsQuote) {
      // `from` is the QUOTE asset, `to` is the BASE: buy base → walk ASKS.
      // Ask price = from per to; vol is in `to`.
      for (const [price, vol] of obCross.asks) {
        const cost = price * vol; // cost in `from`
        if (remaining <= cost) {
          outAmt   += remaining / price;
          remaining = 0;
          break;
        }
        outAmt   += vol;
        remaining -= cost;
      }
    } else {
      // `from` is the BASE asset, `to` is the QUOTE: sell base → walk BIDS.
      // Bid price = to per from; vol is in `from`.
      for (const [price, vol] of obCross.bids) {
        if (remaining <= vol) {
          outAmt   += remaining * price;
          remaining = 0;
          break;
        }
        outAmt   += vol * price;
        remaining -= vol;
      }
    }
    if (outAmt === 0 || remaining > 0) return null;
    const avg = outAmt / holding; // `to` per `from`
    // Book-native VWAP: buy → quote-per-base (spent/received); sell → bid px.
    legDiag.push({ pair: cross.pair, side: cross.aIsQuote ? "buy" : "sell", topPx: crossTop[0], vwapPx: cross.aIsQuote ? holding / outAmt : avg });
    slippagePct += slip(avg, best);
    covSum += cross.aIsQuote
      ? coverage(obCross.asks[0]?.[1], outAmt)   // buying base `to`: `to` units
      : coverage(obCross.bids[0]?.[1], holding); // selling base `from`: `from` units
    if (i === 0) firstCrossRate = avg;
    holding = outAmt;
  }

  // ── Final leg: Sell path[last] for USD (walk bids) ────────────────────────
  let remainingB = holding;
  let usdFinal = 0;
  for (const [price, vol] of obLast.bids) {
    if (remainingB <= vol) {
      usdFinal  += remainingB * price;
      remainingB = 0;
      break;
    }
    usdFinal  += vol * price;
    remainingB -= vol;
  }
  if (usdFinal === 0 || remainingB > 0) return null;
  const avg3 = usdFinal / holding; // USD per final asset
  legDiag.push({ pair: OB_USD_PAIRS[last], side: "sell", topPx: obLast.bids[0]![0], vwapPx: avg3 });
  slippagePct += slip(avg3, obLast.bids[0]![0]);
  covSum += coverage(obLast.bids[0]?.[1], holding); // final leg: last-asset units

  const legs = path.length + 1; // USD legs on both ends + crosses

  // Fees apply PER LEG on the traded notional, not on the profit. (The Python
  // formula `profit * (1 - fee%)` deducted fees from the few-cent profit —
  // fractions of a cent — while Kraken actually charges fee% of each leg's
  // notional, ~legs × size × fee%. That bug made losing cycles look green.)
  // feesPct is the per-leg taker fee in percent (Kraken base tier: 0.40%).
  const grossProfit = usdFinal - startUsd;
  const feeUsd      = (feesPct / 100) * (startUsd * (legs - 1) + usdFinal); // each leg ≈ startUsd notional; last leg = usdFinal
  const netProfit   = grossProfit - feeUsd;

  const confidencePct = Math.round((covSum / legs) * 100);

  return { profitUsd: netProfit, grossProfitUsd: grossProfit, feeUsd, avg1, avg2: firstCrossRate, avg3, volA: aAmt, slippagePct, confidencePct, legs, legDiag };
}

/** 3-leg triangle: USD→A→B→USD. Thin wrapper over the generic path simulator. */
function simulateCycle(
  assetA: ObAsset,
  assetB: ObAsset,
  startUsd: number,
  orderbooks: Map<string, OrderBook>,
  feesPct: number,
  crossLookup: Map<string, CrossRoute> = CROSS_LOOKUP,
): CycleSimResult | null {
  return simulatePath([assetA, assetB], startUsd, orderbooks, feesPct, crossLookup);
}

// ── v18: manual execution pre-flight ─────────────────────────────────────────

/**
 * Execution plan for one leg: Kraken pair, side, volume in the pair's BASE
 * asset, and maker limit price (best bid for buys, best ask for sells).
 */
export interface ObExecutionLeg { pair: string; side: "buy" | "sell"; volume: number; limitPrice: number; }

export interface ObPreflightResult {
  profitUsd: number;
  slippagePct: number;
  confidencePct: number;
  /** Orientation-aware legs ready for AddOrder (volumes in each pair's base asset). */
  legs: [ObExecutionLeg, ObExecutionLeg, ObExecutionLeg];
  volumeA: number;
  volumeB: number;
}

/** Generic path pre-flight result: one execution leg per hop (USD entry,
 *  crosses, USD exit) plus the per-asset holdings chain used for sizing. */
export interface ObPathPreflightResult {
  profitUsd: number;
  slippagePct: number;
  confidencePct: number;
  /** path.length + 1 orientation-aware legs ready for AddOrder. */
  legs: ObExecutionLeg[];
  /** volumes[i] = amount of path[i] held after acquiring it (pricing-model based). */
  volumes: number[];
}

/**
 * v21 generic manual-execute pre-flight for a USD-anchored asset path
 * (USD→path[0]→…→path[last]→USD). Re-fetches FRESH order books (cache
 * bypassed) for every pair in the route and re-simulates at the given size.
 * Supports 3-leg triangles ([A, B]) and 4-leg routes ([A, M1, M2]).
 * Returns null when books can't be fetched, a cross pair is missing, or
 * depth can't absorb the size.
 */
export async function preflightObPath(
  path: ObAsset[],
  sizeUsd: number,
  feesPct: number,
  pricing: "maker" | "taker" = "taker",
  /** Trader's freshness window: when set, ALL legs must come from the live
   *  stream within this age (exchange-timestamp based) — REST is never used
   *  and one stale leg fails the whole preflight (returns null). */
  maxQuoteAgeMs?: number,
): Promise<ObPathPreflightResult | null> {
  if (path.length < 2 || path.length > 3) return null; // 3- and 4-leg routes only
  // v19: use the same dynamically-discovered cross map so preflight covers
  // pairs that aren't in the hardcoded fallback.
  const { lookup: activeLookup } = await discoverCrossPairs();
  const crosses: CrossRoute[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const c = activeLookup.get(`${path[i]}-${path[i + 1]}`);
    if (!c) return null;
    crosses.push(c);
  }
  const pairFirst = OB_USD_PAIRS[path[0]!];
  const pairLast  = OB_USD_PAIRS[path[path.length - 1]!];
  const pairKeys  = [pairFirst, ...crosses.map(c => c.pair), pairLast];

  // Freshest books: strict mode (maxQuoteAgeMs set) = stream-only within the
  // trader's window, any stale leg → whole route stale (null). Legacy mode =
  // stream <400ms or cache-bypassing REST.
  const strict = maxQuoteAgeMs != null;
  const winMs = maxQuoteAgeMs ?? 400;
  const snaps = await Promise.all(pairKeys.map(p => bookSnapshot(p, winMs, !strict)));
  if (snaps.some(s => !s)) return null;
  const books = new Map<string, OrderBook>();
  pairKeys.forEach((p, i) => { if (!books.has(p)) books.set(p, snaps[i]!.book); });

  const sim = simulatePath(path, sizeUsd, books, feesPct, activeLookup);
  if (!sim) return null;

  // Post-only limit prices: buys rest at best bid, sells rest at best ask.
  // (Post-only order is rejected if it would cross the spread, so buy price
  //  must be ≤ current best bid to queue as a maker — never at or above ask.)
  const obFirst = books.get(pairFirst)!;
  const obLast  = books.get(pairLast)!;
  const priceBuyFirst = obFirst.bids[0]![0]; // leg 1: buy path[0] — join top bid
  const priceSellLast = obLast.asks[0]![0];  // final leg: sell path[last] — join top ask
  const crossPrices = crosses.map(c => {
    const ob = books.get(c.pair)!;
    return c.aIsQuote ? ob.bids[0]![0] : ob.asks[0]![0]; // buy joins bid, sell joins ask
  });
  const buildLegs = (volumes: number[]): ObExecutionLeg[] => [
    { pair: pairFirst, side: "buy", volume: volumes[0]!, limitPrice: priceBuyFirst },
    ...crosses.map((c, i): ObExecutionLeg => c.aIsQuote
      ? { pair: c.pair, side: "buy",  volume: volumes[i + 1]!, limitPrice: crossPrices[i]! }
      : { pair: c.pair, side: "sell", volume: volumes[i]!,     limitPrice: crossPrices[i]! }),
    { pair: pairLast, side: "sell", volume: volumes[volumes.length - 1]!, limitPrice: priceSellLast },
  ];

  // MAKER pricing: the orders are POST-ONLY limits resting at the join
  // prices — they fill at limitPrice or not at all. Simulating profit with the
  // taker depth-walk (avg ask/bid VWAP) systematically understates the edge by
  // the spread, rejecting routes the maker scanner correctly ranked viable.
  // Recompute volumes and profit from the actual limit prices, zero slippage.
  if (pricing === "maker") {
    const volumes: number[] = [sizeUsd / priceBuyFirst];
    for (let i = 0; i < crosses.length; i++) {
      const v = volumes[i]!;
      volumes.push(crosses[i]!.aIsQuote ? v / crossPrices[i]! : v * crossPrices[i]!);
    }
    const usdFinal = volumes[volumes.length - 1]! * priceSellLast;
    const gross    = usdFinal - sizeUsd;
    // Per-leg fee on each leg's ACTUAL notional (USD value of assets exchanged):
    // entry leg = sizeUsd; exit leg = usdFinal. Cross-leg notional is the USD
    // value of what changes hands there: buying base with the held quote
    // (aIsQuote) the amount spent is worth ~sizeUsd; selling the held base
    // (!aIsQuote) the quote received is worth ~usdFinal.
    const crossNotionalUsd = crosses.reduce((s, c) => s + (c.aIsQuote ? sizeUsd : usdFinal), 0);
    const feeUsd = (feesPct / 100) * (sizeUsd + crossNotionalUsd + usdFinal); // per-leg on notional
    return { profitUsd: gross - feeUsd, slippagePct: 0, confidencePct: sim.confidencePct, legs: buildLegs(volumes), volumes };
  }

  // TAKER pricing: holdings chain from the depth-walk VWAPs. Cross legDiag
  // vwapPx is quote-per-base for buys (from per to) and to-per-from for sells.
  const volumes: number[] = [sim.volA];
  for (let i = 0; i < crosses.length; i++) {
    const d = sim.legDiag[i + 1]!;
    const v = volumes[i]!;
    volumes.push(crosses[i]!.aIsQuote ? v / d.vwapPx : v * d.vwapPx);
  }
  return { profitUsd: sim.profitUsd, slippagePct: sim.slippagePct, confidencePct: sim.confidencePct, legs: buildLegs(volumes), volumes };
}

/**
 * v18 3-leg manual-execute pre-flight — thin wrapper over preflightObPath
 * preserving the triangle-shaped result for existing callers.
 */
export async function preflightObCycle(
  assetA: ObAsset,
  assetB: ObAsset,
  sizeUsd: number,
  feesPct: number,
  pricing: "maker" | "taker" = "taker",
  maxQuoteAgeMs?: number,
): Promise<ObPreflightResult | null> {
  const pf = await preflightObPath([assetA, assetB], sizeUsd, feesPct, pricing, maxQuoteAgeMs);
  if (!pf) return null;
  return {
    profitUsd: pf.profitUsd,
    slippagePct: pf.slippagePct,
    confidencePct: pf.confidencePct,
    legs: pf.legs as [ObExecutionLeg, ObExecutionLeg, ObExecutionLeg],
    volumeA: pf.volumes[0]!,
    volumeB: pf.volumes[1]!,
  };
}

/** Pre-fire taker breakdown: raw top-of-book edge, depth-walk slippage cost,
 *  total taker fees, and the executable net — all from FRESH books. */
export interface TakerCycleBreakdown {
  /** Gross edge at top-of-book crossing prices (buy at ask, sell at bid), before fees. */
  rawEdgeUsd: number;
  /** Depth-walk cost for this size: rawEdgeUsd − VWAP gross (≥ 0). */
  slippageUsd: number;
  /** Total taker fees across all 3 legs (per-leg, on notional). */
  feesUsd: number;
  /** Executable net = VWAP gross − fees (before any safety buffer). */
  netProfitUsd: number;
  volumeA: number;
  /** Per-leg price/side diagnostic from the depth-walk simulator. */
  legDiag: LegDiag[];
}

/** Fresh-book taker breakdown for USD→A→B→USD at the given size and taker fee.
 *  Returns null when books can't be fetched or depth can't absorb the size. */
export async function takerCycleBreakdown(
  assetA: ObAsset,
  assetB: ObAsset,
  sizeUsd: number,
  takerFeePct: number,
): Promise<TakerCycleBreakdown | null> {
  const { lookup: activeLookup } = await discoverCrossPairs();
  const cross = activeLookup.get(`${assetA}-${assetB}`);
  if (!cross) return null;
  const pairA = OB_USD_PAIRS[assetA];
  const pairB = OB_USD_PAIRS[assetB];
  const [sA, sX, sB] = await Promise.all([
    bookSnapshot(pairA, 400, true), bookSnapshot(cross.pair, 400, true), bookSnapshot(pairB, 400, true),
  ]);
  if (!sA || !sX || !sB) return null;
  const [obA, obX, obB] = [sA.book, sX.book, sB.book];
  const books = new Map<string, OrderBook>([[pairA, obA], [cross.pair, obX], [pairB, obB]]);
  const sim = simulateCycle(assetA, assetB, sizeUsd, books, takerFeePct, activeLookup);
  if (!sim) return null;

  // Top-of-book CROSSING prices (what a zero-slippage taker would pay):
  // buy A at best ask, cross at the crossing side, sell B at best bid.
  const askA = obA.asks[0]?.[0]; const bidB = obB.bids[0]?.[0];
  const crossPx = cross.aIsQuote ? obX.asks[0]?.[0] : obX.bids[0]?.[0];
  if (!askA || !bidB || !crossPx) return null;
  const volA = sizeUsd / askA;
  const volB = cross.aIsQuote ? volA / crossPx : volA * crossPx;
  const rawEdgeUsd = volB * bidB - sizeUsd;
  const slippageUsd = Math.max(0, rawEdgeUsd - sim.grossProfitUsd);
  return { rawEdgeUsd, slippageUsd, feesUsd: sim.feeUsd, netProfitUsd: sim.profitUsd, volumeA: sim.volA, legDiag: sim.legDiag };
}

/** Micro-check result: the same taker breakdown computed purely from the
 *  in-memory stream snapshot — zero network requests. */
/** Per-leg freshness: pair + age. `ageMs` is measured from the exchange's own
 *  event timestamp when available (strictest); `recvAgeMs` from our local
 *  ws_received_timestamp — both preserved and logged. */
export interface LegAge { pair: string; ageMs: number | null; recvAgeMs?: number | null }

export type CachedBreakdownResult =
  | { ok: true; bd: TakerCycleBreakdown; quoteAgeMs: number; marketUpdateMs: number; legAges: LegAge[] }
  | { ok: false; reason: "stale" | "unavailable"; oldestAgeMs: number | null; legAges?: LegAge[] };

/** "ETH/USD 74ms | BCH/ETH 118ms | BCH/USD 163ms | route_age 163ms" */
export function formatLegAges(legAges: LegAge[] | undefined): string {
  if (!legAges || legAges.length === 0) return "(no leg ages)";
  const parts = legAges.map(l => `${l.pair} ${l.ageMs == null ? "n/a" : Math.round(l.ageMs) + "ms"}${l.recvAgeMs != null && l.ageMs != null && Math.round(l.recvAgeMs) !== Math.round(l.ageMs) ? ` (recv ${Math.round(l.recvAgeMs)}ms)` : ""}`);
  const ages = legAges.map(l => l.ageMs).filter((a): a is number => a != null);
  const routeAge = ages.length === legAges.length ? `${Math.round(Math.max(...ages))}ms` : "n/a";
  return `${parts.join(" | ")} | route_age ${routeAge}`;
}

/**
 * Executor micro-check: taker breakdown for USD→A→B→USD read from the SAME
 * timestamped in-memory stream books the scanner sees. Never touches the
 * network. Fails with reason "stale" when any leg's book is older than
 * `maxQuoteAgeMs`, "unavailable" when the stream has no book for a leg.
 */
/**
 * Wait until the stream pushes an update touching ANY of the given pairs, or
 * the timeout elapses. Lets a stale pre-fire wait for the next WebSocket tick
 * and re-evaluate instead of reusing old data or fetching REST.
 */
export function waitForBookTouch(restPairKeys: string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (hit: boolean) => { if (!done) { done = true; clearTimeout(t); off(); resolve(hit); } };
    const t = setTimeout(() => finish(false), timeoutMs);
    const wanted = new Set(restPairKeys);
    const off = onBookUpdate(key => { if (!done && wanted.has(key)) finish(true); });
  });
}

export async function cachedTakerCycleBreakdown(
  assetA: ObAsset,
  assetB: ObAsset,
  sizeUsd: number,
  takerFeePct: number,
  maxQuoteAgeMs: number,
): Promise<CachedBreakdownResult | null> {
  const { lookup: activeLookup } = await discoverCrossPairs(); // cached in steady state
  const cross = activeLookup.get(`${assetA}-${assetB}`);
  if (!cross) return null;
  const pairA = OB_USD_PAIRS[assetA];
  const pairB = OB_USD_PAIRS[assetB];
  const routePairs = [pairA, cross.pair, pairB];
  const snaps = routePairs.map(p => getStreamBook(p));
  // Per-leg freshness (exchange-timestamp based): route age = OLDEST leg.
  const nowTs = Date.now();
  const legAges = routePairs.map((p, i) => ({ pair: p, ageMs: snaps[i]?.ageMs ?? null, recvAgeMs: snaps[i] ? Math.max(0, nowTs - snaps[i]!.updatedAtMs) : null }));
  if (snaps.some(s => !s)) return { ok: false, reason: "unavailable", oldestAgeMs: null, legAges };
  const oldestAgeMs = Math.max(...snaps.map(s => s!.ageMs));
  if (oldestAgeMs > maxQuoteAgeMs) return { ok: false, reason: "stale", oldestAgeMs, legAges };
  const [sA, sX, sB] = snaps as [NonNullable<typeof snaps[0]>, NonNullable<typeof snaps[0]>, NonNullable<typeof snaps[0]>];
  const books = new Map<string, OrderBook>([
    [pairA, { asks: sA.asks, bids: sA.bids }],
    [cross.pair, { asks: sX.asks, bids: sX.bids }],
    [pairB, { asks: sB.asks, bids: sB.bids }],
  ]);
  const sim = simulateCycle(assetA, assetB, sizeUsd, books, takerFeePct, activeLookup);
  if (!sim) return { ok: false, reason: "unavailable", oldestAgeMs, legAges }; // depth can't absorb the size
  const askA = sA.asks[0]?.[0]; const bidB = sB.bids[0]?.[0];
  const crossPx = cross.aIsQuote ? sX.asks[0]?.[0] : sX.bids[0]?.[0];
  if (!askA || !bidB || !crossPx) return { ok: false, reason: "unavailable", oldestAgeMs, legAges };
  const volA = sizeUsd / askA;
  const volB = cross.aIsQuote ? volA / crossPx : volA * crossPx;
  const rawEdgeUsd = volB * bidB - sizeUsd;
  const slippageUsd = Math.max(0, rawEdgeUsd - sim.grossProfitUsd);
  return {
    ok: true,
    bd: { rawEdgeUsd, slippageUsd, feesUsd: sim.feeUsd, netProfitUsd: sim.profitUsd, volumeA: sim.volA, legDiag: sim.legDiag },
    quoteAgeMs: oldestAgeMs,
    marketUpdateMs: Math.max(...snaps.map(s => s!.updatedAtMs)),
    legAges,
  };
}

/**
 * Fresh post-only join price for one pair (cache bypassed): buys rest at the
 * best bid, sells at the best ask. Used to re-price a maker leg after a
 * fill-timer expiry. Returns null when the book can't be fetched.
 */
export async function freshJoinPrice(pair: string, side: "buy" | "sell"): Promise<number | null> {
  const snap = await bookSnapshot(pair, 400, true);
  if (!snap) return null;
  const ob = snap.book;
  return (side === "buy" ? ob.bids[0]?.[0] : ob.asks[0]?.[0]) ?? null;
}

// ── Aggressive maker pricing (tick-improved post-only) ───────────────────────

const TICK_CACHE_TTL_MS = 60 * 60 * 1000;
let tickCache: { ticks: Map<string, number>; fetchedAt: number } | null = null;

/** Kraken tick sizes (min price increments) keyed by pair altname, cached 1h. */
async function pairTickSizes(): Promise<Map<string, number>> {
  if (tickCache && Date.now() - tickCache.fetchedAt < TICK_CACHE_TTL_MS) return tickCache.ticks;
  const ticks = new Map<string, number>();
  try {
    const r = await fetch("https://api.kraken.com/0/public/AssetPairs", { signal: AbortSignal.timeout(5_000) });
    if (r.ok) {
      const data = await r.json() as { result?: Record<string, { altname?: string; tick_size?: string; pair_decimals?: number }> };
      for (const info of Object.values(data.result ?? {})) {
        if (!info.altname) continue;
        const t = info.tick_size != null ? parseFloat(info.tick_size)
          : info.pair_decimals != null ? Math.pow(10, -info.pair_decimals) : NaN;
        if (Number.isFinite(t) && t > 0) ticks.set(info.altname, t);
      }
      if (ticks.size > 0) tickCache = { ticks, fetchedAt: Date.now() };
    }
  } catch { /* fall through — caller degrades to join price */ }
  return tickCache?.ticks ?? ticks;
}

export interface MakerQuote {
  /** Most aggressive VALID post-only price: one tick inside the spread when it
   * is wider than one tick (front of the queue, alone), else the join price. */
  price: number;
  bestBid: number;
  bestAsk: number;
  tick: number | null;
  /** Book volume resting AHEAD of us at our price level (0 when we improve). */
  queueAheadVol: number;
}

/** Fresh (cache-bypassed) aggressive maker quote for one pair+side. */
export async function makerQuote(pair: string, side: "buy" | "sell"): Promise<MakerQuote | null> {
  const [bsnap, ticks] = await Promise.all([bookSnapshot(pair, 400, true), pairTickSizes()]);
  const ob = bsnap?.book;
  const bestBid = ob?.bids[0]?.[0];
  const bestAsk = ob?.asks[0]?.[0];
  if (!ob || bestBid == null || bestAsk == null) return null;
  const tick = ticks.get(pair) ?? null;
  // Round to the tick grid AND quantize decimals — raw float math produces
  // dust (0.30000000000000004) that Kraken rejects outright.
  const tickDecimals = tick ? Math.max(0, Math.min(10, (tick.toString().split(".")[1] ?? "").length)) : 0;
  const snap = (p: number) => tick ? parseFloat((Math.round(p / tick) * tick).toFixed(tickDecimals)) : p;
  if (side === "buy") {
    const improved = tick != null && bestAsk - bestBid > tick * 1.0001;
    const price = improved ? snap(bestBid + tick!) : bestBid;
    return { price, bestBid, bestAsk, tick, queueAheadVol: improved ? 0 : (ob.bids[0]?.[1] ?? 0) };
  }
  const improved = tick != null && bestAsk - bestBid > tick * 1.0001;
  const price = improved ? snap(bestAsk - tick!) : bestAsk;
  return { price, bestBid, bestAsk, tick, queueAheadVol: improved ? 0 : (ob.asks[0]?.[1] ?? 0) };
}

// ── Full scan ─────────────────────────────────────────────────────────────────

const VOLATILITY_THRESHOLD_PCT = 1.5; // v17: |24h change| must exceed this
const VOLATILITY_MIN_ASSETS    = 3;   // v17: fallback to all assets below this

/**
 * v19: discovers cross pairs dynamically from Kraken AssetPairs (cached 1h),
 * then simulates all A × B permutations across 34 assets.
 * v17: optional volatility filter — only assets that moved >1.5% in 24h are
 * scanned (falls back to ALL assets when fewer than 3 qualify).
 * All simulatable cycles are ranked (top 50) with status + confidence.
 * Sorted by estimatedProfitUsd descending.
 */
/** v18: trade sizes for the top-route scaling analysis. */
const SCALING_SIZES_USD = [10, 50, 100, 500, 1000];

/** v19: max ranked cycles to return — raised from 15 to expose more routes. */
const MAX_RANKED_CYCLES = 50;

/** v20: fixed mid-asset chains for 4-leg routes (the BTC/ETH cross as middle step). */
const FOUR_LEG_MIDS: Array<[ObAsset, ObAsset]> = [["BTC", "ETH"], ["ETH", "BTC"]];

export async function scanOrderBookCycles(
  tradeSizeUsd   = 10,
  feesPct        = 0.26, // per-leg fee %, Kraken standard taker (0.26%); use 0.16% for post-only maker
  minProfitUsd   = 0.02, // v18: min profit ($) at $10, scaled by size/10 for larger sizes
  maxSlippagePct = 0.50,
  volatilityFilter = true, // v17
  maxLegs: 3 | 4 = 4,      // v20: 4 adds USD→A→BTC→ETH→USD and USD→A→ETH→BTC→USD routes
): Promise<ObScanResult> {
  // v19: discover cross pairs dynamically (falls back to hardcoded on error)
  const { lookup: activeLookup, crossMap: activeCrossMap } = await discoverCrossPairs();
  const crossPairsDiscovered = activeLookup === CROSS_LOOKUP ? 0 : activeCrossMap.length;

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
    const canFormCycle = activeCrossMap.some(([a, b]) => movingSet.has(a) && movingSet.has(b));
    if (moving.length >= VOLATILITY_MIN_ASSETS && canFormCycle) activeAssets = moving;
  }
  const activeSet = new Set<ObAsset>(activeAssets);

  // v20: pairs needed for 4-leg routes — BTC/ETH USD legs, the BTC↔ETH cross,
  // and A↔BTC / A↔ETH crosses for every active A (even when the volatility
  // filter excluded BTC/ETH themselves from the 3-leg permutations).
  const fourLegPairs: string[] = [];
  if (maxLegs >= 4) {
    fourLegPairs.push(OB_USD_PAIRS["BTC"], OB_USD_PAIRS["ETH"]);
    const btcEth = activeLookup.get("BTC-ETH");
    if (btcEth) fourLegPairs.push(btcEth.pair);
    for (const a of activeAssets) {
      if (a === "BTC" || a === "ETH") continue;
      const toBtc = activeLookup.get(`${a}-BTC`);
      const toEth = activeLookup.get(`${a}-ETH`);
      if (toBtc) fourLegPairs.push(toBtc.pair);
      if (toEth) fourLegPairs.push(toEth.pair);
    }
  }

  // Deduplicated list of pairs needed for the active asset set
  const allPairs = [...new Set([
    ...activeAssets.map(a => OB_USD_PAIRS[a]),
    ...activeCrossMap.filter(([a, b]) => activeSet.has(a) && activeSet.has(b))
                     .map(([,, pair]) => pair),
    ...fourLegPairs,
  ])];

  // Fetch all order books in parallel (v18: depth 10 for scaling analysis)
  const fetched = await Promise.all(allPairs.map(p => fetchOrderBook(p, 10)));
  const orderbooks = new Map<string, OrderBook>();
  let pairsScanned = 0;
  for (let i = 0; i < allPairs.length; i++) {
    if (fetched[i]) { orderbooks.set(allPairs[i], fetched[i]!); pairsScanned++; }
  }

  const cycles: ObCycleEntry[] = [];
  // v20: remember each ranked route's asset path so the scaling table can
  // re-simulate 4-leg routes correctly.
  const pathByRoute = new Map<string, ObAsset[]>();

  const pushCycle = (path: ObAsset[], r: CycleSimResult): void => {
    // v15 status classification
    let status: ObCycleStatus;
    if (r.profitUsd > minProfitUsd && r.slippagePct <= maxSlippagePct) {
      status = "READY";
    } else if (r.profitUsd > minProfitUsd) {
      status = "HIGH_SLIPPAGE";
    } else {
      status = "LOW_PROFIT";
    }
    const route = `USD→${path.join("→")}→USD`;
    pathByRoute.set(route, path);
    cycles.push({
      route,
      assetA:              path[0]!,
      assetB:              path[path.length - 1]!,
      estimatedProfitUsd:  r.profitUsd,
      grossProfitUsd:      r.grossProfitUsd,
      feeUsd:              r.feeUsd,
      profitPct:           (r.profitUsd / tradeSizeUsd) * 100,
      avgPriceA:           r.avg1,
      avgCrossRate:        r.avg2,
      avgPriceB:           r.avg3,
      volumeA:             r.volA,
      slippagePct:         r.slippagePct,
      status,
      confidencePct:       r.confidencePct,
      legs:                r.legs,
      path:                [...path],
    });
  };

  // All A≠B permutations among active assets (3-leg triangles)
  for (const assetA of activeAssets) {
    for (const assetB of activeAssets) {
      if (assetA === assetB) continue;
      const r = simulateCycle(assetA, assetB, tradeSizeUsd, orderbooks, feesPct, activeLookup);
      if (r) pushCycle([assetA, assetB], r);
    }
  }

  // v20: 4-leg routes through the BTC/ETH cross — USD→A→BTC→ETH→USD and
  // USD→A→ETH→BTC→USD for every active A (A itself must not be BTC or ETH).
  if (maxLegs >= 4) {
    for (const assetA of activeAssets) {
      if (assetA === "BTC" || assetA === "ETH") continue;
      for (const [m1, m2] of FOUR_LEG_MIDS) {
        const path = [assetA, m1, m2];
        const r = simulatePath(path, tradeSizeUsd, orderbooks, feesPct, activeLookup);
        if (r) pushCycle(path, r);
      }
    }
  }

  cycles.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
  // readyCount reflects ALL simulatable cycles, computed before truncation
  const readyCount = cycles.filter(c => c.status === "READY").length;
  const top = cycles.slice(0, MAX_RANKED_CYCLES); // v19: top 50 ranked

  // v18: re-simulate the TOP route at each scaling size using the same books.
  // Sizes the book depth can't fully absorb return null and are omitted.
  const scaling: ObScalingRow[] = [];
  const topCycle = cycles[0];
  if (topCycle) {
    const topPath = pathByRoute.get(topCycle.route) ?? [topCycle.assetA as ObAsset, topCycle.assetB as ObAsset];
    for (const sizeUsd of SCALING_SIZES_USD) {
      const r = simulatePath(topPath, sizeUsd, orderbooks, feesPct, activeLookup);
      if (!r) continue;
      const threshold = minProfitUsd * (sizeUsd / 10); // v18: scale min profit with size
      let status: ObScalingStatus;
      if (r.profitUsd > threshold && r.slippagePct <= maxSlippagePct) status = "VIABLE";
      else if (r.profitUsd > threshold) status = "HIGH_SLIPPAGE";
      else status = "REJECTED";
      scaling.push({ sizeUsd, profitUsd: r.profitUsd, slippagePct: r.slippagePct, confidencePct: r.confidencePct, status });
    }
  }

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
    scalingRoute: topCycle?.route ?? null,
    scaling,
    crossPairsDiscovered,
    scannedAt: new Date().toISOString(),
  };
}
