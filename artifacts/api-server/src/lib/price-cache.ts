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
  price: number;
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
          data?: Array<{ symbol?: string; last?: number }>;
        };
        if (msg.channel === "ticker" && msg.type === "update" && msg.data?.[0]?.last != null) {
          const last = msg.data[0].last;
          if (last && last > 0) {
            cache.kraken = { price: last, updatedAt: Date.now(), source: "ws" };
          }
        }
      } catch { /* ignore parse errors */ }
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
        const msg = JSON.parse(raw) as { type?: string; product_id?: string; price?: string };
        if (msg.type === "ticker" && msg.product_id === "SOL-USD" && msg.price) {
          const p = parseFloat(msg.price);
          if (p > 0) {
            cache.coinbase = { price: p, updatedAt: Date.now(), source: "ws" };
          }
        }
      } catch { /* ignore */ }
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
  coinbase: number | null;
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
    kraken: cache.kraken?.price ?? null,
    coinbase: cache.coinbase?.price ?? null,
    binance: cache.binance?.price ?? null,
    kucoin: cache.kucoin?.price ?? null,
    wsKraken: !!(cache.kraken?.source === "ws" && krakenFresh),
    wsCoinbase: !!(cache.coinbase?.source === "ws" && coinbaseFresh),
  };
}
