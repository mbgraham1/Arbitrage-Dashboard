/**
 * gemini.ts — Gemini private REST access (READ-ONLY endpoints only).
 *
 * Used for: connection test, balance readout, and detected fee tier
 * (/v1/notionalvolume returns the account's actual api maker/taker bps).
 *
 * HARD RULE: no order-placement endpoint may ever be called from this module.
 * (Order flow lives in gemini-exec.ts and is imported only by the executor.)
 *
 * ACCOUNT-SCOPE HONESTY: a Gemini API key sees ONE account's funds by default
 * (its own account for account-scoped keys; the "primary" account for master
 * keys unless an `account` field is sent). Successful auth or fee detection is
 * NOT proof that private balances are visible — a funded Gemini can still show
 * $0.00 if the key is scoped to a different (empty) account or lacks the
 * balance permission. This module therefore:
 *  - reads full balance rows (total amount + available + held = amount−available),
 *  - for MASTER keys, enumerates all accounts via /v1/account/list and reads
 *    each account's balances so funds can never silently hide,
 *  - reports an explicit scope diagnostic instead of a silent $0.00.
 */
import crypto from "node:crypto";

export type GeminiCreds = { geminiKey: string; geminiSecret: string };

export type GeminiBalanceRow = {
  currency: string;
  /** Total amount in the account (includes held/reserved). */
  total: number;
  /** Available/tradable now. */
  available: number;
  /** Held / reserved (open orders etc.) = total − available. */
  held: number;
};

export type GeminiAccountScope = {
  /** Gemini account name/label this row set came from (null = key's default scope). */
  account: string | null;
  balances: GeminiBalanceRow[];
  error: string | null; // per-account fetch failure (exact Gemini reason)
};

export type GeminiAccount = {
  /** Detected fee tier from /v1/notionalvolume, percent. */
  makerPct: number;
  takerPct: number;
  /** Available (tradable) USD in the TRADING SCOPE (the key's default account). */
  usdBalance: number;
  /** Available (tradable) balances by currency in the trading scope (non-zero only). */
  balances: Record<string, number>;
  /** Full per-currency detail for the trading scope. */
  balanceDetail: GeminiBalanceRow[];
  /** Key type as detected: master keys can enumerate accounts. */
  keyScope: "master" | "account";
  /** All account scopes visible to the key (master keys: every account; account keys: just the default). */
  accountScopes: GeminiAccountScope[];
  /**
   * Explicit diagnostic when something about scope/permissions would otherwise
   * look like "$0.00": e.g. funds found in a DIFFERENT account than the key's
   * trading scope, or the balances call failed. null = balances verified clean.
   */
  scopeIssue: string | null;
  detectedAt: number;
};

const READONLY_ALLOWED = new Set(["/v1/notionalvolume", "/v1/balances", "/v1/account", "/v1/account/list", "/v1/roles"]);

// Monotonic per-process nonce shared by ALL Gemini private callers (this module
// and gemini-exec). Gemini nonces are per-key: two modules with independent
// Date.now() counters on the same key can collide in the same millisecond.
let lastNonce = 0;
export function geminiNextNonce(): string {
  const n = Math.max(Date.now(), lastNonce + 1);
  lastNonce = n;
  return String(n);
}

async function geminiPrivate<T>(creds: GeminiCreds, path: string, fields: Record<string, unknown> = {}): Promise<T> {
  if (!READONLY_ALLOWED.has(path)) throw new Error(`Gemini endpoint ${path} is not on the read-only allowlist`);
  const payload = Buffer.from(JSON.stringify({ request: path, nonce: geminiNextNonce(), ...fields })).toString("base64");
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

type RawBalance = { currency: string; amount?: string; available: string };

function parseRows(bals: RawBalance[]): GeminiBalanceRow[] {
  const rows: GeminiBalanceRow[] = [];
  for (const b of Array.isArray(bals) ? bals : []) {
    const available = parseFloat(b.available) || 0;
    const total = b.amount != null ? (parseFloat(b.amount) || 0) : available;
    if (total <= 0 && available <= 0) continue;
    rows.push({ currency: b.currency.toUpperCase(), total, available, held: Math.max(0, total - available) });
  }
  return rows;
}

// Short cache keyed by SHA-256 of the full key pair (same standard as lib/fees.ts —
// prefix-keyed caches can serve another account's tier).
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; acct: GeminiAccount }>();
const cacheKey = (c: GeminiCreds) => crypto.createHash("sha256").update(`${c.geminiKey}:${c.geminiSecret}`).digest("hex");

/**
 * Verify credentials and return detected fee tier + VERIFIED balances with
 * scope diagnostics. Throws on auth/fee failure — never silently assumes.
 * A balance-read failure does NOT throw when fees verified: it returns with
 * scopeIssue set so callers can show the exact problem (and must treat
 * balances as UNVERIFIED — usdBalance/balances are zeroed in that case).
 */
export async function geminiVerify(creds: GeminiCreds, opts: { maxAgeMs?: number } = {}): Promise<GeminiAccount> {
  const key = cacheKey(creds);
  const hit = cache.get(key);
  // Live execution paths pass maxAgeMs: 0 — balances must be re-read fresh;
  // only display/scan paths may accept the multi-minute cache.
  const maxAge = Math.min(CACHE_MS, opts.maxAgeMs ?? CACHE_MS);
  if (hit && Date.now() - hit.at < maxAge) return hit.acct;

  // 1. Fee tier — hard requirement; failure here means the key is unusable.
  const vol = await geminiPrivate<{ api_maker_fee_bps?: number; api_taker_fee_bps?: number; web_maker_fee_bps?: number; web_taker_fee_bps?: number }>(creds, "/v1/notionalvolume");
  const makerBps = vol.api_maker_fee_bps ?? vol.web_maker_fee_bps;
  const takerBps = vol.api_taker_fee_bps ?? vol.web_taker_fee_bps;
  if (makerBps == null || takerBps == null) throw new Error("Gemini fee tier not present in /v1/notionalvolume response");

  // 2. Balances in the key's DEFAULT (trading) scope — full rows, never just "available".
  let defaultRows: GeminiBalanceRow[] = [];
  let defaultErr: string | null = null;
  try {
    defaultRows = parseRows(await geminiPrivate<RawBalance[]>(creds, "/v1/balances"));
  } catch (e) {
    defaultErr = (e as Error).message; // exact Gemini reason (e.g. missing role/permission)
  }

  // 3. Master-key detection: /v1/account/list only works for master keys.
  //    For master keys, read EVERY account so funds can never silently hide.
  let keyScope: "master" | "account" = "account";
  const accountScopes: GeminiAccountScope[] = [{ account: null, balances: defaultRows, error: defaultErr }];
  try {
    const accounts = await geminiPrivate<Array<{ name: string; account: string; type?: string }>>(creds, "/v1/account/list");
    if (Array.isArray(accounts) && accounts.length) {
      keyScope = "master";
      for (const a of accounts) {
        const label = a.account ?? a.name;
        try {
          const rows = parseRows(await geminiPrivate<RawBalance[]>(creds, "/v1/balances", { account: label }));
          accountScopes.push({ account: label, balances: rows, error: null });
        } catch (e) {
          accountScopes.push({ account: label, balances: [], error: (e as Error).message });
        }
      }
    }
  } catch { /* account-scoped key — expected; default scope is the whole story */ }

  // 4. Scope diagnostic: auth/fees working is NOT proof balances are visible.
  let scopeIssue: string | null = null;
  const defaultTotal = defaultRows.reduce((s, r) => s + r.total, 0);
  if (defaultErr) {
    scopeIssue = `Balance read FAILED for this key's trading scope: ${defaultErr}. The key may lack the balances/auditor permission — balances are UNVERIFIED, not $0.`;
  } else if (defaultTotal <= 0) {
    const funded = accountScopes.filter(sc => sc.account != null && sc.balances.some(r => r.total > 0));
    if (funded.length) {
      const desc = funded.map(sc => `'${sc.account}' (${sc.balances.map(r => `${r.available.toFixed(r.currency === "USD" ? 2 : 6)} ${r.currency} available`).join(", ")})`).join("; ");
      scopeIssue = `Your funds are in Gemini account ${desc}, but this API key TRADES against a different (empty) scope. Fix on Gemini's side: create the API key on the funded account, or transfer funds to the key's account.`;
    } else if (keyScope === "account") {
      scopeIssue = "Gemini reports ZERO balances for this key's account scope. If your Gemini shows funds, this key is likely scoped to a different account (e.g. a perps/derivatives or another sub-account) — create the key on the funded account, or the funds may be in a product scope (e.g. Perpetuals) that /v1/balances does not cover.";
    } else {
      scopeIssue = "No funds found in ANY account visible to this master key — if Gemini shows a balance, it may sit in a product scope (e.g. Perpetuals/Earn) not covered by exchange balances.";
    }
  }

  const balances: Record<string, number> = {};
  for (const r of defaultRows) if (r.available > 0) balances[r.currency] = r.available;

  const acct: GeminiAccount = {
    makerPct: makerBps / 100,
    takerPct: takerBps / 100,
    usdBalance: balances["USD"] ?? 0,
    balances,
    balanceDetail: defaultRows,
    keyScope,
    accountScopes,
    scopeIssue,
    detectedAt: Date.now(),
  };
  cache.set(key, { at: Date.now(), acct });
  return acct;
}

/** Read-only probe of the key's roles — withdrawals require the Fund Manager
 * role AND (when enabled) an approved-address whitelist. Never guesses. */
export async function geminiRoles(creds: GeminiCreds): Promise<{ isFundManager: boolean; isTrader: boolean; raw: Record<string, unknown> }> {
  const r = await geminiPrivate<Record<string, unknown>>(creds, "/v1/roles");
  return { isFundManager: r.isFundManager === true, isTrader: r.isTrader === true, raw: r };
}
