/**
 * Exchange integration helpers for Kraken and Coinbase Advanced Trade API.
 * Uses only Node.js built-in crypto + fetch (Node 24+).
 */
import crypto from "node:crypto";

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
const KRAKEN_PAIR = "SOLUSD";

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

export async function getKrakenPrice(): Promise<number> {
  const result = await krakenPublicRequest<Record<string, { c: string[] }>>("/0/public/Ticker", { pair: KRAKEN_PAIR });
  const ticker = Object.values(result)[0];
  return parseFloat(ticker.c[0]);
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
  volume: number
): Promise<{ txid: string[] }> {
  return krakenPrivateRequest<{ txid: string[] }>("/0/private/AddOrder", {
    pair: KRAKEN_PAIR,
    type: side,
    ordertype: "market",
    volume: volume.toFixed(8),
  }, creds);
}

// ---------------------------------------------------------------------------
// Coinbase Advanced Trade API helpers (JWT auth, ES256)
// ---------------------------------------------------------------------------

const COINBASE_BASE = "https://api.coinbase.com";
const COINBASE_PRODUCT = "SOL-USD";

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

export async function getCoinbasePrice(creds: CoinbaseCreds): Promise<number> {
  const data = await coinbaseRequest<{ best_bid: string; best_ask: string }>(
    creds,
    "GET",
    `/api/v3/brokerage/best_bid_ask?product_ids=${COINBASE_PRODUCT}`
  );
  // Use mid of bid/ask
  const pricebooks = (data as unknown as { pricebooks?: Array<{ best_bid: string; best_ask: string }> }).pricebooks;
  if (pricebooks && pricebooks[0]) {
    const bid = parseFloat(pricebooks[0].best_bid);
    const ask = parseFloat(pricebooks[0].best_ask);
    return (bid + ask) / 2;
  }
  throw new Error("Coinbase: no price data in response");
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
  price: number
): Promise<{ orderId?: string; success?: boolean }> {
  const clientOrderId = crypto.randomUUID();
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
      product_id: COINBASE_PRODUCT,
      side,
      order_configuration: orderConfig,
    }
  );
  return { orderId: data.success_response?.order_id ?? data.order_id, success: data.success };
}
