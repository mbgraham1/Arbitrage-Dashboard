/**
 * Exchange integration helpers for Kraken and Coinbase Advanced Trade API.
 * Uses only Node.js built-in crypto + fetch (Node 24+).
 */
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Pair symbol mappings
// ---------------------------------------------------------------------------

export const PAIRS = [
  "BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD", "DOT/USD",
  "POL/USD", "LINK/USD", "UNI/USD", "ATOM/USD", "ADA/USD",
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

/**
 * Pace + backoff-gate a private call. The per-key chain holds ONLY the paced
 * HTTP call (min gap + ≤10s HTTP timeout) — backoff sleeps happen OUTSIDE the
 * chain so a read's retry can never block a queued order/unwind behind a
 * multi-second sleep. Reads retry on rate-limit; order mutations never do.
 */
/** Liveness hook: called on every private-call attempt AND every few seconds
 *  during rate-limit backoff sleeps, so the execution-lock heartbeat never
 *  goes silent while a live executor is legitimately waiting on Kraken.
 *  Registered by the arb router (touches the live execution lock). */
let privateCallHeartbeat: (() => void) | null = null;
export function setPrivateCallHeartbeat(fn: () => void): void {
  privateCallHeartbeat = fn;
}
const beat = () => { try { privateCallHeartbeat?.(); } catch { /* never break a call */ } };

async function withPrivateLimiter<T>(key: string, fn: () => Promise<T>, retryOnRateLimit: boolean): Promise<T> {
  const st = limiterFor(key);
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
      return fn();
    });
    st.chain = p.catch(() => undefined); // keep the chain alive on failures
    try {
      const out = await p;
      st.backoffMs = 2_000; // healthy call — reset backoff
      return out;
    } catch (e) {
      if (!isRateLimitError(e)) throw e;
      st.rateLimitedUntil = Date.now() + st.backoffMs;
      st.backoffMs = Math.min(RATE_BACKOFF_MAX_MS, st.backoffMs * 2);
      if (!retryOnRateLimit || attempt >= 2) throw e;
    }
  }
}

async function krakenPrivateRequest<T>(path: string, data: Record<string, string>, creds: KrakenCreds): Promise<T> {
  // Reads are safe to retry after a rate-limit backoff; order mutations are not.
  const isRead = !/AddOrder|CancelOrder/.test(path);
  return withPrivateLimiter(creds.krakenKey, () => krakenPrivateRequestRaw<T>(path, data, creds), isRead);
}

async function krakenPrivateRequestRaw<T>(path: string, data: Record<string, string>, creds: KrakenCreds): Promise<T> {
  const nonce = Date.now().toString() + Math.random().toString().slice(2, 7);
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

/**
 * Net external cash flow (USD) into the Kraken account since `sinceUnix`:
 * deposits + incoming transfers − withdrawals − outgoing transfers, from the
 * private Ledgers API. Non-USD flows are valued at CURRENT ticker prices
 * (approximation — historical prices aren't fetched). Trades/fees excluded.
 */
export async function krakenNetCashFlowUsd(creds: KrakenCreds, sinceUnix: number): Promise<{ netUsd: number; entries: number; approximated: boolean; complete: boolean }> {
  type LedgerEntry = { refid: string; time: number; type: string; asset: string; amount: string; fee: string };
  let ofs = 0, entries = 0, approximated = false, complete = false;
  const flows = new Map<string, number>(); // asset → net amount
  const MAX_PAGES = 40; // 40 × 50 = 2,000 ledger entries since baseline
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await krakenPrivateRequest<{ ledger: Record<string, LedgerEntry>; count: number }>(
      "/0/private/Ledgers", { start: String(sinceUnix), ofs: String(ofs) }, creds);
    const rows = Object.values(result.ledger ?? {});
    if (rows.length === 0) { complete = true; break; }
    for (const e of rows) {
      if (e.type !== "deposit" && e.type !== "withdrawal" && e.type !== "transfer") continue;
      entries++;
      flows.set(e.asset, (flows.get(e.asset) ?? 0) + parseFloat(e.amount));
    }
    ofs += rows.length;
    if (ofs >= (result.count ?? 0)) { complete = true; break; }
  }
  let netUsd = 0;
  const normalize = (c: string) => {
    const stripped = c.length >= 4 && (c.startsWith("X") || c.startsWith("Z")) ? c.slice(1) : c;
    return stripped.replace(/\.(HOLD|[SF])$/, "");
  };
  for (const [rawAsset, amount] of flows) {
    if (Math.abs(amount) < 1e-12) continue;
    const asset = normalize(rawAsset);
    if (asset === "USD" || asset === "USDT" || asset === "USDC") { netUsd += amount; continue; }
    try {
      const t = await krakenPublicRequest<Record<string, { c: string[] }>>("/0/public/Ticker", { pair: `${asset}USD` });
      const first = Object.values(t)[0];
      const price = first ? parseFloat(first.c[0]!) : NaN;
      if (isFinite(price)) { netUsd += amount * price; approximated = true; }
      else approximated = true;
    } catch { approximated = true; }
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
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: KRAKEN_REST_PAIRS[pair],
    type: side,
    ordertype: "market",
    volume: volume.toFixed(8),
  }, creds);
}

export async function krakenLimitOrder(
  creds: KrakenCreds,
  side: "buy" | "sell",
  volume: number,
  price: number,
  pair: Pair = "SOL/USD",
): Promise<{ txid: string[] }> {
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: KRAKEN_REST_PAIRS[pair],
    type: side,
    ordertype: "limit",
    post_only: "true",
    volume: volume.toFixed(8),
    price: price.toFixed(2),
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
    price: price.toFixed(8),
    volume: volume.toFixed(8),
    // post-only: rejected if it would cross spread (maker only).
    // fciq: fee always charged in the QUOTE currency, so cost/fee accounting
    // (aConsumed = cost + fee, received = cost − fee) is guaranteed correct
    // regardless of the account's fee-currency preference.
    oflags: "post,fciq",
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
    volume: volume.toFixed(8),
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
    price: price.toFixed(8),
    volume: volume.toFixed(8),
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
  const jwt = buildCoinbaseJwt(creds.coinbaseKey, creds.coinbaseSecret, method, path);
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
  const data = await coinbaseRequest<{ accounts: Array<{ currency: string; available_balance: { value: string } }> }>(
    creds,
    "GET",
    "/api/v3/brokerage/accounts"
  );
  return (data.accounts || [])
    .filter((a) => parseFloat(a.available_balance.value) > 0)
    .map((a) => ({ currency: a.currency, amount: parseFloat(a.available_balance.value) }));
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

export interface CoinbaseIncrements { baseIncrement: string; quoteIncrement: string; }

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
export async function getCoinbaseProductIncrements(pair: Pair): Promise<CoinbaseIncrements> {
  const product = COINBASE_PRODUCTS[pair];
  const hit = cbIncrementCache.get(product);
  if (hit && Date.now() - hit.at < CB_INCREMENT_CACHE_MS) return hit.val;
  const resp = await fetch(`https://api.exchange.coinbase.com/products/${product}`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Coinbase product info HTTP ${resp.status} for ${product}`);
  const json = await resp.json() as { base_increment?: string; quote_increment?: string };
  const baseIncrement = json.base_increment ?? "";
  const quoteIncrement = json.quote_increment ?? "";
  if (!(parseFloat(baseIncrement) > 0) || !(parseFloat(quoteIncrement) > 0)) {
    throw new Error(`Coinbase: missing/invalid increments for ${product} (base=${baseIncrement} quote=${quoteIncrement})`);
  }
  const val = { baseIncrement, quoteIncrement };
  cbIncrementCache.set(product, { at: Date.now(), val });
  return val;
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
