/**
 * Exchange integration helpers for Kraken and Coinbase Advanced Trade API.
 * Uses only Node.js built-in crypto + fetch (Node 24+).
 */
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getStreamTicker } from "./book-stream";

// ---------------------------------------------------------------------------
// Pair symbol mappings
// ---------------------------------------------------------------------------

export const PAIRS = [
  "BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD", "DOT/USD",
  "POL/USD", "LINK/USD", "UNI/USD", "ATOM/USD", "ADA/USD",
  // Broadened liquid universe shared by Kraken AND Coinbase (cross-exchange arb)
  "XRP/USD", "DOGE/USD", "LTC/USD", "BCH/USD", "AAVE/USD", "FIL/USD",
] as const;
export type Pair = typeof PAIRS[number];

/** Kraken REST API pair symbols (used in /0/public/Ticker and AddOrder). */
export const KRAKEN_REST_PAIRS: Record<Pair, string> = {
  "BTC/USD":  "XBTUSD",
  "ETH/USD":  "ETHUSD",
  "SOL/USD":  "SOLUSD",
  "AVAX/USD": "AVAXUSD",
  "DOT/USD":  "DOTUSD",
  "POL/USD":  "POLUSD",    // Polygon rebranded from MATIC → POL
  "LINK/USD": "LINKUSD",
  "UNI/USD":  "UNIUSD",
  "ATOM/USD": "ATOMUSD",
  "ADA/USD":  "ADAUSD",    // Cardano — replaces FTM (no Coinbase USD market)
  "XRP/USD":  "XRPUSD",
  "DOGE/USD": "XDGUSD",    // Kraken legacy DOGE altname
  "LTC/USD":  "LTCUSD",
  "BCH/USD":  "BCHUSD",
  "AAVE/USD": "AAVEUSD",
  "FIL/USD":  "FILUSD",
};

/** Coinbase product IDs (dash-notation). */
export const COINBASE_PRODUCTS: Record<Pair, string> = {
  "BTC/USD":  "BTC-USD",
  "ETH/USD":  "ETH-USD",
  "SOL/USD":  "SOL-USD",
  "AVAX/USD": "AVAX-USD",
  "DOT/USD":  "DOT-USD",
  "POL/USD":  "POL-USD",   // Coinbase uses POL-USD (Polygon rebrand)
  "LINK/USD": "LINK-USD",
  "UNI/USD":  "UNI-USD",
  "ATOM/USD": "ATOM-USD",
  "ADA/USD":  "ADA-USD",
  "XRP/USD":  "XRP-USD",
  "DOGE/USD": "DOGE-USD",
  "LTC/USD":  "LTC-USD",
  "BCH/USD":  "BCH-USD",
  "AAVE/USD": "AAVE-USD",
  "FIL/USD":  "FIL-USD",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BalanceEntry {
  currency: string;
  amount: number;
}

export interface KrakenCreds {
  krakenKey: string;
  krakenSecret: string;
}

export interface CoinbaseCreds {
  coinbaseKey: string;
  coinbaseSecret: string;
}

// ---------------------------------------------------------------------------
// Kraken helpers
// ---------------------------------------------------------------------------

const KRAKEN_BASE = "https://api.kraken.com";

function krakenSign(path: string, nonce: string, postData: string, secret: string): string {
  const encoded = Buffer.from(nonce + postData);
  const sha256Hash = crypto.createHash("sha256").update(encoded).digest();
  const message = Buffer.concat([Buffer.from(path), sha256Hash]);
  const decodedSecret = Buffer.from(secret, "base64");
  return crypto.createHmac("sha512", decodedSecret).update(message).digest("base64");
}

async function krakenPublicRequest<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const url = `${KRAKEN_BASE}${path}${qs ? `?${qs}` : ""}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Kraken HTTP ${resp.status}`);
  const json = await resp.json() as { error?: string[]; result?: T };
  if (json.error?.length) throw new Error("Kraken: " + json.error.join("; "));
  return json.result as T;
}

// ── Kraken private-API protection ─────────────────────────────────────────────
// Kraken rate-limits PRIVATE endpoints per account (counter decays slowly).
// Hitting the cap returns "EAPI:Rate limit exceeded" and locks the account out
// for tens of seconds — which froze the engine mid-session. Defenses:
//   1. A shared serial queue with a minimum gap between private calls.
//   2. Exponential backoff when Kraken returns a rate-limit error; while the
//      backoff window is open every private call waits for it to close.
//   3. Read results (Balance, TradeVolume) are cached by the callers below.
// Order placement (AddOrder/Cancel) shares the queue but is never retried —
// a rate-limited AddOrder was rejected before acceptance, and callers own
// their own unwind logic.
const PRIVATE_MIN_GAP_MS = 600;
const RATE_BACKOFF_MAX_MS = 60_000;

// Per-API-key limiter state: Kraken rate-limits per account, and one key's
// backoff must never delay another key's orders. The serial chain also keeps
// this process's nonces monotonically increasing per key.
interface KeyLimiterState { chain: Promise<unknown>; lastAt: number; rateLimitedUntil: number; backoffMs: number; }
const keyLimiters = new Map<string, KeyLimiterState>();
function limiterFor(key: string): KeyLimiterState {
  let st = keyLimiters.get(key);
  if (!st) { st = { chain: Promise.resolve(), lastAt: 0, rateLimitedUntil: 0, backoffMs: 2_000 }; keyLimiters.set(key, st); }
  return st;
}

function isRateLimitError(e: unknown): boolean {
  return e instanceof Error && /EAPI:Rate limit/i.test(e.message);
}

// ── Nonce monotonicity + concurrent-use detection ────────────────────────────
// The limiter keeps nonces monotonic WITHIN this process, but Kraken nonces
// are per API KEY, account-wide: if the published (production) app and the
// dev workspace both run the bot with the SAME key, their nonces interleave
// and Kraken rejects calls with "EAPI:Invalid nonce" — and both processes
// also share one rate budget. We can't serialize across processes, so we:
//   1. Generate strictly-increasing per-key nonces (BigInt, µs-scale) so this
//      process is never the cause of its own nonce errors.
//   2. Retry ONCE on a nonce error — Kraken rejects nonce failures before the
//      request is processed (no order placed), so a single retry is safe for
//      reads AND orders and papers over a lone collision.
//   3. Track nonce errors per key; repeated errors within a short window mean
//      another process is using the same key. That state is surfaced to the
//      dashboard (execution-status endpoint) as a clear warning instead of a
//      mysterious stream of failed calls.
const NONCE_ERROR_WINDOW_MS = 10 * 60_000; // errors within 10min count toward the flag
const NONCE_CONFLICT_THRESHOLD = 2;        // ≥2 in-window errors ⇒ concurrent use suspected

interface KeyNonceState { lastNonce: bigint; errorTimes: number[]; lastErrorAt: number | null; totalErrors: number; }
const nonceStates = new Map<string, KeyNonceState>();
function nonceStateFor(key: string): KeyNonceState {
  let st = nonceStates.get(key);
  if (!st) { st = { lastNonce: 0n, errorTimes: [], lastErrorAt: null, totalErrors: 0 }; nonceStates.set(key, st); }
  return st;
}

/** Strictly-increasing per-key nonce. Scale is ms×100,000 — the SAME
 *  magnitude as the legacy format (Date.now() string + 5 random digits), so
 *  a restart immediately exceeds any nonce a previous run sent to Kraken
 *  (a smaller scale would leave every call stuck under the key's recorded
 *  high-water nonce). The +1 fallback guards same-millisecond bursts.
 *  Exported for tests only. */
export function nextNonce(key: string): string {
  const st = nonceStateFor(key);
  let candidate = BigInt(Date.now()) * 100000n;
  if (candidate <= st.lastNonce) candidate = st.lastNonce + 1n;
  st.lastNonce = candidate;
  return candidate.toString();
}

function isNonceError(e: unknown): boolean {
  return e instanceof Error && /EAPI:Invalid nonce/i.test(e.message);
}

/** Exported for tests only. */
export function recordNonceError(key: string): void {
  const st = nonceStateFor(key);
  const now = Date.now();
  st.errorTimes = st.errorTimes.filter(t => now - t < NONCE_ERROR_WINDOW_MS);
  st.errorTimes.push(now);
  st.lastErrorAt = now;
  st.totalErrors++;
}

export interface KrakenNonceHealth {
  /** True when repeated nonce errors indicate ANOTHER process (e.g. the
   *  published app AND the workspace) is using the same Kraken API key. */
  concurrentUseSuspected: boolean;
  /** Nonce errors within the trailing detection window. */
  recentNonceErrors: number;
  totalNonceErrors: number;
  lastNonceErrorAtMs: number | null;
  /** Human guidance shown by the dashboard when suspected. */
  hint: string | null;
}

/** Aggregated nonce health across every key this process has used. Keys are
 *  never exposed — only aggregate counts (the dashboard has one key anyway). */
export function getKrakenNonceHealth(): KrakenNonceHealth {
  const now = Date.now();
  let recent = 0, total = 0, lastAt: number | null = null, suspected = false;
  for (const st of nonceStates.values()) {
    const inWindow = st.errorTimes.filter(t => now - t < NONCE_ERROR_WINDOW_MS).length;
    recent += inWindow;
    total += st.totalErrors;
    if (st.lastErrorAt != null && (lastAt == null || st.lastErrorAt > lastAt)) lastAt = st.lastErrorAt;
    if (inWindow >= NONCE_CONFLICT_THRESHOLD) suspected = true;
  }
  return {
    concurrentUseSuspected: suspected,
    recentNonceErrors: recent,
    totalNonceErrors: total,
    lastNonceErrorAtMs: lastAt,
    hint: suspected
      ? "Repeated Kraken nonce errors: another app instance (e.g. the published app AND this workspace) appears to be using the same Kraken API key. Run the bot from only ONE of them, or create a separate API key per environment (Kraken → Settings → API). Setting a nonce window (~5000 ms) on the key reduces — but does not eliminate — these errors."
      : null,
  };
}

/**
 * Pace + backoff-gate a private call. The per-key chain holds ONLY the paced
 * HTTP call (min gap + ≤10s HTTP timeout) — backoff sleeps happen OUTSIDE the
 * chain so a read's retry can never block a queued order/unwind behind a
 * multi-second sleep. Reads retry on rate-limit; order mutations never do.
 */
/** Ownership-scoped liveness hook. The heartbeat is carried through an
 *  AsyncLocalStorage scope bound by the executor that HOLDS the live
 *  execution lock (see arb.ts liveLockHeartbeat: it checks lock-generation
 *  ownership and no-ops once revoked). Private calls made INSIDE that scope
 *  beat the owner's heartbeat on every attempt, every ≤5s during rate-limit
 *  backoff sleeps, and every 5s while queued behind other paced calls on the
 *  same key. Private calls made OUTSIDE any scope (dashboard reads, other
 *  accounts) beat NOTHING — they can never keep a dead execution lock alive
 *  or shield it from FORCE stale-lock eviction. */
const lockHeartbeatScope = new AsyncLocalStorage<() => void>();
/** Bind `hb` as the lock heartbeat for the REMAINDER of the current async
 *  execution (and everything it awaits/spawns). Call right after acquiring
 *  the live execution lock; pass an ownership-checked heartbeat so the
 *  binding self-neutralizes when the lock is revoked or released. */
export function bindLockHeartbeat(hb: () => void): void {
  lockHeartbeatScope.enterWith(hb);
}
/** Run `fn` with `hb` as the lock heartbeat (scoped variant for callers that
 *  can wrap their execution body — also the test seam). */
export function runWithLockHeartbeat<T>(hb: () => void, fn: () => Promise<T>): Promise<T> {
  return lockHeartbeatScope.run(hb, fn);
}
const beat = () => { try { lockHeartbeatScope.getStore()?.(); } catch { /* never break a call */ } };

export async function withPrivateLimiter<T>(key: string, fn: () => Promise<T>, retryOnRateLimit: boolean): Promise<T> {
  const st = limiterFor(key);
  // Capture the caller's scoped heartbeat ONCE at entry: the queue-beat
  // interval and chained continuations then beat the exact owner that
  // initiated this call, regardless of timer/context propagation.
  const scoped = lockHeartbeatScope.getStore();
  const beat = () => { try { scoped?.(); } catch { /* never break a call */ } };
  for (let attempt = 0; ; attempt++) {
    // Wait out an open backoff window WITHOUT holding the chain, beating the
    // liveness hook every ≤5s so the lock heartbeat never goes silent.
    while (st.rateLimitedUntil - Date.now() > 0) {
      beat();
      await new Promise(r => setTimeout(r, Math.min(5_000, Math.max(1, st.rateLimitedUntil - Date.now()))));
    }
    beat();
    const p = st.chain.then(async () => {
      const gapWait = st.lastAt + PRIVATE_MIN_GAP_MS - Date.now();
      if (gapWait > 0) await new Promise(r => setTimeout(r, gapWait));
      st.lastAt = Date.now();
      // Beat when the call actually STARTS (it may have queued behind other
      // paced calls on this key) and again when it RESOLVES, so a single
      // awaited order/cancel/unwind never leaves the lock heartbeat silent
      // longer than one HTTP timeout (~10s).
      beat();
      try {
        return await fn();
      } finally {
        beat();
      }
    });
    st.chain = p.catch(() => undefined); // keep the chain alive on failures
    // Beat periodically while this call is QUEUED behind other paced calls on
    // this key (and while its HTTP request is in flight). A backed-up serial
    // queue can otherwise leave >15s of heartbeat silence, letting FORCE-mode
    // stale-lock eviction kill a healthy run that is merely waiting its turn.
    const queueBeat = setInterval(beat, 5_000);
    try {
      const out = await p;
      st.backoffMs = 2_000; // healthy call — reset backoff
      return out;
    } catch (e) {
      if (!isRateLimitError(e)) throw e;
      st.rateLimitedUntil = Date.now() + st.backoffMs;
      st.backoffMs = Math.min(RATE_BACKOFF_MAX_MS, st.backoffMs * 2);
      if (!retryOnRateLimit || attempt >= 2) throw e;
    } finally {
      clearInterval(queueBeat);
    }
  }
}

/** Latency probe: armed by the executor just before a fire; the FIRST
 *  AddOrder after arming stamps submit (request out) and ack (Kraken response
 *  in). Live executions are serialized by the execution lock, so one
 *  module-scoped probe is safe. */
export interface LatencyProbe { submitAtMs?: number; ackAtMs?: number; }
let activeLatencyProbe: LatencyProbe | null = null;
export function armLatencyProbe(): LatencyProbe {
  const p: LatencyProbe = {};
  activeLatencyProbe = p;
  return p;
}
export function disarmLatencyProbe(): void { activeLatencyProbe = null; }

export async function krakenPrivateRequest<T>(path: string, data: Record<string, string>, creds: KrakenCreds): Promise<T> {
  const probe = path.includes("AddOrder") && activeLatencyProbe && activeLatencyProbe.submitAtMs == null ? activeLatencyProbe : null;
  if (probe) {
    probe.submitAtMs = Date.now();
    try {
      const out = await krakenPrivateRequestInner<T>(path, data, creds);
      probe.ackAtMs = Date.now();
      return out;
    } catch (e) {
      probe.ackAtMs = Date.now(); // rejection is still an exchange acknowledgement
      throw e;
    }
  }
  return krakenPrivateRequestInner<T>(path, data, creds);
}

async function krakenPrivateRequestInner<T>(path: string, data: Record<string, string>, creds: KrakenCreds): Promise<T> {
  // Reads are safe to retry after a rate-limit backoff; order mutations are not.
  const isRead = !/AddOrder|CancelOrder/.test(path);
  const call = () => withPrivateLimiter(creds.krakenKey, () => krakenPrivateRequestRaw<T>(path, data, creds), isRead);
  try {
    return await call();
  } catch (e) {
    if (!isNonceError(e)) throw e;
    // Nonce failures are rejected BEFORE Kraken processes the request (no
    // order was placed), so one retry is safe for reads AND orders. Record
    // the error first — repeated ones flag concurrent use of this key.
    recordNonceError(creds.krakenKey);
    try {
      return await call();
    } catch (e2) {
      if (isNonceError(e2)) recordNonceError(creds.krakenKey);
      throw e2;
    }
  }
}

async function krakenPrivateRequestRaw<T>(path: string, data: Record<string, string>, creds: KrakenCreds): Promise<T> {
  const nonce = nextNonce(creds.krakenKey);
  const payload: Record<string, string> = { nonce, ...data };
  const postData = new URLSearchParams(payload).toString();
  const sign = krakenSign(path, nonce, postData, creds.krakenSecret);
  const resp = await fetch(`${KRAKEN_BASE}${path}`, {
    method: "POST",
    headers: {
      "API-Key": creds.krakenKey,
      "API-Sign": sign,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: postData,
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Kraken HTTP ${resp.status}`);
  const json = await resp.json() as { error?: string[]; result?: T };
  if (json.error?.length) throw new Error("Kraken: " + json.error.join("; "));
  return json.result as T;
}

export async function getKrakenPrice(pair: Pair = "SOL/USD"): Promise<number> {
  const krakenPair = KRAKEN_REST_PAIRS[pair];
  const result = await krakenPublicRequest<Record<string, { c: string[] }>>("/0/public/Ticker", { pair: krakenPair });
  const ticker = Object.values(result)[0];
  return parseFloat(ticker.c[0]);
}

/**
 * Fetches live bid AND ask directly from Kraken REST — bypasses the WS cache.
 * Use for preflight checks where cache freshness cannot be assumed.
 */
export async function getKrakenBidAsk(pair: Pair = "SOL/USD"): Promise<{ bid: number; ask: number; mid: number }> {
  const krakenPair = KRAKEN_REST_PAIRS[pair];
  const result = await krakenPublicRequest<Record<string, { b: string[]; a: string[]; c: string[] }>>(
    "/0/public/Ticker", { pair: krakenPair }
  );
  const ticker = Object.values(result)[0];
  if (!ticker) throw new Error(`Kraken: no ticker returned for ${krakenPair}`);
  const bid = parseFloat(ticker.b[0]);
  const ask = parseFloat(ticker.a[0]);
  if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new Error(`Kraken: invalid bid/ask for ${krakenPair} (bid=${bid} ask=${ask})`);
  }
  return { bid, ask, mid: (bid + ask) / 2 };
}
/**
 * Value the ENTIRE Kraken account in USD from actual balances — the ground
 * truth for realized P&L. USD/stables count at par; every other asset is
 * priced at the live Ticker mid. Assets we can't price are reported so the
 * caller can surface the gap instead of silently under-counting.
 */
export async function krakenAccountValueUsd(creds: KrakenCreds, fresh = false): Promise<{
  totalUsd: number;
  usdBalance: number;
  holdingsUsd: number;
  holdings: { currency: string; amount: number; usdValue: number | null }[];
  unpriced: string[];
}> {
  const balances = await getKrakenBalances(creds, fresh);
  // Kraken legacy asset codes → ticker asset (XXBT→XBT, XETH→ETH, ZUSD→USD…)
  const normalize = (c: string) => {
    const stripped = c.length >= 4 && (c.startsWith("X") || c.startsWith("Z")) ? c.slice(1) : c;
    return stripped.replace(/\.[SF]$/, ""); // staked variants like ETH2.S
  };
  let usdBalance = 0;
  const toPrice: { currency: string; asset: string; amount: number }[] = [];
  for (const b of balances) {
    const asset = normalize(b.currency);
    if (asset === "USD" || asset === "USDT" || asset === "USDC") usdBalance += b.amount;
    else toPrice.push({ currency: b.currency, asset, amount: b.amount });
  }
  const holdings: { currency: string; amount: number; usdValue: number | null }[] = [];
  const unpriced: string[] = [];
  let holdingsUsd = 0;
  if (toPrice.length > 0) {
    const pairList = toPrice.map(t => `${t.asset}USD`).join(",");
    let tickers: Record<string, { c: string[] }> = {};
    try {
      tickers = await krakenPublicRequest<Record<string, { c: string[] }>>("/0/public/Ticker", { pair: pairList });
    } catch { /* fall through — individual lookups below */ }
    const keys = Object.keys(tickers);
    for (const t of toPrice) {
      // Kraken echoes canonical pair names (XXBTZUSD for XBTUSD). Only accept
      // EXACT canonical forms — substring guessing can silently mis-price.
      const acceptable = new Set([`${t.asset}USD`, `${t.asset}ZUSD`, `X${t.asset}ZUSD`, `X${t.asset}USD`, `Z${t.asset}ZUSD`]);
      const key = keys.find(k => acceptable.has(k));
      let price: number | null = key ? parseFloat(tickers[key]!.c[0]!) : null;
      if (price == null) {
        try {
          const single = await krakenPublicRequest<Record<string, { c: string[] }>>("/0/public/Ticker", { pair: `${t.asset}USD` });
          const first = Object.values(single)[0];
          price = first ? parseFloat(first.c[0]!) : null;
        } catch { price = null; }
      }
      if (price != null && isFinite(price)) {
        const usdValue = t.amount * price;
        holdingsUsd += usdValue;
        holdings.push({ currency: t.currency, amount: t.amount, usdValue });
      } else {
        unpriced.push(t.currency);
        holdings.push({ currency: t.currency, amount: t.amount, usdValue: null });
      }
    }
  }
  return { totalUsd: usdBalance + holdingsUsd, usdBalance, holdingsUsd, holdings, unpriced };
}

// ── Historical daily-close pricing for ledger cash flows ─────────────────────
// Kraken's public OHLC endpoint (interval=1440) returns up to ~720 daily
// candles per pair — enough to price ledger entries at their DEPOSIT-DAY
// close instead of today's price. Cached per asset (candles are immutable
// once the day closes; a short TTL keeps the current day's partial candle
// from going stale).
const DAY_SECS = 86_400;
const ohlcDailyCache = new Map<string, { at: number; sinceUnix: number; closes: Map<number, number> }>(); // asset → dayStartUnix → close
const OHLC_CACHE_MS = 15 * 60_000;

/** Daily close map for `asset`USD, keyed by UTC day-start unix. Empty map on
 *  failure — callers fall back to current-price approximation per entry.
 *  Exported for tests only. */
export async function krakenDailyCloses(asset: string, sinceUnix: number): Promise<Map<number, number>> {
  const hit = ohlcDailyCache.get(asset);
  // Reuse only when the cached fetch covered at least as far back as requested
  // AND was taken during the current UTC day — a map cached before midnight
  // holds the then-in-progress candle for the day that has since finalized,
  // and its close would be stale (last pre-midnight price, not the real close).
  const sameUtcDay = hit && Math.floor(hit.at / 1000 / DAY_SECS) === Math.floor(Date.now() / 1000 / DAY_SECS);
  if (hit && sameUtcDay && Date.now() - hit.at < OHLC_CACHE_MS && hit.sinceUnix <= sinceUnix) return hit.closes;
  try {
    // `since` is exclusive of the candle containing it — back off one day so
    // the entry's own day is always covered.
    const result = await krakenPublicRequest<Record<string, unknown>>("/0/public/OHLC", {
      pair: `${asset}USD`, interval: "1440", since: String(Math.max(0, sinceUnix - DAY_SECS)),
    });
    const candles = Object.entries(result).find(([k]) => k !== "last")?.[1];
    const closes = new Map<number, number>();
    if (Array.isArray(candles)) {
      for (const c of candles) {
        // Candle tuple: [time, open, high, low, close, vwap, volume, count]
        const t = Number((c as unknown[])[0]);
        const close = parseFloat(String((c as unknown[])[4]));
        if (isFinite(t) && isFinite(close) && close > 0) closes.set(t, close);
      }
    }
    ohlcDailyCache.set(asset, { at: Date.now(), sinceUnix, closes });
    return closes;
  } catch {
    return new Map(); // no cache write — retry next call
  }
}

/**
 * Net external cash flow (USD) into the Kraken account since `sinceUnix`:
 * deposits + incoming transfers − withdrawals − outgoing transfers, from the
 * private Ledgers API. Non-USD flows are valued at the daily OHLC close of
 * each entry's own day (historical pricing); entries whose historical price
 * is unavailable fall back to CURRENT ticker prices and set `approximated`.
 * Trades/fees excluded.
 */
export async function krakenNetCashFlowUsd(creds: KrakenCreds, sinceUnix: number): Promise<{ netUsd: number; entries: number; approximated: boolean; complete: boolean }> {
  type LedgerEntry = { refid: string; time: number; type: string; asset: string; amount: string; fee: string };
  let ofs = 0, entries = 0, approximated = false, complete = false;
  const flowEntries: { asset: string; amount: number; time: number }[] = [];
  const MAX_PAGES = 40; // 40 × 50 = 2,000 ledger entries since baseline
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await krakenPrivateRequest<{ ledger: Record<string, LedgerEntry>; count: number }>(
      "/0/private/Ledgers", { start: String(sinceUnix), ofs: String(ofs) }, creds);
    const rows = Object.values(result.ledger ?? {});
    if (rows.length === 0) { complete = true; break; }
    for (const e of rows) {
      if (e.type !== "deposit" && e.type !== "withdrawal" && e.type !== "transfer") continue;
      entries++;
      flowEntries.push({ asset: e.asset, amount: parseFloat(e.amount), time: e.time });
    }
    ofs += rows.length;
    if (ofs >= (result.count ?? 0)) { complete = true; break; }
  }
  let netUsd = 0;
  const normalize = (c: string) => {
    const stripped = c.length >= 4 && (c.startsWith("X") || c.startsWith("Z")) ? c.slice(1) : c;
    return stripped.replace(/\.(HOLD|[SF])$/, "");
  };
  // Current-price fallback cache (one ticker fetch per asset at most).
  const currentPrice = new Map<string, number | null>();
  const getCurrentPrice = async (asset: string): Promise<number | null> => {
    if (currentPrice.has(asset)) return currentPrice.get(asset)!;
    let price: number | null = null;
    try {
      const t = await krakenPublicRequest<Record<string, { c: string[] }>>("/0/public/Ticker", { pair: `${asset}USD` });
      const first = Object.values(t)[0];
      const p = first ? parseFloat(first.c[0]!) : NaN;
      if (isFinite(p)) price = p;
    } catch { /* stays null */ }
    currentPrice.set(asset, price);
    return price;
  };
  // Earliest entry time per asset — one OHLC fetch per asset covers all its entries.
  const earliest = new Map<string, number>();
  for (const f of flowEntries) {
    const asset = normalize(f.asset);
    if (asset === "USD" || asset === "USDT" || asset === "USDC") continue;
    if (Math.abs(f.amount) < 1e-12) continue;
    const cur = earliest.get(asset);
    if (cur == null || f.time < cur) earliest.set(asset, f.time);
  }
  const closesByAsset = new Map<string, Map<number, number>>();
  for (const [asset, t] of earliest) {
    closesByAsset.set(asset, await krakenDailyCloses(asset, Math.floor(t)));
  }
  for (const f of flowEntries) {
    if (Math.abs(f.amount) < 1e-12) continue;
    const asset = normalize(f.asset);
    if (asset === "USD" || asset === "USDT" || asset === "USDC") { netUsd += f.amount; continue; }
    const dayStart = Math.floor(f.time / DAY_SECS) * DAY_SECS;
    // Only FINALIZED daily candles count as historical closes. Kraken's OHLC
    // response includes the current, still-forming candle whose close is just
    // a live price — today's entries use the flagged current-price fallback.
    const todayStart = Math.floor(Date.now() / 1000 / DAY_SECS) * DAY_SECS;
    const histPrice = dayStart < todayStart ? closesByAsset.get(asset)?.get(dayStart) : undefined;
    if (histPrice != null) { netUsd += f.amount * histPrice; continue; }
    // Historical price unavailable → current-price approximation (flagged).
    approximated = true;
    const p = await getCurrentPrice(asset);
    if (p != null) netUsd += f.amount * p;
  }
  return { netUsd, entries, approximated, complete };
}

/**
 * Value the Coinbase account in USD from actual balances — sibling of
 * krakenAccountValueUsd. USD/stables at par; other assets priced at the
 * public product ticker. Unpriceable assets reported, never guessed.
 */
export async function coinbaseAccountValueUsd(creds: CoinbaseCreds): Promise<{
  totalUsd: number; usdBalance: number; holdingsUsd: number; unpriced: string[];
}> {
  const balances = await getCoinbaseBalances(creds);
  let usdBalance = 0, holdingsUsd = 0;
  const unpriced: string[] = [];
  for (const b of balances) {
    if (b.currency === "USD" || b.currency === "USDT" || b.currency === "USDC") { usdBalance += b.amount; continue; }
    try {
      const resp = await fetch(`https://api.exchange.coinbase.com/products/${b.currency}-USD/ticker`, { signal: AbortSignal.timeout(8_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json() as { price?: string };
      const price = parseFloat(json.price ?? "");
      if (!isFinite(price)) throw new Error("no price");
      holdingsUsd += b.amount * price;
    } catch { unpriced.push(b.currency); }
  }
  return { totalUsd: usdBalance + holdingsUsd, usdBalance, holdingsUsd, unpriced };
}

// Balance cache (30s): dashboard polls hit this every few seconds — each was a
// private call counting against Kraken's rate limit. Post-trade snapshots pass
// fresh=true to bypass (balances just changed).
const balanceCache = new Map<string, { at: number; val: BalanceEntry[] }>();
const BALANCE_CACHE_MS = 30_000;

export async function getKrakenBalances(creds: KrakenCreds, fresh = false): Promise<BalanceEntry[]> {
  const cacheKey = creds.krakenKey;
  const hit = balanceCache.get(cacheKey);
  if (!fresh && hit && Date.now() - hit.at < BALANCE_CACHE_MS) return hit.val;
  const result = await krakenPrivateRequest<Record<string, string>>("/0/private/Balance", {}, creds);
  const val = Object.entries(result)
    .filter(([, v]) => parseFloat(v) > 0)
    .map(([currency, amount]) => ({ currency, amount: parseFloat(amount) }));
  balanceCache.set(cacheKey, { at: Date.now(), val });
  return val;
}

// ── Kraken pair precision metadata ───────────────────────────────────────────
// Kraken rejects orders whose price/volume exceed the pair's allowed decimals
// ("EOrder:Invalid price: ETH/USD price can only be specified up to 2
// decimals"). Every AddOrder path below normalizes through this metadata —
// covering normal orders, maker reprices, retries, fallbacks, and unwinds.

export class KrakenPrecisionError extends Error {}

interface KrakenPairMeta { priceDecimals: number; lotDecimals: number; ordermin: number; costmin: number }
let pairMetaCache: { at: number; byPair: Map<string, KrakenPairMeta> } | null = null;
let pairMetaFetch: Promise<void> | null = null;
const PAIR_META_TTL_MS = 60 * 60 * 1_000;

async function refreshPairMeta(): Promise<void> {
  const r = await fetch("https://api.kraken.com/0/public/AssetPairs", { signal: AbortSignal.timeout(10_000) });
  const j = await r.json() as { error?: string[]; result?: Record<string, { wsname?: string; altname?: string; pair_decimals?: number; lot_decimals?: number; ordermin?: string; costmin?: string }> };
  if (j.error?.length || !j.result) throw new Error(`AssetPairs: ${j.error?.join(", ") || "empty result"}`);
  const byPair = new Map<string, KrakenPairMeta>();
  for (const [key, v] of Object.entries(j.result)) {
    const meta = { priceDecimals: v.pair_decimals ?? 8, lotDecimals: v.lot_decimals ?? 8, ordermin: parseFloat(v.ordermin ?? "0") || 0, costmin: parseFloat(v.costmin ?? "0") || 0 };
    // Index under every symbol form Kraken accepts (REST key, altname, wsname).
    byPair.set(key, meta);
    if (v.altname) byPair.set(v.altname, meta);
    if (v.wsname) byPair.set(v.wsname, meta);
  }
  pairMetaCache = { at: Date.now(), byPair };
}

/** Pair precision metadata, cached 1h. Throws if Kraken is unreachable AND no cached copy exists.
 * Pass `maxAgeMs` to demand fresher metadata (throws instead of silently
 * serving a cache older than that bound — for safety-critical preflights). */
export async function krakenPairMeta(rawPair: string, maxAgeMs: number = PAIR_META_TTL_MS): Promise<KrakenPairMeta> {
  if (!pairMetaCache || Date.now() - pairMetaCache.at > Math.min(maxAgeMs, PAIR_META_TTL_MS)) {
    try {
      pairMetaFetch ??= refreshPairMeta().finally(() => { pairMetaFetch = null; });
      await pairMetaFetch;
    } catch (e) {
      if (!pairMetaCache) throw new KrakenPrecisionError(`Kraken pair precision metadata unavailable (${(e as Error).message}) — refusing to submit an unvalidated order for ${rawPair}.`);
      // Stale cache is far safer than guessing decimals — keep it (unless the caller demanded freshness).
      if (Date.now() - pairMetaCache.at > maxAgeMs) throw new KrakenPrecisionError(`Kraken pair metadata is ${Math.round((Date.now() - pairMetaCache.at) / 1000)}s old (> ${Math.round(maxAgeMs / 1000)}s demanded) and refresh failed (${(e as Error).message}) — refusing to validate minimums against stale data.`);
    }
  }
  const meta = pairMetaCache!.byPair.get(rawPair);
  if (!meta) throw new KrakenPrecisionError(`No Kraken precision metadata for pair "${rawPair}" — refusing to submit an unvalidated order.`);
  return meta;
}

/** Decimal-safe quantization: truncates toward zero to `decimals` places (string math — no float artifacts). */
function quantizeDecimals(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new KrakenPrecisionError(`Cannot quantize non-positive value ${value}`);
  const s = value.toFixed(Math.min(12, decimals + 4)); // extra guard digits, then truncate
  const dot = s.indexOf(".");
  const out = decimals <= 0 ? s.slice(0, dot) : s.slice(0, dot + 1 + decimals);
  if (parseFloat(out) <= 0) throw new KrakenPrecisionError(`Value ${value} rounds to zero at ${decimals} decimals`);
  return out;
}

/** Normalize a limit price to the pair's allowed decimals. Buys round DOWN, sells round UP would cross-risk — we truncate for both (conservative for buys; a sell truncated is ≤1 tick more aggressive, never rejected). */
export async function normalizeKrakenPrice(rawPair: string, price: number): Promise<string> {
  const meta = await krakenPairMeta(rawPair);
  const out = quantizeDecimals(price, meta.priceDecimals);
  if (parseFloat(out) !== price) console.log(`[KRAKEN·PRECISION] ${rawPair} raw price ${price} -> ${out} (${meta.priceDecimals} decimals)`);
  return out;
}

/** Normalize order volume to lot decimals (truncate down) and enforce the pair minimum. */
export async function normalizeKrakenVolume(rawPair: string, volume: number): Promise<string> {
  const meta = await krakenPairMeta(rawPair);
  const out = quantizeDecimals(volume, meta.lotDecimals);
  if (meta.ordermin > 0 && parseFloat(out) < meta.ordermin) {
    throw new KrakenPrecisionError(`Volume ${out} below Kraken minimum ${meta.ordermin} for ${rawPair}`);
  }
  if (parseFloat(out) !== volume) console.log(`[KRAKEN·PRECISION] ${rawPair} raw volume ${volume} -> ${out} (${meta.lotDecimals} lot decimals)`);
  return out;
}

/** Startup validation: confirm precision metadata resolves for every tradable pair. Returns missing pairs. */
export async function validateKrakenPrecision(pairs: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const p of pairs) {
    try { await krakenPairMeta(p); } catch { missing.push(p); }
  }
  return missing;
}

/** KILL SWITCH support: cancel ALL open Kraken orders on the account. */
export async function krakenCancelAllOrders(creds: KrakenCreds): Promise<number> {
  const result = await krakenPrivateRequest<{ count: number }>("/0/private/CancelAll", {}, creds);
  return result.count ?? 0;
}

export async function krakenMarketOrder(
  creds: KrakenCreds,
  side: "buy" | "sell",
  volume: number,
  pair: Pair = "SOL/USD",
): Promise<{ txid: string[] }> {
  const rawPair = KRAKEN_REST_PAIRS[pair];
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: rawPair,
    type: side,
    ordertype: "market",
    volume: await normalizeKrakenVolume(rawPair, volume),
  }, creds);
}

export async function krakenLimitOrder(
  creds: KrakenCreds,
  side: "buy" | "sell",
  volume: number,
  price: number,
  pair: Pair = "SOL/USD",
): Promise<{ txid: string[] }> {
  const rawPair = KRAKEN_REST_PAIRS[pair];
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: rawPair,
    type: side,
    ordertype: "limit",
    post_only: "true",
    volume: await normalizeKrakenVolume(rawPair, volume),
    price: await normalizeKrakenPrice(rawPair, price),
  }, creds);
}

/**
 * Places a post-only limit order using an arbitrary raw Kraken pair symbol.
 * Used for auto-loop triangular legs (maker rate = ~0.16% vs 0.26% taker).
 * Port of Python v13 kraken_limit_order() with post_only=true.
 */
export async function krakenRawLimitOrder(
  creds: KrakenCreds,
  side: "buy" | "sell",
  volume: number,
  price: number,
  rawPair: string,
): Promise<{ txid: string[] }> {
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: rawPair,
    type: side,
    ordertype: "limit",
    price: await normalizeKrakenPrice(rawPair, price),
    volume: await normalizeKrakenVolume(rawPair, volume),
    // post-only: rejected if it would cross spread (maker only).
    // fciq: fee always charged in the QUOTE currency, so cost/fee accounting
    // (aConsumed = cost + fee, received = cost − fee) is guaranteed correct
    // regardless of the account's fee-currency preference.
    oflags: "post,fciq",
  }, creds);
}

/** Bounded IOC limit order on Kraken (taker-like but price-capped): fills
 *  immediately up to the limit price, cancels any remainder. NOT post-only.
 *  fciq keeps cost/fee accounting in the quote currency. */
export async function krakenIocLimitOrder(
  creds: KrakenCreds,
  side: "buy" | "sell",
  volume: number,
  price: number,
  rawPair: string,
): Promise<{ txid: string[] }> {
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: rawPair,
    type: side,
    ordertype: "limit",
    price: await normalizeKrakenPrice(rawPair, price),
    volume: await normalizeKrakenVolume(rawPair, volume),
    timeinforce: "IOC",
    oflags: "fciq",
  }, creds);
}

/**
 * Places a market order using an arbitrary raw Kraken pair symbol.
 * Used for triangular arb legs that have no canonical Pair mapping
 * (e.g. "SOLXBT", "XXBTZUSD").
 */
export async function krakenRawMarketOrder(
  creds: KrakenCreds,
  side: "buy" | "sell",
  volume: number,
  rawPair: string,
): Promise<{ txid: string[] }> {
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: rawPair,
    type: side,
    ordertype: "market",
    volume: await normalizeKrakenVolume(rawPair, volume),
    oflags: "fciq", // fee in QUOTE currency — keeps cost/fee accounting exact
  }, creds);
}

/**
 * Immediate-or-cancel LIMIT order with an explicit worst-case price — a
 * bounded alternative to a market order. Crosses the spread like a taker but
 * can NEVER spend more than volume × price (+ fee in quote via fciq); any
 * unfilled remainder cancels immediately instead of resting.
 */
export async function krakenRawIocLimitOrder(
  creds: KrakenCreds,
  side: "buy" | "sell",
  volume: number,
  price: number,
  rawPair: string,
): Promise<{ txid: string[] }> {
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: rawPair,
    type: side,
    ordertype: "limit",
    price: await normalizeKrakenPrice(rawPair, price),
    volume: await normalizeKrakenVolume(rawPair, volume),
    timeinforce: "IOC",
    oflags: "fciq",
  }, creds);
}

interface KrakenOrderInfo { status?: string; price?: string; vol_exec?: string; }

/** Returns true if the order is fully filled, false if open/partial/unknown. */
export async function krakenOrderFilled(creds: KrakenCreds, txid: string): Promise<boolean> {
  const result = await krakenPrivateRequest<Record<string, KrakenOrderInfo>>("/0/private/QueryOrders", { txid, trades: "false" }, creds);
  return result[txid]?.status === "closed";
}

/** Returns the average fill price for a closed Kraken order (0 if unavailable). */
export async function krakenFillPrice(creds: KrakenCreds, txid: string): Promise<number> {
  const result = await krakenPrivateRequest<Record<string, KrakenOrderInfo>>("/0/private/QueryOrders", { txid, trades: "false" }, creds);
  return parseFloat(result[txid]?.price ?? "0") || 0;
}

interface KrakenOrderInfoFull { status?: string; price?: string; vol_exec?: string; cost?: string; fee?: string; }

/**
 * Full order fill info: status, executed volume (base units), avg price, cost
 * (quote units, ex-fees), and fee (quote units). Used to size subsequent legs
 * from ACTUAL fills and to compute fee-inclusive realized P&L.
 */
export async function krakenOrderInfo(
  creds: KrakenCreds,
  txid: string,
): Promise<{ status: string; volExec: number; price: number; cost: number; fee: number }> {
  const result = await krakenPrivateRequest<Record<string, KrakenOrderInfoFull>>("/0/private/QueryOrders", { txid, trades: "false" }, creds);
  const o = result[txid];
  return {
    status:  o?.status ?? "unknown",
    volExec: parseFloat(o?.vol_exec ?? "0") || 0,
    price:   parseFloat(o?.price ?? "0") || 0,
    cost:    parseFloat(o?.cost ?? "0") || 0,
    fee:     parseFloat(o?.fee ?? "0") || 0,
  };
}

/**
 * Actual taker fee (percent) for the given raw pairs from the account's real
 * fee tier (/0/private/TradeVolume). Returns the MAX across pairs, or null if
 * the query fails or returns nothing.
 */
export async function krakenTakerFeePct(creds: KrakenCreds, rawPairs: string[]): Promise<number | null> {
  return (await krakenFeeTiers(creds, rawPairs))?.takerFeePct ?? null;
}

/**
 * Actual taker AND maker fees (percent) from the account's real fee tier
 * (/0/private/TradeVolume; `fees` = taker schedule, `fees_maker` = maker).
 * MAX across pairs; null if the query fails or returns nothing.
 */
// Fee-tier cache (10 min): the tier moves with 30-day volume — it does not
// change second to second, and TradeVolume calls were a large share of the
// private-API budget (scan gate + route gate + dashboard poll).
const feeTierCache = new Map<string, { at: number; val: { takerFeePct: number; makerFeePct: number | null } | null }>();
const FEE_TIER_CACHE_MS = 10 * 60_000;

export async function krakenFeeTiers(creds: KrakenCreds, rawPairs: string[]): Promise<{ takerFeePct: number; makerFeePct: number | null } | null> {
  const cacheKey = `${creds.krakenKey}|${[...rawPairs].sort().join(",")}`;
  const hit = feeTierCache.get(cacheKey);
  if (hit && Date.now() - hit.at < FEE_TIER_CACHE_MS && hit.val != null) return hit.val;
  try {
    const result = await krakenPrivateRequest<{
      fees?: Record<string, { fee?: string }>;
      fees_maker?: Record<string, { fee?: string }>;
    }>("/0/private/TradeVolume", { pair: rawPairs.join(","), "fee-info": "true" }, creds);
    const pick = (rec?: Record<string, { fee?: string }>) => {
      const v = Object.values(rec ?? {}).map(f => parseFloat(f.fee ?? "")).filter(f => Number.isFinite(f) && f > 0);
      return v.length > 0 ? Math.max(...v) : null;
    };
    const taker = pick(result.fees);
    const maker = pick(result.fees_maker);
    return taker != null ? { takerFeePct: taker, makerFeePct: maker } : null;
  } catch {
    return null;
  }
}

export async function krakenCancelOrder(creds: KrakenCreds, txid: string): Promise<void> {
  await krakenPrivateRequest<unknown>("/0/private/CancelOrder", { txid }, creds);
}

// ---------------------------------------------------------------------------
// Coinbase Advanced Trade API helpers (JWT auth, ES256)
// ---------------------------------------------------------------------------

const COINBASE_BASE = "https://api.coinbase.com";

function buildCoinbaseJwt(apiKeyName: string, privateKeyPem: string, method: string, path: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: apiKeyName })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    sub: apiKeyName,
    uri: `${method.toUpperCase()} api.coinbase.com${path}`,
  })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const normalizedPem = privateKeyPem.replace(/\\n/g, "\n").trim();
  const sign = crypto.createSign("SHA256");
  sign.update(sigInput);
  const der = sign.sign({ key: normalizedPem, dsaEncoding: "ieee-p1363" });
  const sig = der.toString("base64url");
  return `${sigInput}.${sig}`;
}

async function coinbaseRequest<T>(
  creds: CoinbaseCreds,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  // Coinbase JWTs sign the path WITHOUT the query string — including it
  // makes every paginated/filtered request fail auth.
  const jwt = buildCoinbaseJwt(creds.coinbaseKey, creds.coinbaseSecret, method, path.split("?")[0]);
  // Beat the execution-lock heartbeat around every private Coinbase call:
  // inventory/graph executors await these (place/cancel/status) while holding
  // the shared live lock, and only their poll loops touch it otherwise.
  beat();
  try {
    const resp = await fetch(`${COINBASE_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Coinbase HTTP ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<T>;
  } finally {
    beat();
  }
}

/** Public endpoint — no API key required. */
export async function getCoinbasePrice(pair: Pair = "SOL/USD"): Promise<number> {
  const product = COINBASE_PRODUCTS[pair];
  const resp = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Coinbase public price HTTP ${resp.status}`);
  const json = await resp.json() as { price?: string };
  const price = json.price;
  if (!price) throw new Error("Coinbase: missing price in public response");
  return parseFloat(price);
}

/** Public endpoint — returns best bid AND ask for building graph edges. */
export async function getCoinbaseBidAsk(pair: Pair = "SOL/USD"): Promise<{ bid: number; ask: number; mid: number }> {
  const product = COINBASE_PRODUCTS[pair];
  // Stream-first: live Coinbase ticker WS quote fresher than 2s — no REST.
  const st = getStreamTicker(product);
  if (st && st.ageMs <= 2_000) return { bid: st.bid, ask: st.ask, mid: (st.bid + st.ask) / 2 };
  const resp = await fetch(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Coinbase ticker HTTP ${resp.status}`);
  const json = await resp.json() as { bid?: string; ask?: string; price?: string };
  const bid = parseFloat(json.bid ?? json.price ?? "0");
  const ask = parseFloat(json.ask ?? json.price ?? "0");
  if (!bid || !ask) throw new Error(`Coinbase: missing bid/ask for ${product}`);
  return { bid, ask, mid: (bid + ask) / 2 };
}

/**
 * Public endpoint — full level-2 order book (aggregated price levels) for
 * depth-walked VWAP pricing of Coinbase graph edges. Levels are returned
 * best-first as [price, size] number tuples.
 */
export async function getCoinbaseOrderBook(pair: Pair = "SOL/USD"): Promise<{
  bids: [number, number][];
  asks: [number, number][];
}> {
  const product = COINBASE_PRODUCTS[pair];
  const resp = await fetch(`https://api.exchange.coinbase.com/products/${product}/book?level=2`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Coinbase book HTTP ${resp.status}`);
  const json = await resp.json() as { bids?: [string, string, unknown][]; asks?: [string, string, unknown][] };
  const toLevels = (rows: [string, string, unknown][] | undefined): [number, number][] =>
    (rows ?? [])
      .map(([p, s]) => [parseFloat(p), parseFloat(s)] as [number, number])
      .filter(([p, s]) => isFinite(p) && isFinite(s) && p > 0 && s > 0);
  const bids = toLevels(json.bids);
  const asks = toLevels(json.asks);
  if (bids.length === 0 || asks.length === 0) throw new Error(`Coinbase: empty book for ${product}`);
  return { bids, asks };
}

export async function getCoinbaseBalances(creds: CoinbaseCreds): Promise<BalanceEntry[]> {
  // The accounts endpoint is PAGINATED (default ~49 per page). Accounts with
  // funds can land on later pages behind dozens of zero-balance currencies —
  // reading only page 1 silently reports real holdings as 0. Walk every page.
  const out: BalanceEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = `limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await coinbaseRequest<{
      accounts: Array<{ currency: string; available_balance: { value: string } }>;
      has_next?: boolean; cursor?: string;
    }>(creds, "GET", `/api/v3/brokerage/accounts?${qs}`);
    for (const a of data.accounts || []) {
      const amount = parseFloat(a.available_balance.value);
      if (amount > 0) out.push({ currency: a.currency, amount });
    }
    if (!data.has_next || !data.cursor) break;
    cursor = data.cursor;
  }
  return out;
}

/**
 * Detailed per-asset Coinbase balance breakdown from the SAME credentials and
 * accounts the order path uses. Distinguishes:
 *  - available: tradable right now (what a sell order can actually use)
 *  - hold:      locked by open orders / pending activity
 *  - staked:    held in staking wrappers (e.g. ETH2 or accounts marked staked)
 * Staked funds are NOT tradable until unstaked.
 */
export type CoinbaseAssetAccount = {
  currency: string; name: string | null; type: string | null;
  available: number; hold: number; staked: boolean;
};
/** Real Coinbase taker/maker fee tier for THIS account, from the
 *  transaction_summary endpoint. Throws on failure — callers must refuse to
 *  guess fees for live gating. Returned as percent (0.4 = 0.40%). */
export async function getCoinbaseFeeTier(creds: CoinbaseCreds): Promise<{ takerFeePct: number; makerFeePct: number }> {
  const d = await coinbaseRequest<{ fee_tier?: { taker_fee_rate?: string; maker_fee_rate?: string } }>(
    creds, "GET", "/api/v3/brokerage/transaction_summary",
  );
  const taker = parseFloat(d.fee_tier?.taker_fee_rate ?? "");
  const maker = parseFloat(d.fee_tier?.maker_fee_rate ?? "");
  if (!Number.isFinite(taker) || taker <= 0) throw new Error("Coinbase fee tier unavailable");
  return { takerFeePct: taker * 100, makerFeePct: Number.isFinite(maker) ? maker * 100 : taker * 100 };
}

export async function getCoinbaseAssetDetail(
  creds: CoinbaseCreds,
  currency: string,
): Promise<{ available: number; hold: number; staked: number; total: number; accounts: CoinbaseAssetAccount[]; accountsScanned: number }> {
  const want = currency.toUpperCase();
  let available = 0, hold = 0, staked = 0, accountsScanned = 0;
  const accounts: CoinbaseAssetAccount[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = `limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await coinbaseRequest<{
      accounts: Array<{
        currency: string; name?: string; type?: string;
        available_balance: { value: string }; hold?: { value: string };
      }>;
      has_next?: boolean; cursor?: string;
    }>(creds, "GET", `/api/v3/brokerage/accounts?${qs}`);
    for (const a of data.accounts || []) {
      accountsScanned++;
      const cur = (a.currency || "").toUpperCase();
      const avail = parseFloat(a.available_balance?.value ?? "0") || 0;
      const held = parseFloat(a.hold?.value ?? "0") || 0;
      const isStakedWrapper = cur === `${want}2` || /stak/i.test(a.name ?? "") || /stak/i.test(a.type ?? "");
      const related = cur === want || cur === `${want}2`;
      if (!related) continue;
      accounts.push({ currency: cur, name: a.name ?? null, type: a.type ?? null, available: avail, hold: held, staked: isStakedWrapper });
      if (isStakedWrapper) staked += avail + held;
      else { available += avail; hold += held; }
    }
    if (!data.has_next || !data.cursor) break;
    cursor = data.cursor;
  }
  return { available, hold, staked, total: available + hold + staked, accounts, accountsScanned };
}

export async function coinbaseMarketOrder(
  creds: CoinbaseCreds,
  side: "BUY" | "SELL",
  volume: number,
  price: number,
  pair: Pair = "SOL/USD",
): Promise<{ orderId?: string; success?: boolean }> {
  const clientOrderId = crypto.randomUUID();
  const productId = COINBASE_PRODUCTS[pair];
  let orderConfig: unknown;
  if (side === "BUY") {
    const quoteSize = (volume * price).toFixed(2);
    orderConfig = { market_market_ioc: { quote_size: quoteSize } };
  } else {
    orderConfig = { market_market_ioc: { base_size: volume.toFixed(8) } };
  }
  const data = await coinbaseRequest<{ order_id?: string; success?: boolean; success_response?: { order_id: string } }>(
    creds,
    "POST",
    "/api/v3/brokerage/orders",
    {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: orderConfig,
    }
  );
  return { orderId: data.success_response?.order_id ?? data.order_id, success: data.success };
}

interface CoinbaseOrderInfo { status?: string; average_filled_price?: string; filled_size?: string; filled_value?: string; total_fees?: string; }

/**
 * Full order details incl. cumulative fills. filledSize is BASE units,
 * filledValue is QUOTE (USD), totalFees is QUOTE (USD).
 * Terminal statuses: FILLED, CANCELLED, EXPIRED, FAILED.
 */
export async function coinbaseOrderDetails(creds: CoinbaseCreds, orderId: string): Promise<{
  status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number;
}> {
  const data = await coinbaseRequest<{ order?: CoinbaseOrderInfo }>(
    creds, "GET", `/api/v3/brokerage/orders/historical/${orderId}`
  );
  return {
    status: data.order?.status ?? "UNKNOWN",
    filledSize:  parseFloat(data.order?.filled_size  ?? "0") || 0,
    filledValue: parseFloat(data.order?.filled_value ?? "0") || 0,
    avgPrice:    parseFloat(data.order?.average_filled_price ?? "0") || 0,
    totalFees:   parseFloat(data.order?.total_fees   ?? "0") || 0,
  };
}

/** Returns true if the order is fully filled. */
export async function coinbaseOrderFilled(creds: CoinbaseCreds, orderId: string): Promise<boolean> {
  const data = await coinbaseRequest<{ order?: CoinbaseOrderInfo }>(
    creds, "GET", `/api/v3/brokerage/orders/historical/${orderId}`
  );
  return data.order?.status === "FILLED";
}

/** Returns the average fill price for a filled Coinbase order (0 if unavailable). */
export async function coinbaseFillPrice(creds: CoinbaseCreds, orderId: string): Promise<number> {
  const data = await coinbaseRequest<{ order?: CoinbaseOrderInfo }>(
    creds, "GET", `/api/v3/brokerage/orders/historical/${orderId}`
  );
  return parseFloat(data.order?.average_filled_price ?? "0") || 0;
}

export async function coinbaseCancelOrder(creds: CoinbaseCreds, orderId: string): Promise<void> {
  await coinbaseRequest<unknown>(creds, "POST", "/api/v3/brokerage/orders/batch_cancel", { order_ids: [orderId] });
}

// ---------------------------------------------------------------------------
// Coinbase product increments + safe quantization
// ---------------------------------------------------------------------------

export interface CoinbaseIncrements { baseIncrement: string; quoteIncrement: string; baseMinSize: number; quoteMinNotional: number; }

/**
 * Quantize a value DOWN to a multiple of the exchange increment (tick/lot),
 * returning both the numeric value and the exact decimal string to submit.
 * Rounding is always toward zero — never up — so a quantized price can never
 * cross the book and a quantized size can never exceed available funds.
 */
export function quantizeDown(value: number, increment: string): { value: number; text: string } {
  const inc = parseFloat(increment);
  if (!Number.isFinite(inc) || inc <= 0) throw new Error(`Invalid exchange increment: ${increment}`);
  // Decimal places from the increment string (trailing zeros stripped:
  // "0.01000000" → 2 decimals, "1.00" → 0).
  const norm = increment.includes(".") ? increment.replace(/0+$/, "").replace(/\.$/, "") : increment;
  const decimals = (norm.split(".")[1] ?? "").length;
  const steps = Math.floor(value / inc + 1e-9);
  const text = (steps * inc).toFixed(decimals);
  return { value: parseFloat(text), text };
}

// Product increments move essentially never — cache aggressively (1 h).
const cbIncrementCache = new Map<string, { at: number; val: CoinbaseIncrements }>();
const CB_INCREMENT_CACHE_MS = 60 * 60_000;

/**
 * Live price (quote) and size (base) increments for a Coinbase product from
 * the public product endpoint. Throws when unavailable — live maker orders
 * must never be submitted with guessed precision.
 */
export async function getCoinbaseProductIncrements(pair: Pair, maxAgeMs: number = CB_INCREMENT_CACHE_MS): Promise<CoinbaseIncrements> {
  const product = COINBASE_PRODUCTS[pair];
  const hit = cbIncrementCache.get(product);
  if (hit && Date.now() - hit.at < Math.min(maxAgeMs, CB_INCREMENT_CACHE_MS)) return hit.val;
  const resp = await fetch(`https://api.exchange.coinbase.com/products/${product}`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Coinbase product info HTTP ${resp.status} for ${product}`);
  const json = await resp.json() as { base_increment?: string; quote_increment?: string; base_min_size?: string; min_market_funds?: string };
  const baseIncrement = json.base_increment ?? "";
  const quoteIncrement = json.quote_increment ?? "";
  if (!(parseFloat(baseIncrement) > 0) || !(parseFloat(quoteIncrement) > 0)) {
    throw new Error(`Coinbase: missing/invalid increments for ${product} (base=${baseIncrement} quote=${quoteIncrement})`);
  }
  const val = {
    baseIncrement, quoteIncrement,
    baseMinSize: parseFloat(json.base_min_size ?? "0") || 0,
    quoteMinNotional: parseFloat(json.min_market_funds ?? "0") || 0,
  };
  cbIncrementCache.set(product, { at: Date.now(), val });
  return val;
}

/**
 * Immediate-or-cancel LIMIT order on Coinbase — the bounded hedge primitive.
 * Crosses the spread like a taker but with an EXACT base size and a hard
 * worst-case price; any unfilled remainder cancels instead of resting or
 * spending unbounded quote. Uses smart-order-router IOC config.
 */
export async function coinbaseIocLimitOrder(
  creds: CoinbaseCreds,
  side: "BUY" | "SELL",
  volume: number,
  limitPrice: number,
  pair: Pair = "SOL/USD",
  increments?: CoinbaseIncrements,
): Promise<{ orderId?: string; success?: boolean }> {
  const clientOrderId = crypto.randomUUID();
  const productId = COINBASE_PRODUCTS[pair];
  const orderConfig = {
    sor_limit_ioc: {
      base_size:   increments ? quantizeDown(volume, increments.baseIncrement).text : volume.toFixed(8),
      limit_price: increments ? quantizeDown(limitPrice, increments.quoteIncrement).text : limitPrice.toFixed(2),
    },
  };
  const data = await coinbaseRequest<{ order_id?: string; success?: boolean; success_response?: { order_id: string }; error_response?: { message?: string } }>(
    creds,
    "POST",
    "/api/v3/brokerage/orders",
    { client_order_id: clientOrderId, product_id: productId, side, order_configuration: orderConfig }
  );
  if (data.success === false) throw new Error(`Coinbase IOC order rejected: ${data.error_response?.message ?? "unknown"}`);
  return { orderId: data.success_response?.order_id ?? data.order_id, success: data.success };
}

export async function coinbaseLimitOrder(
  creds: CoinbaseCreds,
  side: "BUY" | "SELL",
  volume: number,
  price: number,
  pair: Pair = "SOL/USD",
  // When provided, size/price are serialized EXACTLY on the product's real
  // increments (quantized down) instead of the legacy fixed 4/2 decimals.
  increments?: CoinbaseIncrements,
): Promise<{ orderId?: string; success?: boolean }> {
  const clientOrderId = crypto.randomUUID();
  const productId = COINBASE_PRODUCTS[pair];
  const orderConfig = {
    limit_limit_gtc: {
      base_size:   increments ? quantizeDown(volume, increments.baseIncrement).text : volume.toFixed(4),
      limit_price: increments ? quantizeDown(price, increments.quoteIncrement).text : price.toFixed(2),
      post_only: true,
    },
  };
  const data = await coinbaseRequest<{ order_id?: string; success?: boolean; success_response?: { order_id: string } }>(
    creds,
    "POST",
    "/api/v3/brokerage/orders",
    {
      client_order_id: clientOrderId,
      product_id: productId,
      side,
      order_configuration: orderConfig,
    }
  );
  return { orderId: data.success_response?.order_id ?? data.order_id, success: data.success };
}
