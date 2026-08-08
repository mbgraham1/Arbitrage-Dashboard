/**
 * gemini-exec.ts — Gemini LIVE order execution primitives.
 *
 * Deliberately separate from lib/gemini.ts (read-only module): importing THIS
 * file is the explicit, auditable act of enabling Gemini order flow. Only the
 * cross-venue executor route may import it.
 *
 * Safety standard (parity with Kraken/Coinbase in lib/exchange.ts):
 *  - IOC-style limit orders only ("immediate-or-cancel") — no resting market
 *    orders; a crossed IOC at a bounded price is the Gemini equivalent of the
 *    bounded Coinbase IOC the 2X executor uses.
 *  - The ONLY truth about a fill is /v1/order/status executed_amount +
 *    avg_execution_price + fee fields — never the submit response alone.
 *  - Monotonic nonce: Gemini nonces must strictly increase per key; a plain
 *    Date.now() collides when two calls land in the same millisecond.
 *  - Symbol metadata (min order size, tick/quote increments) comes from the
 *    public /v1/symbols/details endpoint and is MANDATORY before any order —
 *    never guess precision on a live venue.
 */
import crypto from "node:crypto";
import type { GeminiCreds } from "./gemini";

const BASE = "https://api.gemini.com";

// ── monotonic nonce (per process) ─────────────────────────────────────────────
let lastNonce = 0;
function nextNonce(): string {
  const n = Math.max(Date.now(), lastNonce + 1);
  lastNonce = n;
  return String(n);
}

/** Order-flow endpoints this module may call. Anything else throws. */
const ORDER_ALLOWED = new Set(["/v1/order/new", "/v1/order/status", "/v1/order/cancel"]);

async function geminiOrderApi<T>(creds: GeminiCreds, path: string, fields: Record<string, unknown>): Promise<T> {
  if (!ORDER_ALLOWED.has(path)) throw new Error(`Gemini exec endpoint ${path} not allowlisted`);
  const payload = Buffer.from(JSON.stringify({ request: path, nonce: nextNonce(), ...fields })).toString("base64");
  const signature = crypto.createHmac("sha384", creds.geminiSecret).update(payload).digest("hex");
  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": "0",
      "X-GEMINI-APIKEY": creds.geminiKey,
      "X-GEMINI-PAYLOAD": payload,
      "X-GEMINI-SIGNATURE": signature,
      "Cache-Control": "no-cache",
    },
  });
  const body = (await resp.json()) as T & { result?: string; reason?: string; message?: string };
  if (!resp.ok || (body as { result?: string }).result === "error") {
    // Reason is Gemini's machine code (e.g. InsufficientFunds, InvalidNonce).
    throw new Error(`Gemini ${path}: ${(body as { reason?: string }).reason ?? resp.status} ${(body as { message?: string }).message ?? ""}`.trim());
  }
  return body;
}

/** True only for Gemini's EXPLICIT rejections — the exchange answered and
 *  refused, so the order definitively does not exist. Anything else
 *  (timeout, network, parse) is ambiguous: the order MAY have been accepted. */
export function isExplicitGeminiReject(msg: string): boolean {
  return /InsufficientFunds|InvalidQuantity|InvalidPrice|InvalidSymbol|InvalidSide|InvalidOrderType|MarketNotOpen|Maintenance|InvalidSignature|InvalidApiKey|MissingApikeyHeader|RateLimit/i.test(msg);
}

// ── symbol metadata ───────────────────────────────────────────────────────────
export interface GeminiSymbolDetails {
  symbol: string;            // e.g. BTCUSD
  minOrderSize: number;      // in base units
  tickSize: number;          // base increment (quantity step)
  quoteIncrement: number;    // price step
  status: string;            // "open" expected
}

const symCache = new Map<string, { at: number; d: GeminiSymbolDetails }>();
const SYM_TTL = 60 * 60_000;

/** Public metadata — MANDATORY before any order. Throws when unavailable. */
export async function geminiSymbolDetails(symbol: string): Promise<GeminiSymbolDetails> {
  const key = symbol.toLowerCase();
  const hit = symCache.get(key);
  if (hit && Date.now() - hit.at < SYM_TTL) return hit.d;
  const r = await fetch(`${BASE}/v1/symbols/details/${key}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Gemini symbol details ${symbol}: HTTP ${r.status}`);
  const j = await r.json() as { symbol?: string; min_order_size?: string; tick_size?: number; quote_increment?: number; status?: string };
  const minOrderSize = parseFloat(j.min_order_size ?? "");
  if (!j.symbol || !isFinite(minOrderSize) || j.tick_size == null || j.quote_increment == null) {
    throw new Error(`Gemini symbol details ${symbol}: incomplete response`);
  }
  const d: GeminiSymbolDetails = { symbol: j.symbol, minOrderSize, tickSize: j.tick_size, quoteIncrement: j.quote_increment, status: j.status ?? "unknown" };
  symCache.set(key, { at: Date.now(), d });
  return d;
}

/** All open Gemini symbols (lowercase, e.g. "btcusd"). Cached 1h. */
let symbolsCache: { at: number; list: string[] } | null = null;
export async function geminiSymbols(): Promise<string[]> {
  if (symbolsCache && Date.now() - symbolsCache.at < SYM_TTL) return symbolsCache.list;
  const r = await fetch(`${BASE}/v1/symbols`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Gemini symbols: HTTP ${r.status}`);
  const list = (await r.json()) as string[];
  symbolsCache = { at: Date.now(), list };
  return list;
}

/** Quantize a quantity DOWN to the symbol's tick (base) increment. */
export function geminiQuantizeQty(qty: number, tickSize: number): number {
  if (tickSize <= 0) throw new Error("invalid tickSize");
  // tickSize like 1e-8 — use decimal string math to dodge float dust.
  const steps = Math.floor(qty / tickSize + 1e-9);
  return parseFloat((steps * tickSize).toPrecision(12));
}

/** Quantize a price to the symbol's quote increment (down for buys is fine —
 *  bounded IOC prices are protective, not exact). */
export function geminiQuantizePrice(price: number, quoteIncrement: number): number {
  if (quoteIncrement <= 0) throw new Error("invalid quoteIncrement");
  const steps = Math.floor(price / quoteIncrement + 1e-9);
  return parseFloat((steps * quoteIncrement).toPrecision(12));
}

// ── orders ────────────────────────────────────────────────────────────────────
interface GeminiOrderResponse {
  order_id: string;
  symbol: string;
  is_live: boolean;
  is_cancelled: boolean;
  executed_amount: string;
  remaining_amount: string;
  avg_execution_price: string;
  original_amount: string;
  price: string;
}

export interface GeminiOrderInfo {
  orderId: string;
  /** Terminal when the order can no longer fill further. */
  terminal: boolean;
  status: string;             // "live" | "cancelled" | "filled"
  filledQty: number;
  avgPrice: number;           // 0 when nothing filled
  notionalUsd: number;        // filledQty * avgPrice
}

function toInfo(o: GeminiOrderResponse): GeminiOrderInfo {
  const filledQty = parseFloat(o.executed_amount) || 0;
  const avgPrice = parseFloat(o.avg_execution_price) || 0;
  const remaining = parseFloat(o.remaining_amount) || 0;
  const terminal = !o.is_live; // IOC: not-live == final (filled and/or cancelled remainder)
  const status = o.is_live ? "live" : remaining <= 0 && filledQty > 0 ? "filled" : o.is_cancelled ? "cancelled" : "done";
  return { orderId: String(o.order_id), terminal, status, filledQty, avgPrice, notionalUsd: filledQty * avgPrice };
}

/**
 * Bounded IOC limit order. `limitPrice` is the protective bound (already
 * computed from a FRESH book by the caller); quantized here to the symbol's
 * increments. Returns the submit-time order info — callers MUST still poll
 * geminiOrderStatus until terminal before trusting fills.
 */
export async function geminiIocLimitOrder(
  creds: GeminiCreds,
  side: "buy" | "sell",
  symbol: string,
  qty: number,
  limitPrice: number,
  details: GeminiSymbolDetails,
): Promise<GeminiOrderInfo> {
  const amount = geminiQuantizeQty(qty, details.tickSize);
  const price = geminiQuantizePrice(limitPrice, details.quoteIncrement);
  if (amount < details.minOrderSize) {
    throw new Error(`InvalidQuantity: ${amount} below Gemini min order size ${details.minOrderSize} for ${symbol}`);
  }
  const o = await geminiOrderApi<GeminiOrderResponse>(creds, "/v1/order/new", {
    symbol: symbol.toLowerCase(),
    amount: String(amount),
    price: String(price),
    side,
    type: "exchange limit",
    options: ["immediate-or-cancel"],
  });
  return toInfo(o);
}

/** Poll-able order status — the ONLY truth about fills. */
export async function geminiOrderStatus(creds: GeminiCreds, orderId: string): Promise<GeminiOrderInfo> {
  const o = await geminiOrderApi<GeminiOrderResponse>(creds, "/v1/order/status", { order_id: orderId });
  return toInfo(o);
}
