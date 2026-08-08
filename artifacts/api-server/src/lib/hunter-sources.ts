/**
 * hunter-sources.ts — extra READ-ONLY data sources for Profit Hunter mode:
 *  - Stablecoin (USDT/USDC vs USD) order books on USD-quoted venues
 *  - Spot-vs-perpetual funding/basis data (OKX perps + Gate.io funding)
 *
 * Same honesty rules as venues.ts: public endpoints only, depth exhaustion →
 * null, failures surfaced, nothing here can trade.
 */

type Level = [number, number];
export type StableBook = { venue: string; venueName: string; bids: Level[]; asks: Level[]; takerPct: number; feeSource: "assumed"; regionOk: boolean };

const lv = (rows: unknown[] | undefined, n = 25): Level[] =>
  (rows ?? []).slice(0, n).map(r => {
    const a = r as [string | number, string | number];
    return [parseFloat(String(a[0])), parseFloat(String(a[1]))] as Level;
  }).filter(([p, q]) => p > 0 && q > 0);

const CACHE_MS = 20_000;
const cache = new Map<string, { at: number; val: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.val as T | null;
  try {
    const val = await fn();
    cache.set(key, { at: Date.now(), val });
    return val;
  } catch {
    cache.set(key, { at: Date.now(), val: null });
    return null;
  }
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(6_000), headers: { "User-Agent": "cat-arb-hunter/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** USD-quoted stablecoin books per venue. Taker fees are ASSUMED entry tiers. */
export async function fetchStableBooks(stable: "USDT" | "USDC"): Promise<StableBook[]> {
  const out: StableBook[] = [];
  const jobs: Array<Promise<void>> = [
    (async () => {
      const j = await cached(`k:${stable}`, () => getJson(`https://api.kraken.com/0/public/Depth?pair=${stable === "USDT" ? "USDTZUSD" : "USDCUSD"}&count=25`));
      const res = (j as { result?: Record<string, { bids?: unknown[]; asks?: unknown[] }> } | null)?.result;
      const b = res ? Object.values(res)[0] : null;
      if (b?.bids?.length && b?.asks?.length) out.push({ venue: "kraken", venueName: "Kraken", bids: lv(b.bids), asks: lv(b.asks), takerPct: 0.20, feeSource: "assumed", regionOk: true });
    })(),
    (async () => {
      const j = await cached(`cb:${stable}`, () => getJson(`https://api.exchange.coinbase.com/products/${stable}-USD/book?level=2`));
      const d = j as { bids?: unknown[]; asks?: unknown[] } | null;
      if (d?.bids?.length && d?.asks?.length) out.push({ venue: "coinbase", venueName: "Coinbase", bids: lv(d.bids), asks: lv(d.asks), takerPct: 0.60, feeSource: "assumed", regionOk: true });
    })(),
    (async () => {
      const j = await cached(`bus:${stable}`, () => getJson(`https://api.binance.us/api/v3/depth?symbol=${stable}USD&limit=25`));
      const d = j as { bids?: unknown[]; asks?: unknown[] } | null;
      if (d?.bids?.length && d?.asks?.length) out.push({ venue: "binanceus", venueName: "Binance.US (region-unavailable)", bids: lv(d.bids), asks: lv(d.asks), takerPct: 0.60, feeSource: "assumed", regionOk: false });
    })(),
    (async () => {
      const j = await cached(`bs:${stable}`, () => getJson(`https://www.bitstamp.net/api/v2/order_book/${stable.toLowerCase()}usd/`));
      const d = j as { bids?: unknown[]; asks?: unknown[] } | null;
      if (d?.bids?.length && d?.asks?.length) out.push({ venue: "bitstamp", venueName: "Bitstamp", bids: lv(d.bids), asks: lv(d.asks), takerPct: 0.40, feeSource: "assumed", regionOk: true });
    })(),
    // Gemini stablecoin books — its STABLECOIN fee schedule (~0.03% taker,
    // ASSUMED; verify before funding) is dramatically below its spot tiers,
    // making it the most interesting PR-accessible candidate for stables.
    (async () => {
      if (stable !== "USDC") return; // Gemini lists USDC/USD; no USDT pair
      const j = await cached(`gem:${stable}`, () => getJson(`https://api.gemini.com/v1/book/usdcusd?limit_bids=25&limit_asks=25`));
      const d = j as { bids?: Array<{ price: string; amount: string }>; asks?: Array<{ price: string; amount: string }> } | null;
      const cv = (rows: Array<{ price: string; amount: string }> | undefined) => (rows ?? []).map(r => [parseFloat(r.price), parseFloat(r.amount)] as Level).filter(([p2, q]) => p2 > 0 && q > 0);
      const bids = cv(d?.bids), asks = cv(d?.asks);
      if (bids.length && asks.length) out.push({ venue: "gemini", venueName: "Gemini (stablecoin schedule)", bids, asks, takerPct: 0.03, feeSource: "assumed", regionOk: true });
    })(),
    // Crypto.com Exchange — PR-accessible candidate; published entry-tier
    // taker assumption until an account is connected.
    (async () => {
      const j = await cached(`cro:${stable}`, () => getJson(`https://api.crypto.com/exchange/v1/public/get-book?instrument_name=${stable}_USD&depth=25`));
      const d = (j as { result?: { data?: Array<{ bids?: unknown[]; asks?: unknown[] }> } } | null)?.result?.data?.[0];
      if (d?.bids?.length && d?.asks?.length) out.push({ venue: "cryptocom", venueName: "Crypto.com", bids: lv(d.bids), asks: lv(d.asks), takerPct: 0.50, feeSource: "assumed", regionOk: true });
    })(),
  ];
  await Promise.all(jobs);
  return out;
}

/** Spot-vs-perp funding snapshot. Read-only, informational. */
export type PerpBasis = {
  venue: string; asset: string;
  fundingRate8hPct: number;      // current 8h funding rate, percent
  perpMid: number; spotMid: number;
  basisPct: number;              // (perpMid − spotMid) / spotMid × 100
  /** Which side EARNS funding right now (positive funding → shorts earn). */
  carrySide: "short-perp/long-spot" | "long-perp/short-spot";
};

export async function fetchPerpBasis(assets: readonly string[]): Promise<PerpBasis[]> {
  const out: PerpBasis[] = [];
  await Promise.all(assets.map(async (asset) => {
    // OKX: funding + perp book + spot book (all public, USDT-quoted).
    const [fr, pb, sb] = await Promise.all([
      cached(`okx:fr:${asset}`, () => getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${asset}-USDT-SWAP`)),
      cached(`okx:pb:${asset}`, () => getJson(`https://www.okx.com/api/v5/market/books?instId=${asset}-USDT-SWAP&sz=5`)),
      cached(`okx:sb:${asset}`, () => getJson(`https://www.okx.com/api/v5/market/books?instId=${asset}-USDT&sz=5`)),
    ]);
    const rate = parseFloat((fr as { data?: Array<{ fundingRate?: string }> } | null)?.data?.[0]?.fundingRate ?? "");
    const pd = (pb as { data?: Array<{ bids?: unknown[]; asks?: unknown[] }> } | null)?.data?.[0];
    const sd = (sb as { data?: Array<{ bids?: unknown[]; asks?: unknown[] }> } | null)?.data?.[0];
    const pBid = parseFloat(String((pd?.bids?.[0] as unknown[] | undefined)?.[0] ?? "")), pAsk = parseFloat(String((pd?.asks?.[0] as unknown[] | undefined)?.[0] ?? ""));
    const sBid = parseFloat(String((sd?.bids?.[0] as unknown[] | undefined)?.[0] ?? "")), sAsk = parseFloat(String((sd?.asks?.[0] as unknown[] | undefined)?.[0] ?? ""));
    if (!Number.isFinite(rate) || !(pBid > 0) || !(pAsk > 0) || !(sBid > 0) || !(sAsk > 0)) return;
    const perpMid = (pBid + pAsk) / 2, spotMid = (sBid + sAsk) / 2;
    out.push({
      venue: "OKX", asset,
      fundingRate8hPct: rate * 100,
      perpMid, spotMid,
      basisPct: ((perpMid - spotMid) / spotMid) * 100,
      carrySide: rate >= 0 ? "short-perp/long-spot" : "long-perp/short-spot",
    });
    // Gate.io funding (mark/spot from its contract endpoint) — second sample.
    const g = await cached(`gate:fr:${asset}`, () => getJson(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${asset}_USDT`));
    const gRate = parseFloat((g as { funding_rate?: string } | null)?.funding_rate ?? "");
    const gMark = parseFloat((g as { mark_price?: string } | null)?.mark_price ?? "");
    if (Number.isFinite(gRate) && gMark > 0) {
      out.push({
        venue: "Gate.io", asset,
        fundingRate8hPct: gRate * 100,
        perpMid: gMark, spotMid,
        basisPct: ((gMark - spotMid) / spotMid) * 100,
        carrySide: gRate >= 0 ? "short-perp/long-spot" : "long-perp/short-spot",
      });
    }
  }));
  return out;
}
