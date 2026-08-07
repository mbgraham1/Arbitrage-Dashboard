/**
 * price-cache.ts — v6.0 multi-pair cross-exchange price aggregator
 *
 * • Tracks bid/ask for 10 pairs across Kraken, Coinbase, Binance, KuCoin
 * • Maintains persistent Kraken WebSocket (v2) for all pairs
 * • Falls back to REST if WS price is stale (> 15 s)
 * • Polls Coinbase (2 s), Binance + KuCoin (5 s) via REST
 * • Keeps ETH/SOL direct market for triangular arb detection
 * • All reconnections are handled automatically
 */

import { getKrakenPrice, getCoinbasePrice, PAIRS, type Pair } from "./exchange";

export { PAIRS, type Pair };

const WS_STALE_MS = 15_000;
const BINANCE_KU_POLL_MS = 5_000;
const CB_POLL_MS = 2_000;
const TRI_STALE_MS = 30_000;

interface CacheEntry {
  price: number;   // mid/last
  bid?: number;
  ask?: number;
  updatedAt: number;
  source: "ws" | "rest";
}

type ExchangeCache = {
  kraken:   CacheEntry | null;
  coinbase: CacheEntry | null;
  binance:  CacheEntry | null;
  kucoin:   CacheEntry | null;
};

// Multi-pair cache — one entry per (pair, exchange)
const pairCache = new Map<Pair, ExchangeCache>(
  PAIRS.map(p => [p, { kraken: null, coinbase: null, binance: null, kucoin: null }])
);

// Coinbase public exchange ticker product IDs
const COINBASE_SYMBOL: Record<Pair, string> = {
  "BTC/USD":  "BTC-USD",  "ETH/USD":  "ETH-USD",  "SOL/USD":  "SOL-USD",
  "AVAX/USD": "AVAX-USD", "DOT/USD":  "DOT-USD",  "POL/USD":  "POL-USD",
  "LINK/USD": "LINK-USD", "UNI/USD":  "UNI-USD",  "ATOM/USD": "ATOM-USD",
  "ADA/USD":  "ADA-USD",
};

// Binance bookTicker symbols (POL still listed as MATICUSDT on Binance as of 2026-08)
const BINANCE_SYMBOL: Record<Pair, string> = {
  "BTC/USD":  "BTCUSDT",  "ETH/USD":  "ETHUSDT",  "SOL/USD":  "SOLUSDT",
  "AVAX/USD": "AVAXUSDT", "DOT/USD":  "DOTUSDT",  "POL/USD":  "MATICUSDT",
  "LINK/USD": "LINKUSDT", "UNI/USD":  "UNIUSDT",  "ATOM/USD": "ATOMUSDT",
  "ADA/USD":  "ADAUSDT",
};

const KUCOIN_SYMBOL: Record<Pair, string> = {
  "BTC/USD":  "BTC-USDT", "ETH/USD":  "ETH-USDT", "SOL/USD":  "SOL-USDT",
  "AVAX/USD": "AVAX-USDT","DOT/USD":  "DOT-USDT", "POL/USD":  "POL-USDT",
  "LINK/USD": "LINK-USDT","UNI/USD":  "UNI-USDT", "ATOM/USD": "ATOM-USDT",
  "ADA/USD":  "ADA-USDT",
};

// ── Triangular arb cache — ETH/SOL and SOL/BTC direct markets ────────────────
interface TriEntry {
  bid: number;
  ask: number;
  updatedAt: number;
}

const triEthSol: { kraken: TriEntry | null; coinbase: TriEntry | null } = {
  kraken: null,
  coinbase: null,
};

// SOL/BTC direct market on Kraken (SOLXBT) — BTC triangular loops (v13 Python port)
const triSolBtc: { kraken: TriEntry | null } = { kraken: null };

// ── WebSocket helpers ──────────────────────────────────────────────────────────

function reconnectingWs(
  url: string,
  onOpen: (ws: WebSocket) => void,
  onMessage: (raw: string) => void,
  label: string
): void {
  let stopped = false;

  function connect() {
    if (stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setTimeout(connect, 5_000);
      return;
    }

    ws.onopen = () => {
      console.log(`[price-cache] ${label} WS connected`);
      onOpen(ws);
    };

    ws.onmessage = (ev) => {
      onMessage(typeof ev.data === "string" ? ev.data : "");
    };

    ws.onclose = () => {
      console.log(`[price-cache] ${label} WS closed — reconnecting in 3 s`);
      if (!stopped) setTimeout(connect, 3_000);
    };

    ws.onerror = (ev) => {
      const msg = (ev as ErrorEvent).message ?? "unknown error";
      console.error(`[price-cache] ${label} WS error: ${msg}`);
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  connect();
}

// ── Kraken WebSocket (v2) ──────────────────────────────────────────────────────
// Subscribes to all 10 pairs + ETH/SOL in a single connection.
// Kraken v2 WS uses the same "PAIR/USD" notation as our canonical PAIRS.

function startKrakenWs(): void {
  // All 10 pairs + ETH/SOL + SOL/BTC for triangular arb
  const symbols = [...PAIRS as readonly string[], "ETH/SOL", "SOL/BTC"];

  reconnectingWs(
    "wss://ws.kraken.com/v2",
    (ws) => {
      ws.send(JSON.stringify({
        method: "subscribe",
        params: { channel: "ticker", symbol: symbols },
      }));
    },
    (raw) => {
      try {
        const msg = JSON.parse(raw) as {
          channel?: string;
          type?: string;
          data?: Array<{ symbol?: string; last?: number; bid?: number; ask?: number }>;
        };
        if (msg.channel === "ticker" && (msg.type === "update" || msg.type === "snapshot") && msg.data != null) {
          for (const d of msg.data) {
            const bid = d.bid;
            const ask = d.ask;
            const last = d.last;
            const mid = (bid != null && ask != null) ? (bid + ask) / 2 : (last ?? 0);
            if (mid <= 0) continue;

            // ETH/SOL direct market → tri cache (ETH loops)
            if (d.symbol === "ETH/SOL") {
              triEthSol.kraken = { bid: bid ?? mid, ask: ask ?? mid, updatedAt: Date.now() };
              continue;
            }
            // SOL/BTC direct market → tri cache (BTC loops — v13 Python port)
            if (d.symbol === "SOL/BTC") {
              triSolBtc.kraken = { bid: bid ?? mid, ask: ask ?? mid, updatedAt: Date.now() };
              continue;
            }

            // All canonical pairs → pairCache
            const pair = d.symbol as Pair;
            if (pairCache.has(pair)) {
              const entry = pairCache.get(pair)!;
              entry.kraken = { price: mid, bid: bid ?? mid, ask: ask ?? mid, updatedAt: Date.now(), source: "ws" };
            }
          }
        }
      } catch (e) { console.error(`[price-cache] Kraken WS parse error: ${e}`); }
    },
    "Kraken"
  );
}

// ── Coinbase REST fast-poll (all pairs) ────────────────────────────────────────
// Uses api.exchange.coinbase.com/products/{product}/ticker — returns bid + ask.

async function fetchCoinbasePair(pair: Pair): Promise<void> {
  const product = COINBASE_SYMBOL[pair];
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok) return;
    const j = await r.json() as { bid?: string; ask?: string; price?: string };
    const bid = parseFloat(j.bid ?? "0");
    const ask = parseFloat(j.ask ?? "0");
    const last = parseFloat(j.price ?? "0");
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
    if (mid > 0) {
      const entry = pairCache.get(pair)!;
      // Mark as "ws" so wsStatus.coinbase remains true (polls every 2 s → effectively live)
      entry.coinbase = { price: mid, bid: bid || mid, ask: ask || mid, updatedAt: Date.now(), source: "ws" };
    }
  } catch { /* ignore */ }
}

function startCoinbasePoll(): void {
  const poll = () => {
    for (const pair of PAIRS) void fetchCoinbasePair(pair);
  };
  poll(); // immediate first run
  setInterval(poll, CB_POLL_MS);
}

// ── Binance REST poll (all pairs via bookTicker) ───────────────────────────────

async function fetchBinancePair(pair: Pair): Promise<void> {
  const symbol = BINANCE_SYMBOL[pair];
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return;
    const j = await r.json() as { bidPrice?: string; askPrice?: string };
    const bid = parseFloat(j.bidPrice ?? "0");
    const ask = parseFloat(j.askPrice ?? "0");
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    if (mid > 0) {
      const entry = pairCache.get(pair)!;
      entry.binance = { price: mid, bid, ask, updatedAt: Date.now(), source: "rest" };
    }
  } catch { /* ignore */ }
}

// ── KuCoin REST poll (all pairs via level1) ────────────────────────────────────

async function fetchKuCoinPair(pair: Pair): Promise<void> {
  const symbol = KUCOIN_SYMBOL[pair];
  try {
    const r = await fetch(
      `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${symbol}`,
      { signal: AbortSignal.timeout(4_000) }
    );
    if (!r.ok) return;
    const j = await r.json() as { data?: { bestBid?: string; bestAsk?: string; price?: string } };
    const bid = parseFloat(j.data?.bestBid ?? "0");
    const ask = parseFloat(j.data?.bestAsk ?? "0");
    const price = parseFloat(j.data?.price ?? "0");
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : price;
    if (mid > 0) {
      const entry = pairCache.get(pair)!;
      entry.kucoin = { price: mid, bid: bid || mid, ask: ask || mid, updatedAt: Date.now(), source: "rest" };
    }
  } catch { /* ignore */ }
}

function startRestPollers(): void {
  const poll = () => {
    for (const pair of PAIRS) {
      void fetchBinancePair(pair);
      void fetchKuCoinPair(pair);
    }
  };
  poll(); // immediate first run
  setInterval(poll, BINANCE_KU_POLL_MS);
}

// ── Triangular arb — Coinbase ETH/SOL (no direct pair, synthetic only) ────────
// Coinbase has no ETH/SOL direct market; triEthSol.coinbase stays null.
// getTriPrices() falls back to synthetic cross from pairCache["ETH/USD"]/["SOL/USD"].

// ── Public interface ───────────────────────────────────────────────────────────

let initialized = false;
export function initPriceFeeds(): void {
  if (initialized) return;
  initialized = true;
  startKrakenWs();
  startCoinbasePoll();
  startRestPollers();
  console.log("[price-cache] Price feeds initialised for 10 pairs (BTC, ETH, SOL, AVAX, DOT, POL, LINK, UNI, ATOM, ADA)");
  void checkKrakenEthSolAvailability();
  void verifyPairAvailability();
}

/**
 * REST poll at startup to confirm Kraken has a live ETH/SOL direct market.
 * Logs the result so operators know whether triangular scans will use direct
 * prices or fall back to synthetic cross rates.
 */
async function checkKrakenEthSolAvailability(): Promise<void> {
  try {
    const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHSOL", {
      signal: AbortSignal.timeout(8_000),
    });
    const data = await r.json() as { error?: string[]; result?: Record<string, unknown> };
    if (data.error?.length) {
      console.warn(`[price-cache] Kraken ETH/SOL REST check: pair not available (${data.error.join(", ")}) — triangular scans will use synthetic cross rates`);
      return;
    }
    const keys = Object.keys(data.result ?? {});
    if (keys.length > 0) {
      console.log(`[price-cache] Kraken ETH/SOL REST check ✓ — direct market confirmed (${keys[0]}); WS subscription active`);
    } else {
      console.warn("[price-cache] Kraken ETH/SOL REST check: empty result — pair may not be active; triangular scans may fall back to synthetic rates");
    }
  } catch (e) {
    console.warn(`[price-cache] Kraken ETH/SOL REST check failed (${(e as Error).message}) — connectivity issue; WS subscription still attempted`);
  }
}

/**
 * Runs 15 s after startup and logs which pairs have live bid/ask on
 * both Kraken and Coinbase. Missing pairs are warned (not fatal) —
 * getBestPairPrices() already skips pairs with no data.
 */
async function verifyPairAvailability(): Promise<void> {
  await new Promise<void>(r => setTimeout(r, 15_000));
  const now = Date.now();
  const FRESH_MS = WS_STALE_MS * 2; // allow up to 2× stale window on cold start
  const ok: string[] = [];
  const stale: string[] = [];

  for (const pair of PAIRS) {
    const entry = pairCache.get(pair)!;
    const krakenOk   = entry.kraken   != null && now - entry.kraken.updatedAt   < FRESH_MS;
    const coinbaseOk = entry.coinbase  != null && now - entry.coinbase.updatedAt < FRESH_MS;
    if (krakenOk && coinbaseOk) {
      ok.push(pair);
    } else {
      const missing = [!krakenOk && "Kraken", !coinbaseOk && "Coinbase"].filter(Boolean).join("+");
      stale.push(`${pair}(${missing})`);
    }
  }

  if (stale.length === 0) {
    console.log(`[price-cache] Startup check ✓ — all ${PAIRS.length} pairs live on Kraken + Coinbase`);
  } else {
    console.warn(`[price-cache] Startup check: ${ok.length}/${PAIRS.length} pairs ready. Stale/missing: ${stale.join(", ")}`);
  }
}

// ── Triangular arb interface ───────────────────────────────────────────────────

export interface TriPrices {
  kraken:   { solBid: number; solAsk: number; ethBid: number; ethAsk: number; ethSolBid: number; ethSolAsk: number; ethSolSource: "direct" | "synthetic" } | null;
  coinbase: { solBid: number; solAsk: number; ethBid: number; ethAsk: number; ethSolBid: number; ethSolAsk: number; ethSolSource: "direct" | "synthetic" } | null;
}

/**
 * Returns per-exchange ETH/USD and ETH/SOL bid/ask prices for triangular arb scanning.
 * SOL/USD and ETH/USD legs come from pairCache; ETH/SOL comes from the direct WS market
 * (Kraken only) or falls back to a synthetic cross using same-exchange legs.
 */
export function getTriPrices(): TriPrices {
  const now = Date.now();

  const syntheticEthSol = (
    ethBid: number, ethAsk: number,
    solBid: number, solAsk: number,
  ): { bid: number; ask: number } => ({
    bid: solAsk > 0 ? ethBid / solAsk : 0,
    ask: solBid > 0 ? ethAsk / solBid : 0,
  });

  // ── Kraken ────────────────────────────────────────────────────────────────
  let krakenResult: TriPrices["kraken"] = null;
  const kSol = pairCache.get("SOL/USD")!.kraken;
  const kEth = pairCache.get("ETH/USD")!.kraken;
  if (
    kSol && now - kSol.updatedAt < TRI_STALE_MS &&
    kEth && now - kEth.updatedAt < TRI_STALE_MS
  ) {
    const solBid = kSol.bid ?? kSol.price;
    const solAsk = kSol.ask ?? kSol.price;
    const ethBid = kEth.bid ?? kEth.price;
    const ethAsk = kEth.ask ?? kEth.price;
    const freshEthSol = triEthSol.kraken && now - triEthSol.kraken.updatedAt < TRI_STALE_MS;
    const ethSol = freshEthSol
      ? { bid: triEthSol.kraken!.bid, ask: triEthSol.kraken!.ask }
      : syntheticEthSol(ethBid, ethAsk, solBid, solAsk);
    const ethSolSource: "direct" | "synthetic" = freshEthSol ? "direct" : "synthetic";
    if (ethSol.bid > 0 && ethSol.ask > 0) {
      krakenResult = { solBid, solAsk, ethBid, ethAsk, ethSolBid: ethSol.bid, ethSolAsk: ethSol.ask, ethSolSource };
    }
  }

  // ── Coinbase ─────────────────────────────────────────────────────────────
  let coinbaseResult: TriPrices["coinbase"] = null;
  const cSol = pairCache.get("SOL/USD")!.coinbase;
  const cEth = pairCache.get("ETH/USD")!.coinbase;
  if (
    cSol && now - cSol.updatedAt < TRI_STALE_MS &&
    cEth && now - cEth.updatedAt < TRI_STALE_MS
  ) {
    const solBid = cSol.bid ?? cSol.price;
    const solAsk = cSol.ask ?? cSol.price;
    const ethBid = cEth.bid ?? cEth.price;
    const ethAsk = cEth.ask ?? cEth.price;
    // Coinbase has no direct ETH/SOL market; always synthetic
    const ethSol = syntheticEthSol(ethBid, ethAsk, solBid, solAsk);
    if (ethSol.bid > 0 && ethSol.ask > 0) {
      coinbaseResult = { solBid, solAsk, ethBid, ethAsk, ethSolBid: ethSol.bid, ethSolAsk: ethSol.ask, ethSolSource: "synthetic" };
    }
  }

  return { kraken: krakenResult, coinbase: coinbaseResult };
}

// ── BTC triangular arb prices (SOL/BTC direct market, Kraken only) ────────────
// Port of Python v13 scan_triangular() which uses XXBTZUSD, SOLUSD, SOLXBT.

export interface BtcTriPrices {
  solBid: number; solAsk: number;
  btcBid: number; btcAsk: number;
  solBtcBid: number; solBtcAsk: number; // SOL price denominated in BTC
}

/**
 * Returns Kraken bid/ask for all three legs of the BTC triangular loop.
 * SOL/USD and BTC/USD come from pairCache; SOL/BTC from the direct WS market.
 * Returns null when any leg is stale (> 30 s).
 */
export function getBtcTriPrices(): BtcTriPrices | null {
  const now = Date.now();
  const kSol = pairCache.get("SOL/USD")!.kraken;
  const kBtc = pairCache.get("BTC/USD")!.kraken;
  const kSolBtc = triSolBtc.kraken;
  if (
    !kSol || now - kSol.updatedAt > TRI_STALE_MS ||
    !kBtc || now - kBtc.updatedAt > TRI_STALE_MS ||
    !kSolBtc || now - kSolBtc.updatedAt > TRI_STALE_MS
  ) return null;
  return {
    solBid: kSol.bid ?? kSol.price,  solAsk: kSol.ask ?? kSol.price,
    btcBid: kBtc.bid ?? kBtc.price,  btcAsk: kBtc.ask ?? kBtc.price,
    solBtcBid: kSolBtc.bid,          solBtcAsk: kSolBtc.ask,
  };
}

// ── Multi-pair cross-exchange interface ────────────────────────────────────────

export interface PairPrices {
  pair: Pair;
  kraken:      number | null;
  krakenBid:   number | null;
  krakenAsk:   number | null;
  coinbase:    number | null;
  coinbaseBid: number | null;
  coinbaseAsk: number | null;
  binance:     number | null;
  kucoin:      number | null;
  wsKraken:    boolean;
  wsCoinbase:  boolean;
}

/**
 * Returns prices for a single pair, falling back to REST if WS data is stale.
 */
export async function getPairPrices(pair: Pair): Promise<PairPrices> {
  const now = Date.now();
  const entry = pairCache.get(pair)!;

  const krakenFresh   = entry.kraken   && now - entry.kraken.updatedAt   < WS_STALE_MS;
  const coinbaseFresh = entry.coinbase  && now - entry.coinbase.updatedAt  < WS_STALE_MS;

  const fallbacks: Promise<void>[] = [];
  if (!krakenFresh) {
    fallbacks.push(
      getKrakenPrice(pair)
        .then(p => { entry.kraken = { price: p, bid: p, ask: p, updatedAt: Date.now(), source: "rest" }; })
        .catch(() => {})
    );
  }
  if (!coinbaseFresh) {
    fallbacks.push(
      getCoinbasePrice(pair)
        .then(p => { entry.coinbase = { price: p, bid: p, ask: p, updatedAt: Date.now(), source: "rest" }; })
        .catch(() => {})
    );
  }
  if (fallbacks.length) await Promise.all(fallbacks);

  return {
    pair,
    kraken:      entry.kraken?.price   ?? null,
    krakenBid:   entry.kraken?.bid     ?? entry.kraken?.price   ?? null,
    krakenAsk:   entry.kraken?.ask     ?? entry.kraken?.price   ?? null,
    coinbase:    entry.coinbase?.price ?? null,
    coinbaseBid: entry.coinbase?.bid   ?? entry.coinbase?.price ?? null,
    coinbaseAsk: entry.coinbase?.ask   ?? entry.coinbase?.price ?? null,
    binance:     entry.binance?.price  ?? null,
    kucoin:      entry.kucoin?.price   ?? null,
    wsKraken:   !!(entry.kraken?.source   === "ws" && entry.kraken   && now - entry.kraken.updatedAt   < WS_STALE_MS),
    wsCoinbase: !!(entry.coinbase?.source === "ws" && entry.coinbase && now - entry.coinbase.updatedAt < WS_STALE_MS),
  };
}

/**
 * Scans all 10 pairs and returns the one with the highest gross spread
 * (Kraken ↔ Coinbase, best direction). Falls back to REST for stale pairs.
 *
 * Returns null only if no pair has valid prices on both Kraken and Coinbase.
 */
export async function getBestPairPrices(): Promise<PairPrices | null> {
  // Fire REST fallbacks for all stale pairs in parallel
  const allPrices = await Promise.all(PAIRS.map(p => getPairPrices(p)));

  let bestPrices: PairPrices | null = null;
  let bestSpread = -Infinity;

  for (const pp of allPrices) {
    if (!pp.krakenBid || !pp.krakenAsk || !pp.coinbaseBid || !pp.coinbaseAsk) continue;

    // Route 1: buy Kraken, sell Coinbase
    const kToC = ((pp.coinbaseBid - pp.krakenAsk) / pp.krakenAsk) * 100;
    // Route 2: buy Coinbase, sell Kraken
    const cToK = ((pp.krakenBid - pp.coinbaseAsk) / pp.coinbaseAsk) * 100;

    const best = Math.max(kToC, cToK);
    if (best > bestSpread) {
      bestSpread = best;
      bestPrices = pp;
    }
  }

  return bestPrices;
}

// ── Full scan — all 10 pairs ranked by gross spread ───────────────────────────

export interface PairScanEntry {
  coin: string;                   // "BTC", "ETH", "SOL", …
  pair: Pair;                     // "BTC/USD"
  krakenPrice: number;
  coinbasePrice: number;
  krakenBid: number;
  krakenAsk: number;
  coinbaseBid: number;
  coinbaseAsk: number;
  grossSpreadPct: number;
  buyExchange: "Kraken" | "Coinbase";
  sellExchange: "Kraken" | "Coinbase";
  scannedAt: string;
}

/**
 * Port of Python scan_all_coins().
 * Fetches prices for all 10 pairs and returns them sorted by gross spread
 * (Kraken ↔ Coinbase, best direction) descending.
 */
export async function scanAllPairs(): Promise<PairScanEntry[]> {
  const allPrices = await Promise.all(PAIRS.map(p => getPairPrices(p)));
  const scannedAt = new Date().toISOString();
  const results: PairScanEntry[] = [];

  for (const pp of allPrices) {
    const { krakenBid, krakenAsk, coinbaseBid, coinbaseAsk } = pp;
    if (!krakenBid || !krakenAsk || !coinbaseBid || !coinbaseAsk) continue;

    // Route 1: buy Kraken ask → sell Coinbase bid
    const kToC = ((coinbaseBid - krakenAsk) / krakenAsk) * 100;
    // Route 2: buy Coinbase ask → sell Kraken bid
    const cToK = ((krakenBid - coinbaseAsk) / coinbaseAsk) * 100;

    const useKraken = kToC >= cToK;
    const grossSpreadPct = useKraken ? kToC : cToK;
    const coin = pp.pair.split("/")[0]!;   // "BTC/USD" → "BTC"

    results.push({
      coin,
      pair: pp.pair,
      krakenPrice:   pp.kraken   ?? (krakenBid  + krakenAsk)  / 2,
      coinbasePrice: pp.coinbase ?? (coinbaseBid + coinbaseAsk) / 2,
      krakenBid,
      krakenAsk,
      coinbaseBid,
      coinbaseAsk,
      grossSpreadPct,
      buyExchange:  useKraken ? "Kraken"   : "Coinbase",
      sellExchange: useKraken ? "Coinbase" : "Kraken",
      scannedAt,
    });
  }

  return results.sort((a, b) => b.grossSpreadPct - a.grossSpreadPct);
}

// ── Legacy AllPrices interface (kept for backward compat) ──────────────────────

export interface AllPrices {
  pair: string;
  kraken:      number | null;
  krakenBid:   number | null;
  krakenAsk:   number | null;
  coinbase:    number | null;
  coinbaseBid: number | null;
  coinbaseAsk: number | null;
  binance:     number | null;
  kucoin:      number | null;
  wsKraken:    boolean;
  wsCoinbase:  boolean;
}

/** @deprecated Use getBestPairPrices() for multi-pair scanning. */
export async function getAllPrices(): Promise<AllPrices> {
  const best = await getBestPairPrices();
  if (best) return best;
  // Absolute fallback: return SOL/USD prices even if incomplete
  return getPairPrices("SOL/USD");
}
