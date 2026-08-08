/**
 * book-stream.ts — live order-book streaming layer.
 *
 * Kraken WS v2 `book` channel (depth 10) for every tradable pair the scanners
 * use, plus the public Coinbase Exchange `ticker` channel for streaming best
 * bid/ask. Books are maintained in memory with a per-pair `updatedAtMs`
 * timestamp so the scanner and the executor read the exact same timestamped
 * snapshot — no REST round-trip in the hot path.
 *
 * Design:
 *  - `getStreamBook(restPairKey)` → { asks, bids, updatedAtMs, ageMs } | null
 *  - `onBookUpdate(cb)` → event-driven scan trigger (cb receives rest key)
 *  - Reconnect with capped backoff; a watchdog reconnects when no message
 *    arrives for 15 s. Books from a dropped connection are cleared so age
 *    checks can never pass on a dead stream.
 *  - REST remains the fallback in order-book.ts when a stream book is absent
 *    or too old — streaming is an accelerator, never a silent gap.
 */

type Level = [number, number]; // [price, volume]
export interface StreamBook {
  asks: Level[]; bids: Level[];
  /** Local arrival time of the last update for this book. */
  updatedAtMs: number;
  /** EXCHANGE-side timestamp of the last update (Kraken v2 `timestamp` field) — the true market-data time. Null until the first timestamped update (snapshots carry none). */
  exchangeTsMs: number | null;
}

const DEPTH = 10;

// ── Kraken ────────────────────────────────────────────────────────────────────

const krakenBooks = new Map<string, StreamBook>();  // keyed by REST pair key (e.g. XXBTZUSD)
const wsnameToRest = new Map<string, string>();     // "BTC/USD" → "XXBTZUSD"
const restToWsname = new Map<string, string>();
const updateListeners: Array<(restKey: string) => void> = [];

let krakenWs: WebSocket | null = null;
let krakenConnected = false;
let krakenLastMsgAt = 0;
let krakenLastExchTsMs = 0; // newest exchange-side timestamp across all tracked book updates
let reconnectDelayMs = 1_000;
let trackedRestKeys: string[] = [];
let stopped = false;

export function onBookUpdate(cb: (restKey: string) => void): () => void {
  updateListeners.push(cb);
  return () => { const i = updateListeners.indexOf(cb); if (i >= 0) updateListeners.splice(i, 1); };
}

export function getStreamBook(restPairKey: string): (StreamBook & { ageMs: number }) | null {
  const b = krakenBooks.get(restPairKey);
  if (!b || b.asks.length === 0 || b.bids.length === 0) return null;
  // Age is PER-LEG and measured from THIS pair's own EXCHANGE update
  // timestamp (market-data time) — never from when we cached or read the
  // object, and never discounted by activity on OTHER pairs or the
  // connection. A silently stalled subscription must read as stale even
  // while the rest of the feed is busy; the trader's rule is that any stale
  // leg makes the whole route stale. Quiet pairs simply wait for their next
  // tick (waitForBookTouch). Clock skew clamped at 0.
  const now = Date.now();
  const ageMs = Math.max(0, now - (b.exchangeTsMs ?? b.updatedAtMs));
  return { ...b, ageMs };
}

export function krakenStreamStats(): { connected: boolean; books: number; tracked: number; lastMsgAgeMs: number | null } {
  return {
    connected: krakenConnected,
    books: krakenBooks.size,
    tracked: trackedRestKeys.length,
    lastMsgAgeMs: krakenLastMsgAt ? Date.now() - krakenLastMsgAt : null,
  };
}

async function loadWsnames(restKeys: string[]): Promise<void> {
  const r = await fetch("https://api.kraken.com/0/public/AssetPairs", { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`AssetPairs HTTP ${r.status}`);
  const j = await r.json() as { error?: string[]; result?: Record<string, { wsname?: string; altname?: string }> };
  if (j.error?.length || !j.result) throw new Error(`AssetPairs error: ${j.error?.join(",")}`);
  const wanted = new Set(restKeys);
  // WS v2 uses standardized symbols (BTC/USD, DOGE/USD); AssetPairs wsname
  // still reports the legacy codes (XBT/USD, XDG/USD). Translate.
  const toV2Symbol = (wsname: string): string =>
    wsname.split("/").map(part => (part === "XBT" ? "BTC" : part === "XDG" ? "DOGE" : part)).join("/");
  for (const [restKey, v] of Object.entries(j.result)) {
    if (!v.wsname) continue;
    // Track by REST key OR altname — callers use both forms.
    const hitKey = wanted.has(restKey) ? restKey : v.altname && wanted.has(v.altname) ? v.altname : null;
    if (!hitKey) continue;
    const sym = toV2Symbol(v.wsname);
    wsnameToRest.set(sym, hitKey);
    restToWsname.set(hitKey, sym);
  }
}

function applyDelta(side: Level[], price: number, qty: number, desc: boolean): void {
  const i = side.findIndex(([p]) => p === price);
  if (qty === 0) { if (i >= 0) side.splice(i, 1); return; }
  if (i >= 0) { side[i]![1] = qty; return; }
  const at = side.findIndex(([p]) => (desc ? p < price : p > price));
  if (at >= 0) side.splice(at, 0, [price, qty]); else side.push([price, qty]);
  if (side.length > DEPTH) side.length = DEPTH;
}

interface WsLevel { price: number; qty: number; }
interface WsBookMsg { channel?: string; type?: string; data?: Array<{ symbol: string; bids?: WsLevel[]; asks?: WsLevel[]; timestamp?: string }>; }

function handleKrakenMessage(raw: string): void {
  krakenLastMsgAt = Date.now();
  // krakenLastExchTs: newest EXCHANGE timestamp seen on any tracked book update.
  // Connection currency is measured against this, not local arrival time.
  let msg: WsBookMsg;
  try { msg = JSON.parse(raw) as WsBookMsg; } catch { return; }
  if (msg.channel !== "book" || !msg.data) return;
  const now = Date.now();
  for (const d of msg.data) {
    const restKey = wsnameToRest.get(d.symbol);
    if (!restKey) continue;
    if (msg.type === "snapshot") {
      krakenBooks.set(restKey, {
        asks: (d.asks ?? []).map(l => [l.price, l.qty] as Level).slice(0, DEPTH),
        bids: (d.bids ?? []).map(l => [l.price, l.qty] as Level).slice(0, DEPTH),
        updatedAtMs: now,
        exchangeTsMs: null, // snapshots carry no exchange timestamp; first update sets it
      });
    } else if (msg.type === "update") {
      const book = krakenBooks.get(restKey);
      if (!book) continue; // update before snapshot — ignore until resync
      for (const l of d.asks ?? []) applyDelta(book.asks, l.price, l.qty, false);
      for (const l of d.bids ?? []) applyDelta(book.bids, l.price, l.qty, true);
      book.updatedAtMs = now;
      const exch = d.timestamp ? Date.parse(d.timestamp) : NaN;
      if (Number.isFinite(exch)) {
        book.exchangeTsMs = exch;
        if (exch > krakenLastExchTsMs) krakenLastExchTsMs = exch;
      }
    } else continue;
    for (const cb of updateListeners) { try { cb(restKey); } catch { /* listener errors must not kill the feed */ } }
  }
}

function connectKraken(): void {
  if (stopped) return;
  try {
    const ws = new WebSocket("wss://ws.kraken.com/v2");
    krakenWs = ws;
    ws.onopen = () => {
      krakenConnected = true;
      reconnectDelayMs = 1_000;
      const symbols = trackedRestKeys.map(k => restToWsname.get(k)).filter((s): s is string => !!s);
      // Kraken caps subscribe payloads — chunk the symbol list.
      for (let i = 0; i < symbols.length; i += 50) {
        ws.send(JSON.stringify({ method: "subscribe", params: { channel: "book", symbol: symbols.slice(i, i + 50), depth: DEPTH } }));
      }
      console.log(`[BookStream] Kraken WS connected — subscribing ${symbols.length} pairs (depth ${DEPTH})`);
    };
    ws.onmessage = ev => handleKrakenMessage(typeof ev.data === "string" ? ev.data : "");
    ws.onclose = () => {
      krakenConnected = false;
      krakenBooks.clear(); // never serve books from a dead stream
      if (stopped) return;
      console.warn(`[BookStream] Kraken WS closed — reconnecting in ${reconnectDelayMs}ms`);
      setTimeout(connectKraken, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* triggers onclose path */ } };
  } catch (err) {
    console.warn("[BookStream] Kraken WS connect failed:", err);
    setTimeout(connectKraken, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  }
}

/** Start (or extend) the Kraken book stream for the given REST pair keys. */
export async function startKrakenBookStream(restPairKeys: string[]): Promise<void> {
  const fresh = [...new Set(restPairKeys)];
  const added = fresh.filter(k => !trackedRestKeys.includes(k));
  trackedRestKeys = [...new Set([...trackedRestKeys, ...fresh])];
  try { await loadWsnames(trackedRestKeys); } catch (err) {
    console.warn("[BookStream] wsname mapping failed — stream disabled until next start attempt:", err);
    return;
  }
  if (!krakenWs || krakenWs.readyState === WebSocket.CLOSED || krakenWs.readyState === WebSocket.CLOSING) {
    connectKraken();
  } else if (krakenConnected && added.length) {
    const symbols = added.map(k => restToWsname.get(k)).filter((s): s is string => !!s);
    for (let i = 0; i < symbols.length; i += 50) {
      krakenWs.send(JSON.stringify({ method: "subscribe", params: { channel: "book", symbol: symbols.slice(i, i + 50), depth: DEPTH } }));
    }
  }
  // Watchdog: silent for 15s → force reconnect (Kraken heartbeats every ~1s).
  setInterval(() => {
    if (stopped || !krakenConnected) return;
    if (krakenLastMsgAt && Date.now() - krakenLastMsgAt > 15_000) {
      console.warn("[BookStream] Kraken WS silent >15s — forcing reconnect");
      try { krakenWs?.close(); } catch { /* onclose reconnects */ }
    }
  }, 5_000).unref?.();
}

// ── Coinbase (public ticker stream: best bid/ask) ─────────────────────────────

export interface StreamTicker { bid: number; ask: number; price: number; updatedAtMs: number; }
const coinbaseTickers = new Map<string, StreamTicker>(); // keyed by product id, e.g. ETH-USD
let coinbaseWs: WebSocket | null = null;
let coinbaseConnected = false;
let cbReconnectMs = 1_000;
let cbProducts: string[] = [];

export function getStreamTicker(productId: string): (StreamTicker & { ageMs: number }) | null {
  const t = coinbaseTickers.get(productId);
  if (!t) return null;
  return { ...t, ageMs: Date.now() - t.updatedAtMs };
}

export function coinbaseStreamStats(): { connected: boolean; tickers: number } {
  return { connected: coinbaseConnected, tickers: coinbaseTickers.size };
}

function connectCoinbase(): void {
  if (stopped) return;
  try {
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    coinbaseWs = ws;
    ws.onopen = () => {
      coinbaseConnected = true;
      cbReconnectMs = 1_000;
      ws.send(JSON.stringify({ type: "subscribe", product_ids: cbProducts, channels: ["ticker"] }));
      console.log(`[BookStream] Coinbase ticker WS connected — ${cbProducts.length} products`);
    };
    ws.onmessage = ev => {
      if (typeof ev.data !== "string") return;
      try {
        const m = JSON.parse(ev.data) as { type?: string; product_id?: string; best_bid?: string; best_ask?: string; price?: string };
        if (m.type !== "ticker" || !m.product_id) return;
        const bid = parseFloat(m.best_bid ?? ""); const ask = parseFloat(m.best_ask ?? ""); const price = parseFloat(m.price ?? "");
        if (!isFinite(bid) || !isFinite(ask)) return;
        coinbaseTickers.set(m.product_id, { bid, ask, price: isFinite(price) ? price : (bid + ask) / 2, updatedAtMs: Date.now() });
      } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      coinbaseConnected = false;
      coinbaseTickers.clear();
      if (stopped) return;
      setTimeout(connectCoinbase, cbReconnectMs);
      cbReconnectMs = Math.min(cbReconnectMs * 2, 30_000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* onclose reconnects */ } };
  } catch {
    setTimeout(connectCoinbase, cbReconnectMs);
    cbReconnectMs = Math.min(cbReconnectMs * 2, 30_000);
  }
}

export function startCoinbaseTickerStream(productIds: string[]): void {
  cbProducts = [...new Set([...cbProducts, ...productIds])];
  if (!coinbaseWs || coinbaseWs.readyState === WebSocket.CLOSED || coinbaseWs.readyState === WebSocket.CLOSING) connectCoinbase();
}

export function stopBookStreams(): void {
  stopped = true;
  try { krakenWs?.close(); } catch { /* shutdown */ }
  try { coinbaseWs?.close(); } catch { /* shutdown */ }
}
