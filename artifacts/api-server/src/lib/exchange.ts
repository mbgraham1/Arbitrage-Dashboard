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

async function krakenPrivateRequest<T>(path: string, data: Record<string, string>, creds: KrakenCreds): Promise<T> {
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
 * Value the ENTIRE Kraken account in USD from actual balances — the ground
 * truth for realized P&L. USD/stables count at par; every other asset is
 * priced at the live Ticker mid. Assets we can't price are reported so the
 * caller can surface the gap instead of silently under-counting.
 */
export async function krakenAccountValueUsd(creds: KrakenCreds): Promise<{
  totalUsd: number;
  usdBalance: number;
  holdingsUsd: number;
  holdings: { currency: string; amount: number; usdValue: number | null }[];
  unpriced: string[];
}> {
  const balances = await getKrakenBalances(creds);
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

export async function getKrakenBalances(creds: KrakenCreds): Promise<BalanceEntry[]> {
  const result = await krakenPrivateRequest<Record<string, string>>("/0/private/Balance", {}, creds);
  return Object.entries(result)
    .filter(([, v]) => parseFloat(v) > 0)
    .map(([currency, amount]) => ({ currency, amount: parseFloat(amount) }));
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
    oflags: "post", // post-only: rejected if it would cross spread (maker only)
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
export async function krakenFeeTiers(creds: KrakenCreds, rawPairs: string[]): Promise<{ takerFeePct: number; makerFeePct: number | null } | null> {
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

export async function coinbaseLimitOrder(
  creds: CoinbaseCreds,
  side: "BUY" | "SELL",
  volume: number,
  price: number,
  pair: Pair = "SOL/USD",
): Promise<{ orderId?: string; success?: boolean }> {
  const clientOrderId = crypto.randomUUID();
  const productId = COINBASE_PRODUCTS[pair];
  const orderConfig = {
    limit_limit_gtc: {
      base_size: volume.toFixed(4),
      limit_price: price.toFixed(2),
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
