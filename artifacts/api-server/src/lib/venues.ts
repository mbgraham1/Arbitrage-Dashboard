/**
 * venues.ts — READ-ONLY multi-exchange market scanning (no trading creds).
 *
 * Fetches public REST order-book snapshots from major liquid exchanges so the
 * discovery engine can see where real dislocations live, beyond the two
 * tightly-priced live-execution venues (Kraken/Coinbase).
 *
 * Honesty rules:
 *  - Fees for venues without connected keys are ASSUMED base taker tiers
 *    (published entry-level rates, labeled as assumptions — verify before
 *    funding an account there).
 *  - USDT-quoted venues carry a conservative basis haircut (USDT ≠ USD) so a
 *    cross-quote route can never overstate its net.
 *  - Depth exhaustion → null (never misprice); fetch failures are surfaced
 *    per venue, never silently skipped.
 */

type Level = [number, number];
export type VenueBook = { bids: Level[]; asks: Level[]; fetchedAtMs: number };

export type VenueId =
  | "binanceus" | "okx" | "kucoin" | "gemini" | "bitstamp" | "cryptocom" | "mexc" | "gateio";

export type VenueConfig = {
  id: VenueId;
  name: string;
  quote: "USD" | "USDT";
  /** Published entry-tier taker fee, percent. ASSUMPTION — no account connected. */
  assumedTakerPct: number;
  /** Conservative haircut for USDT/USD basis + conversion friction, percent of notional per leg. */
  basisHaircutPct: number;
  buildUrl: (asset: string) => string;
  parse: (json: unknown) => { bids: Level[]; asks: Level[] } | null;
};

const lv = (rows: unknown[] | undefined, n = 50): Level[] =>
  (rows ?? []).slice(0, n).map((r) => {
    const a = r as [string | number, string | number];
    return [parseFloat(String(a[0])), parseFloat(String(a[1]))] as Level;
  }).filter(([p, q]) => p > 0 && q > 0);

export const VENUES: VenueConfig[] = [
  {
    id: "binanceus", name: "Binance.US", quote: "USD", assumedTakerPct: 0.60, basisHaircutPct: 0,
    buildUrl: a => `https://api.binance.us/api/v3/depth?symbol=${a}USD&limit=50`,
    parse: j => { const d = j as { bids?: unknown[]; asks?: unknown[] }; return d.bids && d.asks ? { bids: lv(d.bids), asks: lv(d.asks) } : null; },
  },
  {
    id: "okx", name: "OKX", quote: "USDT", assumedTakerPct: 0.10, basisHaircutPct: 0.10,
    buildUrl: a => `https://www.okx.com/api/v5/market/books?instId=${a}-USDT&sz=50`,
    parse: j => { const d = (j as { data?: Array<{ bids?: unknown[]; asks?: unknown[] }> }).data?.[0]; return d?.bids && d?.asks ? { bids: lv(d.bids), asks: lv(d.asks) } : null; },
  },
  {
    id: "kucoin", name: "KuCoin", quote: "USDT", assumedTakerPct: 0.10, basisHaircutPct: 0.10,
    buildUrl: a => `https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=${a}-USDT`,
    parse: j => { const d = (j as { data?: { bids?: unknown[]; asks?: unknown[] } }).data; return d?.bids && d?.asks ? { bids: lv(d.bids), asks: lv(d.asks) } : null; },
  },
  {
    id: "gemini", name: "Gemini", quote: "USD", assumedTakerPct: 0.40, basisHaircutPct: 0,
    buildUrl: a => `https://api.gemini.com/v1/book/${a.toLowerCase()}usd?limit_bids=50&limit_asks=50`,
    parse: j => {
      const d = j as { bids?: Array<{ price: string; amount: string }>; asks?: Array<{ price: string; amount: string }> };
      if (!d.bids || !d.asks) return null;
      const cv = (rows: Array<{ price: string; amount: string }>) => rows.map(r => [parseFloat(r.price), parseFloat(r.amount)] as Level).filter(([p, q]) => p > 0 && q > 0);
      return { bids: cv(d.bids), asks: cv(d.asks) };
    },
  },
  {
    id: "bitstamp", name: "Bitstamp", quote: "USD", assumedTakerPct: 0.40, basisHaircutPct: 0,
    buildUrl: a => `https://www.bitstamp.net/api/v2/order_book/${a.toLowerCase()}usd/`,
    parse: j => { const d = j as { bids?: unknown[]; asks?: unknown[] }; return d.bids && d.asks ? { bids: lv(d.bids), asks: lv(d.asks) } : null; },
  },
  {
    id: "cryptocom", name: "Crypto.com", quote: "USD", assumedTakerPct: 0.50, basisHaircutPct: 0,
    buildUrl: a => `https://api.crypto.com/exchange/v1/public/get-book?instrument_name=${a}_USD&depth=50`,
    parse: j => {
      const d = (j as { result?: { data?: Array<{ bids?: unknown[]; asks?: unknown[] }> } }).result?.data?.[0];
      return d?.bids && d?.asks ? { bids: lv(d.bids), asks: lv(d.asks) } : null;
    },
  },
  {
    id: "mexc", name: "MEXC", quote: "USDT", assumedTakerPct: 0.05, basisHaircutPct: 0.10,
    buildUrl: a => `https://api.mexc.com/api/v3/depth?symbol=${a}USDT&limit=50`,
    parse: j => { const d = j as { bids?: unknown[]; asks?: unknown[] }; return d.bids && d.asks ? { bids: lv(d.bids), asks: lv(d.asks) } : null; },
  },
  {
    id: "gateio", name: "Gate.io", quote: "USDT", assumedTakerPct: 0.20, basisHaircutPct: 0.10,
    buildUrl: a => `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${a}_USDT&limit=50`,
    parse: j => { const d = j as { bids?: unknown[]; asks?: unknown[] }; return d.bids && d.asks ? { bids: lv(d.bids), asks: lv(d.asks) } : null; },
  },
];

// ── Snapshot cache + rate-limit-friendly fetching ────────────────────────────
const BOOK_CACHE_MS = 15_000;
const bookCache = new Map<string, { at: number; book: VenueBook | null }>();
const venueErrors = new Map<VenueId, string>();

export function getVenueErrors(): Record<string, string> {
  return Object.fromEntries(venueErrors.entries());
}

async function fetchVenueBook(v: VenueConfig, asset: string): Promise<VenueBook | null> {
  const key = `${v.id}:${asset}`;
  const hit = bookCache.get(key);
  if (hit && Date.now() - hit.at < BOOK_CACHE_MS) return hit.book;
  let book: VenueBook | null = null;
  try {
    const resp = await fetch(v.buildUrl(asset), { signal: AbortSignal.timeout(6_000), headers: { "User-Agent": "cat-arb-discovery/1.0" } });
    if (resp.ok) {
      const parsed = v.parse(await resp.json());
      if (parsed && parsed.bids.length && parsed.asks.length) {
        book = { ...parsed, fetchedAtMs: Date.now() };
        venueErrors.delete(v.id);
      }
    } else if (resp.status !== 400 && resp.status !== 404) {
      // 400/404 = pair not listed there (normal); anything else is a venue problem.
      venueErrors.set(v.id, `HTTP ${resp.status}`);
    }
  } catch (e) {
    venueErrors.set(v.id, (e as Error).message.slice(0, 80));
  }
  bookCache.set(key, { at: Date.now(), book });
  return book;
}

/** Fetch books for many venue×asset combos with bounded concurrency. */
export async function fetchAllVenueBooks(assets: readonly string[]): Promise<Map<string, VenueBook>> {
  const out = new Map<string, VenueBook>();
  const jobs: Array<{ v: VenueConfig; a: string }> = [];
  for (const v of VENUES) for (const a of assets) jobs.push({ v, a });
  const CONCURRENCY = 8;
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      const b = await fetchVenueBook(j.v, j.a);
      if (b) out.set(`${j.v.id}:${j.a}`, b);
    }
  }));
  return out;
}

// ── Depth-walk helpers (same never-misprice standard as cross-mm) ────────────
export function walkBuyUsd(asks: Level[], sizeUsd: number): { qty: number; usd: number; top: number } | null {
  const top = asks[0]?.[0] ?? 0;
  if (top <= 0) return null;
  let remainingUsd = sizeUsd, qty = 0;
  for (const [px, vol] of asks) {
    const lvlUsd = px * vol;
    const spend = Math.min(remainingUsd, lvlUsd);
    qty += spend / px;
    remainingUsd -= spend;
    if (remainingUsd <= 1e-9) return { qty, usd: sizeUsd, top };
  }
  return null; // depth exhausted
}

export function walkSellQty(bids: Level[], qty: number): { usd: number; top: number } | null {
  const top = bids[0]?.[0] ?? 0;
  if (top <= 0) return null;
  let remaining = qty, usd = 0;
  for (const [px, vol] of bids) {
    const take = Math.min(remaining, vol);
    usd += take * px;
    remaining -= take;
    if (remaining <= 1e-12) return { usd, top };
  }
  return null;
}
