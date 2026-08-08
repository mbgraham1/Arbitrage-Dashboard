/**
 * gemini.ts — Gemini private REST access (READ-ONLY endpoints only).
 *
 * Used for: connection test, balance readout, and detected fee tier
 * (/v1/notionalvolume returns the account's actual api maker/taker bps).
 *
 * HARD RULE: no order-placement endpoint may ever be called from this module.
 * Gemini is a data/verification venue — live execution stays Kraken/Coinbase
 * only, behind the existing $10 cap and safety gates.
 */
import crypto from "node:crypto";

export type GeminiCreds = { geminiKey: string; geminiSecret: string };
export type GeminiAccount = {
  /** Detected fee tier from /v1/notionalvolume, percent. */
  makerPct: number;
  takerPct: number;
  /** Spendable USD balance. */
  usdBalance: number;
  /** Spendable balances by currency (non-zero only). */
  balances: Record<string, number>;
  detectedAt: number;
};

const READONLY_ALLOWED = new Set(["/v1/notionalvolume", "/v1/balances", "/v1/account"]);

async function geminiPrivate<T>(creds: GeminiCreds, path: string): Promise<T> {
  if (!READONLY_ALLOWED.has(path)) throw new Error(`Gemini endpoint ${path} is not on the read-only allowlist`);
  const payload = Buffer.from(JSON.stringify({ request: path, nonce: Date.now().toString() })).toString("base64");
  const signature = crypto.createHmac("sha384", creds.geminiSecret).update(payload).digest("hex");
  const resp = await fetch(`https://api.gemini.com${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
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
    throw new Error(`Gemini ${path}: ${(body as { reason?: string }).reason ?? resp.status} ${(body as { message?: string }).message ?? ""}`.trim());
  }
  return body;
}

// Short cache keyed by SHA-256 of the full key pair (same standard as lib/fees.ts —
// prefix-keyed caches can serve another account's tier).
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; acct: GeminiAccount }>();
const cacheKey = (c: GeminiCreds) => crypto.createHash("sha256").update(`${c.geminiKey}:${c.geminiSecret}`).digest("hex");

/** Verify credentials and return detected fee tier + spendable balances. Throws on failure — never silently assumes. */
export async function geminiVerify(creds: GeminiCreds): Promise<GeminiAccount> {
  const key = cacheKey(creds);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.acct;

  const [vol, bals] = await Promise.all([
    geminiPrivate<{ api_maker_fee_bps?: number; api_taker_fee_bps?: number; web_maker_fee_bps?: number; web_taker_fee_bps?: number }>(creds, "/v1/notionalvolume"),
    geminiPrivate<Array<{ currency: string; available: string }>>(creds, "/v1/balances"),
  ]);
  const makerBps = vol.api_maker_fee_bps ?? vol.web_maker_fee_bps;
  const takerBps = vol.api_taker_fee_bps ?? vol.web_taker_fee_bps;
  if (makerBps == null || takerBps == null) throw new Error("Gemini fee tier not present in /v1/notionalvolume response");
  const balances: Record<string, number> = {};
  for (const b of Array.isArray(bals) ? bals : []) {
    const v = parseFloat(b.available);
    if (v > 0) balances[b.currency.toUpperCase()] = v;
  }
  const acct: GeminiAccount = {
    makerPct: makerBps / 100,
    takerPct: takerBps / 100,
    usdBalance: balances["USD"] ?? 0,
    balances,
    detectedAt: Date.now(),
  };
  cache.set(key, { at: Date.now(), acct });
  return acct;
}
