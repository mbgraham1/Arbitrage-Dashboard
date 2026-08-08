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

import { getStreamBook, getCoinbaseStreamBook } from "./book-stream";
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
