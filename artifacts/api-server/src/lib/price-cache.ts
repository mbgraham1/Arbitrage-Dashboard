/**
 * price-cache.ts — v5.0 multi-exchange price aggregator
 *
 * • Maintains persistent WebSocket connections to Kraken (v2) and Coinbase Exchange
 * • Falls back to REST if WS price is stale (> 10 s)
 * • Polls Binance and KuCoin via REST on a background timer
 * • All reconnections are handled automatically
 */

import { getKrakenPrice, getCoinbasePrice } from "./exchange";

const WS_STALE_MS = 10_000; // treat WS price as stale after 10 s
const BINANCE_KU_POLL_MS = 5_000; // REST poll interval for Binance + KuCoin

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

function startKrakenWs(): void {
  reconnectingWs(
    "wss://ws.kraken.com/v2",
    (ws) => {
      ws.send(JSON.stringify({
        method: "subscribe",
        params: { channel: "ticker", symbol: ["SOL/USD"] },
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
        if (msg.channel === "ticker" && msg.type === "update" && msg.data?.[0] != null) {
          const d = msg.data[0];
          const bid = d.bid;
          const ask = d.ask;
          const last = d.last;
          const mid = (bid != null && ask != null) ? (bid + ask) / 2 : (last ?? 0);
          if (mid > 0) {
            cache.kraken = { price: mid, bid, ask, updatedAt: Date.now(), source: "ws" };
          }
        }
      } catch (e) { console.error(`[price-cache] Kraken WS message error: ${e}`); }
    },
    "Kraken"
  );
}

// ── Coinbase Exchange WebSocket ────────────────────────────────────────────────

function startCoinbaseWs(): void {
  reconnectingWs(
    "wss://ws-feed.exchange.coinbase.com",
    (ws) => {
      ws.send(JSON.stringify({
        type: "subscribe",
        product_ids: ["SOL-USD"],
        channels: ["ticker"],
      }));
    },
    (raw) => {
      try {
        const msg = JSON.parse(raw) as { type?: string; product_id?: string; price?: string; best_bid?: string; best_ask?: string };
        if (msg.type === "ticker" && msg.product_id === "SOL-USD" && msg.price) {
          const price = parseFloat(msg.price);
          const bid   = msg.best_bid ? parseFloat(msg.best_bid) : undefined;
          const ask   = msg.best_ask ? parseFloat(msg.best_ask) : undefined;
          if (price > 0) {
            cache.coinbase = { price, bid, ask, updatedAt: Date.now(), source: "ws" };
          }
        }
      } catch (e) { console.error(`[price-cache] Coinbase WS message error: ${e}`); }
    },
    "Coinbase"
  );
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

// ── Public interface ───────────────────────────────────────────────────────────

/** Call once at server startup. Safe to call multiple times (idempotent). */
let initialized = false;
export function initPriceFeeds(): void {
  if (initialized) return;
  initialized = true;
  startKrakenWs();
  startCoinbaseWs();
  startRestPollers();
  console.log("[price-cache] Price feeds initialised");
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
  if (!krakenFresh) fallbacks.push(getKrakenPrice().then(p => { cache.kraken = { price: p, updatedAt: Date.now(), source: "rest" }; }).catch(() => {}));
  if (!coinbaseFresh) fallbacks.push(getCoinbasePrice().then(p => { cache.coinbase = { price: p, updatedAt: Date.now(), source: "rest" }; }).catch(() => {}));
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
