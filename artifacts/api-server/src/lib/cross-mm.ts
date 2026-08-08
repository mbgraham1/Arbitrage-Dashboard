/**
 * cross-mm.ts — maker-post + taker-hedge cross-exchange strategy math.
 *
 * Structure: rest a POST-ONLY limit order on Kraken (maker fee, EARNS the
 * spread) and, ONLY after a confirmed fill, hedge the exact filled quantity
 * at market on Coinbase against pre-positioned inventory. No fill → nothing
 * spent. This flips the economics of the all-taker cross structure: instead
 * of needing a ~50bp inter-venue dislocation, it needs someone to cross our
 * resting quote while the other venue holds still for ~100ms.
 *
 * This module is pure projection math on live stream books — order placement,
 * locks, and ledgering live in routes/arb.ts. Same executor-grade standard as
 * cross-pricing.ts: live timestamped books both venues, depth-walked hedge,
 * per-leg ages, snapshot identity.
 */

import { getStreamBook, getCoinbaseStreamBook, getGeminiStreamBook, type StreamBook } from "./book-stream";
import { OB_USD_PAIRS, type ObAsset, type LegAge } from "./order-book";

type Level = [number, number];

export type MmDirection = "buy" | "sell"; // side of the KRAKEN maker order

export interface MmProjection {
  direction: MmDirection;
  /** Post-only limit price on Kraken: joins the current best bid (buy) /
   *  best ask (sell) — never crosses, post-only enforces that on-exchange. */
  makerPrice: number;
  /** Base units the maker order is sized for (≈ sizeUsd / makerPrice). */
  makerQty: number;
  /** Projected P&L if the maker order fills fully at makerPrice and the hedge
   *  executes against the CURRENT Coinbase depth: fees on both legs, hedge
   *  depth-walked (VWAP). */
  projectedNetUsd: number;
  makerFeeUsd: number;
  hedgeFeeUsd: number;
  /** Depth-walked VWAP price of the Coinbase hedge for makerQty. */
  hedgeVwapPx: number;
  hedgeTopPx: number;
  hedgeSlippageUsd: number;
  legAges: LegAge[];
  /** Oldest leg age — the projection's freshness. */
  quoteAgeMs: number;
  marketUpdateMs: number;
}

function walkSellIntoBids(bids: Level[], qty: number): { usd: number; top: number } | null {
  let remaining = qty, usd = 0;
  const top = bids[0]?.[0] ?? 0;
  if (top <= 0) return null;
  for (const [px, vol] of bids) {
    const take = Math.min(remaining, vol);
    usd += take * px;
    remaining -= take;
    if (remaining <= 1e-12) return { usd, top };
  }
  return null; // depth exhausted — never misprice
}

function walkBuyQtyFromAsks(asks: Level[], qty: number): { usd: number; top: number } | null {
  let remaining = qty, usd = 0;
  const top = asks[0]?.[0] ?? 0;
  if (top <= 0) return null;
  for (const [px, vol] of asks) {
    const take = Math.min(remaining, vol);
    usd += take * px;
    remaining -= take;
    if (remaining <= 1e-12) return { usd, top };
  }
  return null;
}

/**
 * Project the maker-post/taker-hedge cycle for one direction from live books.
 * Returns null when either stream book is missing or hedge depth is
 * insufficient. The SAME function is used at placement time and continuously
 * while the order rests (cancel-on-move gate), with `makerPriceOverride` and
 * `qtyOverride` pinning the projection to the ACTUAL resting order.
 */
export function projectMakerHedge(
  asset: ObAsset,
  direction: MmDirection,
  sizeUsd: number,
  krakenMakerFeePct: number,
  coinbaseTakerFeePct: number,
  makerPriceOverride?: number,
  qtyOverride?: number,
): MmProjection | null {
  const kBook = getStreamBook(OB_USD_PAIRS[asset]);
  const cBook = getCoinbaseStreamBook(`${asset}-USD`);
  if (!kBook || !cBook) return null;

  const kTopBid = kBook.bids[0]?.[0] ?? 0;
  const kTopAsk = kBook.asks[0]?.[0] ?? 0;
  if (kTopBid <= 0 || kTopAsk <= 0) return null;

  // Join the top of the Kraken book on our side (post-only guarantees we
  // never cross even if the book moves between projection and placement).
  const makerPrice = makerPriceOverride ?? (direction === "buy" ? kTopBid : kTopAsk);
  if (!(makerPrice > 0)) return null;
  const makerQty = qtyOverride ?? sizeUsd / makerPrice;
  const makerNotional = makerQty * makerPrice;
  const makerFeeUsd = makerNotional * (krakenMakerFeePct / 100);

  let projectedNetUsd: number, hedgeVwapPx: number, hedgeTopPx: number, hedgeFeeUsd: number, hedgeSlippageUsd: number;
  if (direction === "buy") {
    // Maker BUY on Kraken → hedge = SELL makerQty into Coinbase bids.
    const h = walkSellIntoBids(cBook.bids, makerQty);
    if (!h) return null;
    hedgeVwapPx = h.usd / makerQty; hedgeTopPx = h.top;
    hedgeFeeUsd = h.usd * (coinbaseTakerFeePct / 100);
    hedgeSlippageUsd = Math.max(0, h.top * makerQty - h.usd);
    projectedNetUsd = h.usd - makerNotional - makerFeeUsd - hedgeFeeUsd;
  } else {
    // Maker SELL on Kraken → hedge = BUY makerQty back from Coinbase asks.
    const h = walkBuyQtyFromAsks(cBook.asks, makerQty);
    if (!h) return null;
    hedgeVwapPx = h.usd / makerQty; hedgeTopPx = h.top;
    hedgeFeeUsd = h.usd * (coinbaseTakerFeePct / 100);
    hedgeSlippageUsd = Math.max(0, h.usd - h.top * makerQty);
    projectedNetUsd = makerNotional - h.usd - makerFeeUsd - hedgeFeeUsd;
  }

  const legAges: LegAge[] = [
    { pair: `${OB_USD_PAIRS[asset]}[K·maker]`, ageMs: kBook.ageMs, recvAgeMs: Math.max(0, Date.now() - kBook.updatedAtMs) },
    { pair: `${asset}-USD[C·hedge]`, ageMs: cBook.ageMs, recvAgeMs: Math.max(0, Date.now() - cBook.updatedAtMs) },
  ];
  return {
    direction, makerPrice, makerQty, projectedNetUsd, makerFeeUsd, hedgeFeeUsd,
    hedgeVwapPx, hedgeTopPx, hedgeSlippageUsd, legAges,
    quoteAgeMs: Math.max(kBook.ageMs, cBook.ageMs),
    marketUpdateMs: Math.max(kBook.updatedAtMs, cBook.updatedAtMs),
  };
}

/** Best passing direction (highest projected net) or null when neither books. */
export function bestMakerHedgeProjection(
  asset: ObAsset,
  sizeUsd: number,
  krakenMakerFeePct: number,
  coinbaseTakerFeePct: number,
): MmProjection | null {
  const buy = projectMakerHedge(asset, "buy", sizeUsd, krakenMakerFeePct, coinbaseTakerFeePct);
  const sell = projectMakerHedge(asset, "sell", sizeUsd, krakenMakerFeePct, coinbaseTakerFeePct);
  if (!buy) return sell;
  if (!sell) return buy;
  return buy.projectedNetUsd >= sell.projectedNetUsd ? buy : sell;
}

// ── Venue-agnostic maker→hedge projection (kraken/coinbase/gemini) ───────────
export type MmVenue = "kraken" | "coinbase" | "gemini";

/** Live stream book for a venue+asset (null when absent/empty). Kraken uses its
 *  REST pair key; Coinbase uses "ASSET-USD"; Gemini uses "ASSETUSD" (age is
 *  local-arrival based — Gemini l2 carries no exchange timestamp). */
function mmBookFor(venue: MmVenue, asset: ObAsset): (StreamBook & { ageMs: number }) | null {
  if (venue === "kraken") return getStreamBook(OB_USD_PAIRS[asset]);
  if (venue === "coinbase") return getCoinbaseStreamBook(`${asset}-USD`);
  return getGeminiStreamBook(`${asset}USD`);
}
function mmLegTag(venue: MmVenue, asset: ObAsset): string {
  if (venue === "kraken") return OB_USD_PAIRS[asset];
  if (venue === "coinbase") return `${asset}-USD`;
  return `${asset}USD`;
}

/**
 * Generalized maker-post / taker-hedge projection for ANY ordered pair of
 * venues among kraken/coinbase/gemini. Mirrors projectCbMakerHedge's economics
 * exactly (maker joins the top of its own book — post-only never crosses; hedge
 * is depth-walked on the other venue for the SAME qty). Returns null when a
 * book is missing or hedge depth is insufficient. `makerPriceOverride`/
 * `qtyOverride` pin the projection to an ACTUAL resting order (cancel-on-move
 * gate + confirmed-fill hedge sizing). `direction` = the side of the MAKER order.
 */
export function projectVenueMakerHedge(
  asset: ObAsset,
  makerVenue: MmVenue,
  hedgeVenue: MmVenue,
  direction: MmDirection,
  sizeUsd: number,
  makerFeePct: number,
  hedgeTakerFeePct: number,
  makerPriceOverride?: number,
  qtyOverride?: number,
): MmProjection | null {
  if (makerVenue === hedgeVenue) return null;
  const mBook = mmBookFor(makerVenue, asset);
  const hBook = mmBookFor(hedgeVenue, asset);
  if (!mBook || !hBook) return null;

  const mTopBid = mBook.bids[0]?.[0] ?? 0;
  const mTopAsk = mBook.asks[0]?.[0] ?? 0;
  if (mTopBid <= 0 || mTopAsk <= 0) return null;

  const makerPrice = makerPriceOverride ?? (direction === "buy" ? mTopBid : mTopAsk);
  if (!(makerPrice > 0)) return null;
  const makerQty = qtyOverride ?? sizeUsd / makerPrice;
  if (!(makerQty > 0)) return null;
  const makerNotional = makerQty * makerPrice;
  const makerFeeUsd = makerNotional * (makerFeePct / 100);

  let projectedNetUsd: number, hedgeVwapPx: number, hedgeTopPx: number, hedgeFeeUsd: number, hedgeSlippageUsd: number;
  if (direction === "buy") {
    // Maker BUY → hedge = SELL makerQty into the hedge venue's bids.
    const h = walkSellIntoBids(hBook.bids, makerQty);
    if (!h) return null;
    hedgeVwapPx = h.usd / makerQty; hedgeTopPx = h.top;
    hedgeFeeUsd = h.usd * (hedgeTakerFeePct / 100);
    hedgeSlippageUsd = Math.max(0, h.top * makerQty - h.usd);
    projectedNetUsd = h.usd - makerNotional - makerFeeUsd - hedgeFeeUsd;
  } else {
    // Maker SELL → hedge = BUY makerQty back from the hedge venue's asks.
    const h = walkBuyQtyFromAsks(hBook.asks, makerQty);
    if (!h) return null;
    hedgeVwapPx = h.usd / makerQty; hedgeTopPx = h.top;
    hedgeFeeUsd = h.usd * (hedgeTakerFeePct / 100);
    hedgeSlippageUsd = Math.max(0, h.usd - h.top * makerQty);
    projectedNetUsd = makerNotional - h.usd - makerFeeUsd - hedgeFeeUsd;
  }

  const legAges: LegAge[] = [
    { pair: `${mmLegTag(makerVenue, asset)}[${makerVenue}·maker]`, ageMs: mBook.ageMs, recvAgeMs: Math.max(0, Date.now() - mBook.updatedAtMs) },
    { pair: `${mmLegTag(hedgeVenue, asset)}[${hedgeVenue}·hedge]`, ageMs: hBook.ageMs, recvAgeMs: Math.max(0, Date.now() - hBook.updatedAtMs) },
  ];
  return {
    direction, makerPrice, makerQty, projectedNetUsd, makerFeeUsd, hedgeFeeUsd,
    hedgeVwapPx, hedgeTopPx, hedgeSlippageUsd, legAges,
    quoteAgeMs: Math.max(mBook.ageMs, hBook.ageMs),
    marketUpdateMs: Math.max(mBook.updatedAtMs, hBook.updatedAtMs),
  };
}

/**
 * INVERTED structure: post-only maker on COINBASE (maker fee, earns spread),
 * taker hedge on KRAKEN after a confirmed fill. Kraken taker (0.40%) is far
 * cheaper than Coinbase taker (1.20% at intro tier), so this halves the
 * hedge-side cost versus the original Kraken-maker/Coinbase-hedge shape.
 * `direction` is the side of the COINBASE maker order.
 */
export function projectCbMakerHedge(
  asset: ObAsset,
  direction: MmDirection,
  sizeUsd: number,
  coinbaseMakerFeePct: number,
  krakenTakerFeePct: number,
  makerPriceOverride?: number,
  qtyOverride?: number,
): MmProjection | null {
  const kBook = getStreamBook(OB_USD_PAIRS[asset]);
  const cBook = getCoinbaseStreamBook(`${asset}-USD`);
  if (!kBook || !cBook) return null;

  const cTopBid = cBook.bids[0]?.[0] ?? 0;
  const cTopAsk = cBook.asks[0]?.[0] ?? 0;
  if (cTopBid <= 0 || cTopAsk <= 0) return null;

  // Join the top of the COINBASE book on our side; post-only guarantees we
  // never cross even if the book moves between projection and placement.
  const makerPrice = makerPriceOverride ?? (direction === "buy" ? cTopBid : cTopAsk);
  if (!(makerPrice > 0)) return null;
  const makerQty = qtyOverride ?? sizeUsd / makerPrice;
  const makerNotional = makerQty * makerPrice;
  const makerFeeUsd = makerNotional * (coinbaseMakerFeePct / 100);

  let projectedNetUsd: number, hedgeVwapPx: number, hedgeTopPx: number, hedgeFeeUsd: number, hedgeSlippageUsd: number;
  if (direction === "buy") {
    // Maker BUY on Coinbase → hedge = SELL makerQty into Kraken bids.
    const h = walkSellIntoBids(kBook.bids, makerQty);
    if (!h) return null;
    hedgeVwapPx = h.usd / makerQty; hedgeTopPx = h.top;
    hedgeFeeUsd = h.usd * (krakenTakerFeePct / 100);
    hedgeSlippageUsd = Math.max(0, h.top * makerQty - h.usd);
    projectedNetUsd = h.usd - makerNotional - makerFeeUsd - hedgeFeeUsd;
  } else {
    // Maker SELL on Coinbase → hedge = BUY makerQty back from Kraken asks.
    const h = walkBuyQtyFromAsks(kBook.asks, makerQty);
    if (!h) return null;
    hedgeVwapPx = h.usd / makerQty; hedgeTopPx = h.top;
    hedgeFeeUsd = h.usd * (krakenTakerFeePct / 100);
    hedgeSlippageUsd = Math.max(0, h.usd - h.top * makerQty);
    projectedNetUsd = makerNotional - h.usd - makerFeeUsd - hedgeFeeUsd;
  }

  const legAges: LegAge[] = [
    { pair: `${asset}-USD[C·maker]`, ageMs: cBook.ageMs, recvAgeMs: Math.max(0, Date.now() - cBook.updatedAtMs) },
    { pair: `${OB_USD_PAIRS[asset]}[K·hedge]`, ageMs: kBook.ageMs, recvAgeMs: Math.max(0, Date.now() - kBook.updatedAtMs) },
  ];
  return {
    direction, makerPrice, makerQty, projectedNetUsd, makerFeeUsd, hedgeFeeUsd,
    hedgeVwapPx, hedgeTopPx, hedgeSlippageUsd, legAges,
    quoteAgeMs: Math.max(kBook.ageMs, cBook.ageMs),
    marketUpdateMs: Math.max(kBook.updatedAtMs, cBook.updatedAtMs),
  };
}

// ── Taker-taker cross projection (evaluation-grade, same book standard) ─────
export interface TakerProjection {
  /** Venue we BUY on ("kraken" | "coinbase"); sell on the other. */
  buyVenue: "kraken" | "coinbase";
  qty: number;
  buyVwapPx: number; sellVwapPx: number;
  buyTopPx: number; sellTopPx: number;
  /** Top-of-book edge before any costs: (sellTop − buyTop) × qty. */
  grossEdgeUsd: number;
  buyFeeUsd: number; sellFeeUsd: number;
  slippageUsd: number;
  projectedNetUsd: number;
  legAges: LegAge[];
  quoteAgeMs: number;
}

/**
 * Project a $-sized taker-taker cross: buy qty at the buy venue's ask depth,
 * sell the same qty into the other venue's bid depth, taker fees both legs,
 * depth-walked VWAPs. Returns null when books are missing or depth is
 * insufficient (never misprices).
 */
export function projectTakerTaker(
  asset: ObAsset,
  buyVenue: "kraken" | "coinbase",
  sizeUsd: number,
  buyTakerFeePct: number,
  sellTakerFeePct: number,
): TakerProjection | null {
  const kBook = getStreamBook(OB_USD_PAIRS[asset]);
  const cBook = getCoinbaseStreamBook(`${asset}-USD`);
  if (!kBook || !cBook) return null;
  const buyBook = buyVenue === "kraken" ? kBook : cBook;
  const sellBook = buyVenue === "kraken" ? cBook : kBook;
  const buyTop = buyBook.asks[0]?.[0] ?? 0;
  const sellTop = sellBook.bids[0]?.[0] ?? 0;
  if (buyTop <= 0 || sellTop <= 0) return null;
  const qty = sizeUsd / buyTop;
  const b = walkBuyQtyFromAsks(buyBook.asks, qty);
  const s = walkSellIntoBids(sellBook.bids, qty);
  if (!b || !s) return null;
  const buyFeeUsd = b.usd * (buyTakerFeePct / 100);
  const sellFeeUsd = s.usd * (sellTakerFeePct / 100);
  const slippageUsd = Math.max(0, b.usd - buyTop * qty) + Math.max(0, sellTop * qty - s.usd);
  return {
    buyVenue, qty,
    buyVwapPx: b.usd / qty, sellVwapPx: s.usd / qty,
    buyTopPx: buyTop, sellTopPx: sellTop,
    grossEdgeUsd: (sellTop - buyTop) * qty,
    buyFeeUsd, sellFeeUsd, slippageUsd,
    projectedNetUsd: s.usd - b.usd - buyFeeUsd - sellFeeUsd,
    legAges: [
      { pair: `${OB_USD_PAIRS[asset]}[K]`, ageMs: kBook.ageMs, recvAgeMs: Math.max(0, Date.now() - kBook.updatedAtMs) },
      { pair: `${asset}-USD[C]`, ageMs: cBook.ageMs, recvAgeMs: Math.max(0, Date.now() - cBook.updatedAtMs) },
    ],
    quoteAgeMs: Math.max(kBook.ageMs, cBook.ageMs),
  };
}
