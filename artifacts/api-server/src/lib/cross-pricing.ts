/**
 * cross-pricing.ts — executor-grade pricing for 2-leg Kraken↔Coinbase
 * inventory-arbitrage routes (buy asset on the cheaper venue, sell existing
 * inventory on the dearer venue; no transfer during execution).
 *
 * Same standard as the Kraken triangle simulator:
 *  - LIVE timestamped in-memory books on BOTH venues (Kraken WS book channel,
 *    Coinbase level2_batch) — no REST in the pricing path.
 *  - Depth-walked VWAP fills, per-venue taker fees on notional, slippage vs
 *    top-of-book, per-leg ages (oldest leg = route age), and a snapshot
 *    identity (marketUpdateMs) so scanner and pre-fire numbers can be compared
 *    on the SAME books (consistency gate).
 */

import { getStreamBook, getCoinbaseStreamBook } from "./book-stream";
import { OB_USD_PAIRS, bookSnapshot, type ObAsset, type LegAge } from "./order-book";
import { getCoinbaseOrderBook, PAIRS, type Pair } from "./exchange";

type Level = [number, number];

export interface CrossLegDiag { venue: "kraken" | "coinbase"; pair: string; side: "buy" | "sell"; topPx: number; vwapPx: number; feePct: number; }

export interface CrossBreakdown {
  /** Executable net after both venues' taker fees and depth-walked slippage. */
  netProfitUsd: number;
  rawEdgeUsd: number;
  feesUsd: number;
  slippageUsd: number;
  /** Base units bought on the cheap venue (== units sold from inventory). */
  baseQty: number;
  legDiag: CrossLegDiag[];
  legAges: LegAge[];
  /** Oldest leg age — the route age for the freshness gate. */
  quoteAgeMs: number;
  /** Snapshot identity: newest updatedAtMs across both legs. Two computations
   *  with equal identity priced the same books. */
  marketUpdateMs: number;
}

/** VWAP-buy `usd` notional from asks. Returns null when depth can't absorb it. */
function walkBuy(asks: Level[], usd: number): { qty: number; vwap: number; top: number } | null {
  let remaining = usd, qty = 0;
  const top = asks[0]?.[0] ?? 0;
  if (top <= 0) return null;
  for (const [px, vol] of asks) {
    const lvlUsd = px * vol;
    const take = Math.min(remaining, lvlUsd);
    qty += take / px;
    remaining -= take;
    if (remaining <= 1e-9) return { qty, vwap: usd / qty, top };
  }
  return null; // book exhausted — drop the route, never misprice it
}

/** VWAP-sell `qty` base units into bids. Returns null when depth can't absorb it. */
function walkSell(bids: Level[], qty: number): { usd: number; vwap: number; top: number } | null {
  let remaining = qty, usd = 0;
  const top = bids[0]?.[0] ?? 0;
  if (top <= 0) return null;
  for (const [px, vol] of bids) {
    const take = Math.min(remaining, vol);
    usd += take * px;
    remaining -= take;
    if (remaining <= 1e-12) return { usd, vwap: usd / qty, top };
  }
  return null;
}

/**
 * Price a cross-exchange inventory route from live books on both venues.
 * Returns null when either stream book is unavailable (caller keeps the graph
 * estimate but MUST mark it as such — an estimate is never executable).
 */
export function crossTakerBreakdown(
  asset: ObAsset,
  buyVenue: "kraken" | "coinbase",
  sizeUsd: number,
  krakenFeePct: number,
  coinbaseFeePct: number,
): CrossBreakdown | null {
  const kBook = getStreamBook(OB_USD_PAIRS[asset]);
  const cBook = getCoinbaseStreamBook(`${asset}-USD`);
  if (!kBook || !cBook) return null;
  return breakdownFromBooks(asset, buyVenue, sizeUsd, krakenFeePct, coinbaseFeePct, kBook, cBook);
}

/**
 * REST-fallback variant for the execution pre-fire: when the live stream
 * books are unavailable or stale, re-price BOTH legs from cache-bypassed
 * REST level-2 books at the ACTUAL trade size — the same depth-walked VWAP
 * and drop-if-too-thin rules as the stream path (Coinbase leg uses the same
 * level-2 endpoint the graph scan prices from). Returns null when either
 * book can't be fetched or can't absorb the size — the caller must ABORT,
 * never fall back to top-of-book.
 */
export async function crossTakerBreakdownRest(
  asset: ObAsset,
  buyVenue: "kraken" | "coinbase",
  sizeUsd: number,
  krakenFeePct: number,
  coinbaseFeePct: number,
  krakenStreamMaxAgeMs: number,
): Promise<CrossBreakdown | null> {
  const pair = `${asset}/USD`;
  if (!(PAIRS as readonly string[]).includes(pair)) return null; // no Coinbase product mapping — refuse
  const fetchedAt = Date.now();
  const [kSnap, cbBook] = await Promise.all([
    bookSnapshot(OB_USD_PAIRS[asset], krakenStreamMaxAgeMs, true).catch(() => null),
    getCoinbaseOrderBook(pair as Pair).catch(() => null),
  ]);
  if (!kSnap || !cbBook) return null;
  const now = Date.now();
  return breakdownFromBooks(asset, buyVenue, sizeUsd, krakenFeePct, coinbaseFeePct,
    { asks: kSnap.book.asks as Level[], bids: kSnap.book.bids as Level[], ageMs: kSnap.ageMs, updatedAtMs: kSnap.updatedAtMs },
    { asks: cbBook.asks, bids: cbBook.bids, ageMs: now - fetchedAt, updatedAtMs: fetchedAt });
}

interface VenueBook { asks: Level[]; bids: Level[]; ageMs: number; updatedAtMs: number; }

/** Shared depth-walked breakdown over one Kraken book and one Coinbase book. */
function breakdownFromBooks(
  asset: ObAsset,
  buyVenue: "kraken" | "coinbase",
  sizeUsd: number,
  krakenFeePct: number,
  coinbaseFeePct: number,
  kBook: VenueBook,
  cBook: VenueBook,
): CrossBreakdown | null {
  const kPair = OB_USD_PAIRS[asset];
  const cbProduct = `${asset}-USD`;
  const sellVenue = buyVenue === "kraken" ? "coinbase" as const : "kraken" as const;
  const buyBook  = buyVenue === "kraken" ? kBook : cBook;
  const sellBook = buyVenue === "kraken" ? cBook : kBook;
  const buyFeePct  = buyVenue === "kraken" ? krakenFeePct : coinbaseFeePct;
  const sellFeePct = sellVenue === "kraken" ? krakenFeePct : coinbaseFeePct;

  const buy = walkBuy(buyBook.asks, sizeUsd);
  if (!buy) return null;
  const sell = walkSell(sellBook.bids, buy.qty);
  if (!sell) return null;

  const buyFeeUsd  = sizeUsd * (buyFeePct / 100);
  const sellFeeUsd = sell.usd * (sellFeePct / 100);
  const feesUsd = buyFeeUsd + sellFeeUsd;
  // Raw edge at top-of-book; slippage = depth cost vs the tops.
  const rawEdgeUsd = buy.top > 0 ? (sell.top - buy.top) * (sizeUsd / buy.top) : 0;
  const netProfitUsd = sell.usd - sizeUsd - feesUsd;
  const slippageUsd = Math.max(0, rawEdgeUsd - (sell.usd - sizeUsd));

  const buyPairName  = buyVenue === "kraken" ? kPair : cbProduct;
  const sellPairName = sellVenue === "kraken" ? kPair : cbProduct;
  const legAges: LegAge[] = [
    { pair: `${buyPairName}[${buyVenue === "kraken" ? "K" : "C"}]`, ageMs: buyBook.ageMs, recvAgeMs: Math.max(0, Date.now() - buyBook.updatedAtMs) },
    { pair: `${sellPairName}[${sellVenue === "kraken" ? "K" : "C"}]`, ageMs: sellBook.ageMs, recvAgeMs: Math.max(0, Date.now() - sellBook.updatedAtMs) },
  ];
  return {
    netProfitUsd, rawEdgeUsd, feesUsd, slippageUsd, baseQty: buy.qty,
    legDiag: [
      { venue: buyVenue, pair: buyPairName, side: "buy", topPx: buy.top, vwapPx: buy.vwap, feePct: buyFeePct },
      { venue: sellVenue, pair: sellPairName, side: "sell", topPx: sell.top, vwapPx: sell.vwap, feePct: sellFeePct },
    ],
    legAges,
    quoteAgeMs: Math.max(kBook.ageMs, cBook.ageMs),
    marketUpdateMs: Math.max(buyBook.updatedAtMs, sellBook.updatedAtMs),
  };
}
