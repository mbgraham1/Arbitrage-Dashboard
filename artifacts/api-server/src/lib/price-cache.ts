/**
 * price-cache.ts — v5.1 multi-exchange price aggregator
 *
 * • Maintains persistent WebSocket connections to Kraken (v2) and Coinbase Exchange
 * • Falls back to REST if WS price is stale (> 10 s)
 * • Polls Binance and KuCoin via REST on a background timer
 * • Tracks ETH/USD and ETH/SOL for triangular arbitrage detection
 * • All reconnections are handled automatically
 */

import { getKrakenPrice, getCoinbasePrice } from "./exchange";

const WS_STALE_MS = 15_000; // treat WS price as stale after 15 s (matches Python prices_fresh check)
const BINANCE_KU_POLL_MS = 5_000; // REST poll interval for Binance + KuCoin
const TRI_POLL_MS = 3_000;  // ETH/USD + ETH/SOL REST poll interval for triangular arb

interface CacheEntry {
  price: number;   // mid/last — used for REST fallback and reference prices
  bid?: number;    // best bid (sell here)
  ask?: number;    // best ask (buy here)
  updatedAt: number;
  source: "ws" | "rest";
}

const cache: { [K in "kraken" | "coinbase" | "binance" | "kucoin"]: CacheEntry | null } = {
  kraken: null,
  coinbase: null,
  binance: null,
  kucoin: null,
};

// ── Triangular arb price cache (ETH/USD and ETH/SOL per exchange) ──────────────
interface TriEntry {
  bid: number;
  ask: number;
  updatedAt: number;
}

const triCache: {
  krakenEthUsd: TriEntry | null;
  krakenEthSol: TriEntry | null;
  coinbaseEthUsd: TriEntry | null;
  coinbaseEthSol: TriEntry | null;
  binanceEthUsd: TriEntry | null;
  kucoinEthUsd: TriEntry | null;
} = {
  krakenEthUsd: null,
  krakenEthSol: null,
  coinbaseEthUsd: null,
  coinbaseEthSol: null,
  binanceEthUsd: null,
  kucoinEthUsd: null,
};

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
// Subscribes to SOL/USD, ETH/USD, and ETH/SOL in a single connection.

function startKrakenWs(): void {
  reconnectingWs(
    "wss://ws.kraken.com/v2",
    (ws) => {
      ws.send(JSON.stringify({
        method: "subscribe",
        params: { channel: "ticker", symbol: ["SOL/USD", "ETH/USD", "ETH/SOL"] },
      }));
    },
    (raw) => {
      try {
        // v2 format: {"channel":"ticker","type":"update","data":[{"symbol":"SOL/USD","last":163.45,...}]}
        const msg = JSON.parse(raw) as {
          channel?: string;
          type?: string;
          data?: Array<{ symbol?: string; last?: number; bid?: number; ask?: number }>;
        };
        // Accept both snapshot (initial) and update messages
        if (msg.channel === "ticker" && (msg.type === "update" || msg.type === "snapshot") && msg.data != null) {
          for (const d of msg.data) {
            const bid = d.bid;
            const ask = d.ask;
            const last = d.last;
            const mid = (bid != null && ask != null) ? (bid + ask) / 2 : (last ?? 0);
            if (mid <= 0) continue;

            if (d.symbol === "SOL/USD") {
              cache.kraken = { price: mid, bid: bid ?? mid, ask: ask ?? mid, updatedAt: Date.now(), source: "ws" };
            } else if (d.symbol === "ETH/USD") {
              triCache.krakenEthUsd = { bid: bid ?? mid, ask: ask ?? mid, updatedAt: Date.now() };
            } else if (d.symbol === "ETH/SOL") {
              triCache.krakenEthSol = { bid: bid ?? mid, ask: ask ?? mid, updatedAt: Date.now() };
            }
          }
        }
      } catch (e) { console.error(`[price-cache] Kraken WS message error: ${e}`); }
    },
    "Kraken"
  );
}

// ── Coinbase REST fast-poll ────────────────────────────────────────────────────
// The Coinbase Advanced Trade v3 brokerage/best_bid_ask endpoint requires auth.
// We use two public fallbacks instead:
//   • SOL/USD: api.coinbase.com/v2/prices/SOL-USD/spot  (spot mid only — no bid/ask)
//   • ETH/USD: api.exchange.coinbase.com/products/ETH-USD/ticker  (has bid + ask)
// ETH/SOL has no public Coinbase endpoint; we rely on synthetic derivation.

async function fetchCoinbaseSolUsd(): Promise<void> {
  try {
    // Same endpoint getCoinbasePrice() uses — returns spot mid price
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", {
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok) return;
    const j = await r.json() as { data?: { amount?: string } };
    const p = parseFloat(j.data?.amount ?? "0");
    if (p > 0) {
      // Mark as "ws" so wsStatus.coinbase stays true — prices are fresh (≤2 s)
      cache.coinbase = { price: p, bid: p, ask: p, updatedAt: Date.now(), source: "ws" };
    }
  } catch { /* ignore */ }
}

async function fetchCoinbaseEthUsd(): Promise<void> {
  try {
    // Public Exchange REST ticker — returns bid, ask, and last price
    const r = await fetch("https://api.exchange.coinbase.com/products/ETH-USD/ticker", {
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok) return;
    const j = await r.json() as { bid?: string; ask?: string; price?: string };
    const bid = parseFloat(j.bid ?? "0");
    const ask = parseFloat(j.ask ?? "0");
    const last = parseFloat(j.price ?? "0");
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
    if (mid > 0) {
      triCache.coinbaseEthUsd = { bid: bid || mid, ask: ask || mid, updatedAt: Date.now() };
    }
  } catch { /* ignore */ }
}

function startCoinbaseFastPoll(): void {
  const poll = () => {
    void fetchCoinbaseSolUsd();
    void fetchCoinbaseEthUsd();
  };
  poll(); // immediate first run
  setInterval(poll, 2_000);
}

// ── Binance ETH/USD REST poll (for triangular scan reference) ─────────────────
// Binance lacks a direct ETH/SOL pair so we poll ETH/USDT alongside SOLUSDT
// and derive a synthetic ETH/SOL cross. Results feed the triangular scan.

async function fetchBinanceEthPrice(): Promise<void> {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/bookTicker?symbol=ETHUSDT", {
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return;
    const j = await r.json() as { bidPrice?: string; askPrice?: string };
    const bid = parseFloat(j.bidPrice ?? "0");
    const ask = parseFloat(j.askPrice ?? "0");
    if (bid > 0 && ask > 0) {
      triCache.binanceEthUsd = { bid, ask, updatedAt: Date.now() };
    }
  } catch { /* ignore */ }
}

// ── KuCoin ETH/USDT REST poll ──────────────────────────────────────────────────

async function fetchKuCoinEthPrice(): Promise<void> {
  try {
    const r = await fetch(
      "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=ETH-USDT",
      { signal: AbortSignal.timeout(4_000) }
    );
    if (!r.ok) return;
    const j = await r.json() as { data?: { bestBid?: string; bestAsk?: string } };
    const bid = parseFloat(j.data?.bestBid ?? "0");
    const ask = parseFloat(j.data?.bestAsk ?? "0");
    if (bid > 0 && ask > 0) {
      triCache.kucoinEthUsd = { bid, ask, updatedAt: Date.now() };
    }
  } catch { /* ignore */ }
}

// ── Binance + KuCoin REST poll ─────────────────────────────────────────────────

async function fetchBinancePrice(): Promise<void> {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return;
    const j = await r.json() as { price?: string };
    const p = parseFloat(j.price ?? "0");
    if (p > 0) cache.binance = { price: p, updatedAt: Date.now(), source: "rest" };
  } catch { /* ignore */ }
}

async function fetchKuCoinPrice(): Promise<void> {
  try {
    const r = await fetch(
      "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=SOL-USDT",
      { signal: AbortSignal.timeout(4_000) }
    );
    if (!r.ok) return;
    const j = await r.json() as { data?: { price?: string } };
    const p = parseFloat(j.data?.price ?? "0");
    if (p > 0) cache.kucoin = { price: p, updatedAt: Date.now(), source: "rest" };
  } catch { /* ignore */ }
}

function startRestPollers(): void {
  const poll = () => {
    void fetchBinancePrice();
    void fetchKuCoinPrice();
  };
  poll(); // immediate first run
  setInterval(poll, BINANCE_KU_POLL_MS);
}

function startTriPollers(): void {
  const poll = () => {
    void fetchBinanceEthPrice();
    void fetchKuCoinEthPrice();
  };
  poll();
  setInterval(poll, TRI_POLL_MS);
}

// ── Public interface ───────────────────────────────────────────────────────────

/** Call once at server startup. Safe to call multiple times (idempotent). */
let initialized = false;
export function initPriceFeeds(): void {
  if (initialized) return;
  initialized = true;
  startKrakenWs();
  startCoinbaseFastPoll(); // replaces Exchange WS (auth-gated); polls every 2 s
  startRestPollers();
  startTriPollers(); // ETH/USD via Binance+KuCoin REST for triangular arb
  console.log("[price-cache] Price feeds initialised (incl. triangular ETH feeds)");
}

export interface TriPrices {
  /** SOL/USD bid/ask per exchange */
  kraken: { solBid: number; solAsk: number; ethBid: number; ethAsk: number; ethSolBid: number; ethSolAsk: number } | null;
  coinbase: { solBid: number; solAsk: number; ethBid: number; ethAsk: number; ethSolBid: number; ethSolAsk: number } | null;
}

const TRI_STALE_MS = 30_000; // tri prices older than 30 s are considered stale

/**
 * Returns per-exchange ETH/USD and ETH/SOL bid/ask prices for triangular arb scanning.
 *
 * IMPORTANT: each exchange's loop must only use price legs from THAT SAME exchange.
 * Cross-exchange mixing would make the "opportunity" non-executable (you couldn't
 * leg into all three steps on one venue) and produce false positives/negatives.
 *
 * Per-exchange policy:
 *   Kraken:   SOL/USD (WS) + ETH/USD (WS) + ETH/SOL (WS direct, else synthetic)
 *   Coinbase: SOL/USD (REST poll) + ETH/USD (REST poll) + ETH/SOL (REST direct, else synthetic)
 *
 * Synthetic ETH/SOL cross = ETH/USD bid-ask ÷ SOL/USD ask-bid (same exchange only).
 * With purely synthetic rates the triangular loops always yield a product ≤ 1
 * (no opportunity) — only a live direct ETH/SOL market deviating from the cross
 * rate can yield genuine arb. This is the mathematically correct behaviour.
 *
 * Binance/KuCoin ETH prices are NOT used as fallbacks for Kraken or Coinbase — that
 * would silently cross-exchange the ETH/USD leg.
 */
export function getTriPrices(): TriPrices {
  const now = Date.now();
  const fresh = (e: TriEntry | null) => !!(e && now - e.updatedAt < TRI_STALE_MS);

  // ── Derive synthetic ETH/SOL cross bid/ask using legs from the same exchange ─
  // Selling ETH → receive SOL: cross bid  = ethBid  / solAsk (sell ETH at ETH/USD bid, buy SOL at SOL/USD ask)
  // Buying  ETH ← pay   SOL:  cross ask  = ethAsk  / solBid (buy  ETH at ETH/USD ask, sell SOL at SOL/USD bid)
  const syntheticEthSol = (
    ethBid: number, ethAsk: number,
    solBid: number, solAsk: number,
  ): { bid: number; ask: number } => ({
    bid: solAsk > 0 ? ethBid / solAsk : 0,
    ask: solBid > 0 ? ethAsk / solBid : 0,
  });

  // ── Kraken — all legs must come from Kraken price cache ───────────────────
  let krakenResult: TriPrices["kraken"] = null;
  if (
    cache.kraken && now - cache.kraken.updatedAt < TRI_STALE_MS &&
    fresh(triCache.krakenEthUsd)   // require Kraken's own ETH/USD (from Kraken WS)
  ) {
    const solBid = cache.kraken.bid ?? cache.kraken.price;
    const solAsk = cache.kraken.ask ?? cache.kraken.price;
    const kEth = triCache.krakenEthUsd!;
    // Prefer Kraken's direct ETH/SOL market; fall back to synthetic from Kraken-only legs
    const ethSol = fresh(triCache.krakenEthSol)
      ? { bid: triCache.krakenEthSol!.bid, ask: triCache.krakenEthSol!.ask }
      : syntheticEthSol(kEth.bid, kEth.ask, solBid, solAsk);
    if (ethSol.bid > 0 && ethSol.ask > 0) {
      krakenResult = {
        solBid,
        solAsk,
        ethBid: kEth.bid,
        ethAsk: kEth.ask,
        ethSolBid: ethSol.bid,
        ethSolAsk: ethSol.ask,
      };
    }
  }

  // ── Coinbase — all legs must come from Coinbase price cache ───────────────
  let coinbaseResult: TriPrices["coinbase"] = null;
  if (
    cache.coinbase && now - cache.coinbase.updatedAt < TRI_STALE_MS &&
    fresh(triCache.coinbaseEthUsd)  // require Coinbase's own ETH/USD (from Coinbase REST poll)
  ) {
    const solBid = cache.coinbase.bid ?? cache.coinbase.price;
    const solAsk = cache.coinbase.ask ?? cache.coinbase.price;
    const cEth = triCache.coinbaseEthUsd!;
    // Prefer Coinbase's direct ETH/SOL; fall back to synthetic from Coinbase-only legs
    const ethSol = fresh(triCache.coinbaseEthSol)
      ? { bid: triCache.coinbaseEthSol!.bid, ask: triCache.coinbaseEthSol!.ask }
      : syntheticEthSol(cEth.bid, cEth.ask, solBid, solAsk);
    if (ethSol.bid > 0 && ethSol.ask > 0) {
      coinbaseResult = {
        solBid,
        solAsk,
        ethBid: cEth.bid,
        ethAsk: cEth.ask,
        ethSolBid: ethSol.bid,
        ethSolAsk: ethSol.ask,
      };
    }
  }

  return { kraken: krakenResult, coinbase: coinbaseResult };
}

export interface AllPrices {
  kraken: number | null;
  krakenBid: number | null;
  krakenAsk: number | null;
  coinbase: number | null;
  coinbaseBid: number | null;
  coinbaseAsk: number | null;
  binance: number | null;
  kucoin: number | null;
  wsKraken: boolean;
  wsCoinbase: boolean;
}

/**
 * Returns latest prices from cache.
 * If a WS price is stale (> WS_STALE_MS), attempts a REST refresh before returning.
 */
export async function getAllPrices(): Promise<AllPrices> {
  const now = Date.now();

  // If WS prices are stale, fall back to REST
  const krakenFresh = cache.kraken && now - cache.kraken.updatedAt < WS_STALE_MS;
  const coinbaseFresh = cache.coinbase && now - cache.coinbase.updatedAt < WS_STALE_MS;

  const fallbacks: Promise<void>[] = [];
  if (!krakenFresh) fallbacks.push(getKrakenPrice().then(p => { cache.kraken = { price: p, bid: p, ask: p, updatedAt: Date.now(), source: "rest" }; }).catch(() => {}));
  if (!coinbaseFresh) fallbacks.push(getCoinbasePrice().then(p => { cache.coinbase = { price: p, bid: p, ask: p, updatedAt: Date.now(), source: "rest" }; }).catch(() => {}));
  if (fallbacks.length) await Promise.all(fallbacks);

  return {
    kraken:      cache.kraken?.price   ?? null,
    krakenBid:   cache.kraken?.bid     ?? cache.kraken?.price   ?? null,
    krakenAsk:   cache.kraken?.ask     ?? cache.kraken?.price   ?? null,
    coinbase:    cache.coinbase?.price ?? null,
    coinbaseBid: cache.coinbase?.bid   ?? cache.coinbase?.price ?? null,
    coinbaseAsk: cache.coinbase?.ask   ?? cache.coinbase?.price ?? null,
    binance:     cache.binance?.price  ?? null,
    kucoin:      cache.kucoin?.price   ?? null,
    wsKraken:   !!(cache.kraken?.source   === "ws" && krakenFresh),
    wsCoinbase: !!(cache.coinbase?.source === "ws" && coinbaseFresh),
  };
}
