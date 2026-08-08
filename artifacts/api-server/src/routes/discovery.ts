/**
 * DISCOVERY ENGINE — read-only cross-venue arbitrage opportunity scanner.
 *
 * Scans public order books on 8 major exchanges (no trading credentials
 * needed) alongside the live Kraken/Coinbase stream books, and projects the
 * executable net for every ordered venue pair × liquid asset at $10 / $50 /
 * $100 sizes. Costs subtracted per route: BOTH venues' taker fees (real
 * detected tiers when keys are connected; published entry-tier ASSUMPTIONS
 * elsewhere, clearly labeled), depth-walked slippage, a USDT/USD basis
 * haircut on USDT-quoted legs, and a safety buffer.
 *
 * Results are categorized honestly:
 *  - executable_now      → both legs on Kraken/Coinbase, keys connected,
 *                          positive net at $10 AND the inventory exists
 *  - requires_setup      → positive projected net, but needs an account or
 *                          pre-positioned inventory somewhere we can't trade
 *  - not_profitable      → negative net everywhere (shown for context)
 *
 * NEVER trades. Live execution stays exclusively with the hardened
 * Kraken/Coinbase executors and their $10 cap; the larger sizes here are
 * projections only.
 */
import { Router, type IRouter } from "express";
import { MmScanBody } from "@workspace/api-zod";
import { VENUES, fetchAllVenueBooks, getVenueErrors, walkBuyUsd, walkSellQty, type VenueBook } from "../lib/venues";
import { getStreamBook, getCoinbaseStreamBook } from "../lib/book-stream";
import { OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
import { detectFees, fetchBalances, krakenCodesFor, type Fees, type Balances } from "./cb-maker-hedge";

const router: IRouter = Router();

const ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "LINK", "DOGE", "AVAX", "LTC",
  "ADA", "DOT", "UNI", "AAVE", "ATOM", "BCH", "FIL",
] as const satisfies readonly ObAsset[];
type Asset = typeof ASSETS[number];

const SIZES = [10, 50, 100] as const;
const EXEC_SIZE = 10;                 // live validation cap — larger sizes are projections only
const SAFETY_BUFFER_USD_PER_10 = 0.02; // scaled linearly with size
const MAX_STREAM_AGE_MS = 5_000;      // live-venue stream books must be recent

type VenueLeg = {
  id: string; name: string; quote: "USD" | "USDT";
  takerPct: number; feeSource: "detected" | "assumed";
  basisHaircutPct: number;
  book: { bids: [number, number][]; asks: [number, number][] };
};

type SizeNet = { sizeUsd: number; grossEdgeUsd: number | null; feesUsd: number | null; slippageUsd: number | null; basisHaircutUsd: number | null; netUsd: number | null };
type DiscRow = {
  asset: Asset; buyVenue: string; sellVenue: string;
  quoteNote: string;
  buyTakerPct: number; sellTakerPct: number; feeSource: string;
  nets: SizeNet[];
  net10: number | null;
  category: "executable_now" | "requires_setup" | "not_profitable";
  requirement: string;
  coinbaseFeeIsBlocker: boolean;
  seenPositiveScans: number;
};

// Persistence tracking: consecutive scans a route stayed net-positive at $10.
const positiveStreak = new Map<string, number>();

function projectRoute(buy: VenueLeg, sell: VenueLeg, sizeUsd: number): SizeNet {
  const empty: SizeNet = { sizeUsd, grossEdgeUsd: null, feesUsd: null, slippageUsd: null, basisHaircutUsd: null, netUsd: null };
  const b = walkBuyUsd(buy.book.asks, sizeUsd);
  if (!b) return empty;
  const s = walkSellQty(sell.book.bids, b.qty);
  if (!s) return empty;
  const grossEdgeUsd = (s.top - b.top) * b.qty;
  const feesUsd = sizeUsd * (buy.takerPct / 100) + s.usd * (sell.takerPct / 100);
  const slippageUsd = Math.max(0, sizeUsd - b.top * b.qty) + Math.max(0, s.top * b.qty - s.usd);
  const basisHaircutUsd = sizeUsd * (buy.basisHaircutPct / 100) + s.usd * (sell.basisHaircutPct / 100);
  const buffer = SAFETY_BUFFER_USD_PER_10 * (sizeUsd / 10);
  const netUsd = s.usd - sizeUsd - feesUsd - basisHaircutUsd - buffer;
  return { sizeUsd, grossEdgeUsd, feesUsd, slippageUsd, basisHaircutUsd, netUsd };
}

router.post("/arb/discovery", async (req, res): Promise<void> => {
  // Credentials OPTIONAL — with them, Kraken/Coinbase get real fees +
  // balances and routes can be marked executable_now.
  const maybeCreds = MmScanBody.partial().safeParse(req.body ?? {});
  const c = maybeCreds.success ? maybeCreds.data : {};
  const hasCreds = !!(c.krakenKey && c.krakenSecret && c.coinbaseKey && c.coinbaseSecret);
  let fees: Fees | null = null, bal: Balances | null = null;
  let credNote: string | null = null;
  if (hasCreds) {
    try {
      fees = await detectFees(c as Parameters<typeof detectFees>[0]);
      bal = await fetchBalances(c as Parameters<typeof fetchBalances>[0]);
    } catch (e) {
      credNote = `keys provided but real fees/balances unavailable (${(e as Error).message.slice(0, 80)}) — falling back to labeled assumptions; nothing is executable_now`;
      fees = null; bal = null;
    }
  }

  // 1. Public venue snapshots (cached ~15s) + live-venue stream books.
  const books = await fetchAllVenueBooks(ASSETS);
  const legsByAsset = new Map<Asset, VenueLeg[]>();
  for (const asset of ASSETS) {
    const legs: VenueLeg[] = [];
    for (const v of VENUES) {
      const b = books.get(`${v.id}:${asset}`);
      if (b) legs.push({ id: v.id, name: v.name, quote: v.quote, takerPct: v.assumedTakerPct, feeSource: "assumed", basisHaircutPct: v.basisHaircutPct, book: b });
    }
    const kBook = getStreamBook(OB_USD_PAIRS[asset]);
    if (kBook && kBook.ageMs < MAX_STREAM_AGE_MS && kBook.bids.length && kBook.asks.length) {
      legs.push({ id: "kraken", name: "Kraken", quote: "USD", takerPct: fees ? fees.kTakerPct : 0.40, feeSource: fees ? "detected" : "assumed", basisHaircutPct: 0, book: { bids: kBook.bids, asks: kBook.asks } });
    }
    const cBook = getCoinbaseStreamBook(`${asset}-USD`);
    if (cBook && cBook.ageMs < MAX_STREAM_AGE_MS && cBook.bids.length && cBook.asks.length) {
      legs.push({ id: "coinbase", name: "Coinbase", quote: "USD", takerPct: fees ? fees.cbTakerPct : 1.20, feeSource: fees ? "detected" : "assumed", basisHaircutPct: 0, book: { bids: cBook.bids, asks: cBook.asks } });
    }
    legsByAsset.set(asset, legs);
  }

  // 2. Project every ordered venue pair per asset at all sizes.
  const rows: DiscRow[] = [];
  for (const asset of ASSETS) {
    const legs = legsByAsset.get(asset)!;
    for (const buy of legs) for (const sell of legs) {
      if (buy.id === sell.id) continue;
      const nets = SIZES.map(sz => projectRoute(buy, sell, sz));
      const net10 = nets[0].netUsd;
      if (net10 == null) continue;
      const key = `${asset}:${buy.id}>${sell.id}`;
      const streak = net10 > 0 ? (positiveStreak.get(key) ?? 0) + 1 : 0;
      if (streak > 0) positiveStreak.set(key, streak); else positiveStreak.delete(key);

      const liveOnly = (buy.id === "kraken" || buy.id === "coinbase") && (sell.id === "kraken" || sell.id === "coinbase");
      let category: DiscRow["category"];
      let requirement: string;
      if (net10 <= 0) {
        category = "not_profitable";
        requirement = "none — fees + slippage exceed the edge";
      } else if (liveOnly && fees && bal) {
        // executable_now needs the inventory TODAY: buy venue USD, sell venue asset.
        const buyUsdOk = buy.id === "kraken" ? bal.kUsd >= EXEC_SIZE * 1.02 : bal.cbUsd >= EXEC_SIZE * 1.02;
        const qty10 = EXEC_SIZE / (buy.book.asks[0]?.[0] ?? 1);
        const sellAssetBal = sell.id === "kraken"
          ? krakenCodesFor(asset).reduce((a2, code) => a2 + (bal!.kAssets.get(code) ?? 0), 0)
          : (bal.cbAssets.get(asset) ?? 0);
        const sellOk = sellAssetBal >= qty10 * 1.02;
        if (buyUsdOk && sellOk) {
          category = "executable_now";
          requirement = `ready: $${(EXEC_SIZE * 1.02).toFixed(2)} on ${buy.name} + ${(qty10 * 1.02).toFixed(6)} ${asset} on ${sell.name}`;
        } else {
          category = "requires_setup";
          requirement = !buyUsdOk
            ? `needs $${(EXEC_SIZE * 1.02).toFixed(2)} USD on ${buy.name}`
            : `needs ${(qty10 * 1.02).toFixed(6)} ${asset} pre-positioned on ${sell.name}`;
        }
      } else if (liveOnly) {
        category = "requires_setup";
        requirement = "connect Kraken + Coinbase API keys to verify fees and inventory";
      } else {
        category = "requires_setup";
        const foreign = [buy, sell].filter(l => l.id !== "kraken" && l.id !== "coinbase");
        requirement = `needs a funded account on ${foreign.map(l => `${l.name} (assumed ${l.takerPct}% taker${l.quote === "USDT" ? ", USDT-quoted" : ""})`).join(" + ")} — verify their real fees/withdrawal costs before funding`;
      }

      // Is Coinbase's taker tier specifically what kills this route?
      let coinbaseFeeIsBlocker = false;
      if (net10 <= 0 && (buy.id === "coinbase" || sell.id === "coinbase") && fees) {
        const cbLegFee10 = (buy.id === "coinbase" ? EXEC_SIZE * (buy.takerPct / 100) : 0) + (sell.id === "coinbase" ? EXEC_SIZE * (sell.takerPct / 100) : 0);
        coinbaseFeeIsBlocker = net10 + cbLegFee10 - EXEC_SIZE * 0.001 > 0; // would flip positive at a 0.10% tier
      }

      rows.push({
        asset, buyVenue: buy.name, sellVenue: sell.name,
        quoteNote: [buy, sell].some(l => l.quote === "USDT") ? "USDT-quoted leg(s) — basis haircut applied" : "USD",
        buyTakerPct: buy.takerPct, sellTakerPct: sell.takerPct,
        feeSource: buy.feeSource === "detected" && sell.feeSource === "detected" ? "detected" : buy.feeSource === "assumed" && sell.feeSource === "assumed" ? "assumed" : "mixed",
        nets, net10,
        category, requirement, coinbaseFeeIsBlocker,
        seenPositiveScans: streak,
      });
    }
  }

  // 3. Rank: persistent, low-fee, high-net first.
  const rank = (a: DiscRow, b: DiscRow) =>
    (b.net10 ?? -1e9) - (a.net10 ?? -1e9) || b.seenPositiveScans - a.seenPositiveScans;
  const executable = rows.filter(r => r.category === "executable_now").sort(rank).slice(0, 10);
  const setup = rows.filter(r => r.category === "requires_setup").sort(rank).slice(0, 15);
  const notProf = rows.filter(r => r.category === "not_profitable").sort(rank).slice(0, 10);
  const errors = getVenueErrors();

  res.json({
    at: new Date().toISOString(),
    sizes: SIZES,
    executionCapUsd: EXEC_SIZE,
    feesNote: hasCreds && fees
      ? "Kraken/Coinbase fees are YOUR detected tiers; all other venues use published entry-tier ASSUMPTIONS."
      : "No keys connected — ALL fees are published entry-tier assumptions. Connect keys for real Kraken/Coinbase tiers.",
    credNote,
    venues: VENUES.map(v => ({
      id: v.id, name: v.name, quote: v.quote, assumedTakerPct: v.assumedTakerPct,
      status: errors[v.id] ? `error: ${errors[v.id]}` : "ok",
      assetsCovered: ASSETS.filter(a => books.has(`${v.id}:${a}`)).length,
    })),
    coinbaseFeeDrag: rows.filter(r => r.coinbaseFeeIsBlocker).length,
    summary: executable.length > 0
      ? `${executable.length} route(s) executable RIGHT NOW with your balances.`
      : setup.length > 0
        ? `No route is executable with current keys/balances, but ${setup.length} route(s) project positive net elsewhere — see what each requires. Nothing will be forced.`
        : "No genuinely positive route found anywhere scanned right now — that is the honest answer, not a scanning failure.",
    executableNow: executable,
    requiresSetup: setup,
    notProfitable: notProf,
  });
});

export default router;
