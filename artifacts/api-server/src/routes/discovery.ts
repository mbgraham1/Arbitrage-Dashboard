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
import { z } from "zod";
import { geminiVerify, type GeminiAccount } from "../lib/gemini";
import { VENUES, fetchAllVenueBooks, getVenueErrors, walkBuyUsd, walkSellQty, type VenueBook } from "../lib/venues";
import { getStreamBook, getCoinbaseStreamBook } from "../lib/book-stream";
import { OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
import { projectCbMakerHedge, projectMakerHedge, type MmDirection } from "../lib/cross-mm";
import { detectFees, fetchBalances, krakenCodesFor, type Fees, type Balances } from "./cb-maker-hedge";

const router: IRouter = Router();

const ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "LINK", "DOGE", "AVAX", "LTC",
  "ADA", "DOT", "UNI", "AAVE", "ATOM", "BCH", "FIL",
] as const satisfies readonly ObAsset[];
type Asset = typeof ASSETS[number];

const SIZES = [5, 10, 25, 50, 100, 250] as const; // sweep — optimal size is where net peaks (fees scale linearly, slippage doesn't)
const EXEC_SIZE = 10;                 // live validation cap — larger sizes are projections only
const SAFETY_BUFFER_USD_PER_10 = 0.02; // scaled linearly with size
const MAX_STREAM_AGE_MS = 5_000;      // live-venue stream books must be recent

type VenueLeg = {
  id: string; name: string; quote: "USD" | "USDT";
  takerPct: number; feeSource: "detected" | "assumed";
  basisHaircutPct: number;
  /** False = venue reported unavailable in the user's region (Puerto Rico) — context only, never actionable. */
  regionOk: boolean;
  /** True = PR-accessible candidate venue (Gemini, Crypto.com) worth a lower-fee account. */
  candidate: boolean;
  /** Published entry-tier maker fee assumption (for "would it flip attractive at entry maker tiers"). */
  assumedMakerPct: number;
  book: { bids: [number, number][]; asks: [number, number][] };
};

type SizeNet = { sizeUsd: number; grossEdgeUsd: number | null; feesUsd: number | null; slippageUsd: number | null; basisHaircutUsd: number | null; netUsd: number | null };
type BlockedBy = "NONE" | "NO_EDGE" | "BLOCKED_BY_FEES" | "INSUFFICIENT_INVENTORY" | "NEEDS_KEYS" | "NEEDS_ACCOUNT" | "REGION_UNAVAILABLE";
type DiscRow = {
  asset: Asset; buyVenue: string; sellVenue: string;
  structure: "taker-taker" | "cb-maker-hedge" | "kraken-maker-hedge";
  quoteNote: string;
  buyTakerPct: number; sellTakerPct: number; feeSource: string;
  nets: SizeNet[];
  net10: number | null;
  /** Size (from the sweep) where net peaks, and the net there. Live execution stays capped at $10. */
  bestSizeUsd: number | null; bestNetUsd: number | null;
  costsAtBest: { feesUsd: number; slippageUsd: number; basisHaircutUsd: number; bufferUsd: number } | null;
  category: "executable_now" | "requires_setup" | "not_profitable";
  blockedBy: BlockedBy;
  requirement: string;
  coinbaseFeeIsBlocker: boolean;
  /** True = a leg is on a venue unavailable in the user's region — market context only, never actionable. */
  regionUnavailable: boolean;
  /** For candidate venues (Gemini, Crypto.com): buffer-inclusive $10 net IF their legs paid entry-tier MAKER fees instead of taker. Assumption-based — shows whether the route would become attractive, never marks it executable. */
  entryTierMakerNet10: number | null;
  /** Gemini routes with keys connected: Gemini-side balance covers the $10 leg (read-only — still NOT executable from this app). */
  geminiFunded: boolean | null;
  seenPositiveScans: number;
};

function bestOfSweep(nets: SizeNet[]): { size: number | null; net: number | null; costs: DiscRow["costsAtBest"] } {
  let best: SizeNet | null = null;
  for (const n of nets) if (n.netUsd != null && (best == null || n.netUsd > (best.netUsd ?? -1e9))) best = n;
  if (!best || best.netUsd == null) return { size: null, net: null, costs: null };
  return {
    size: best.sizeUsd, net: best.netUsd,
    costs: { feesUsd: best.feesUsd ?? 0, slippageUsd: best.slippageUsd ?? 0, basisHaircutUsd: best.basisHaircutUsd ?? 0, bufferUsd: SAFETY_BUFFER_USD_PER_10 * (best.sizeUsd / 10) },
  };
}

function blockedByOf(net10: number | null, nets: SizeNet[], category: DiscRow["category"], liveOnly: boolean, hasFees: boolean): BlockedBy {
  if (category === "executable_now") return "NONE";
  const anyPositive = nets.some(n => (n.netUsd ?? -1) > 0);
  if (!anyPositive) {
    // negative everywhere — judge fees-vs-edge at the BEST (least negative) size.
    let n: SizeNet | null = null;
    for (const x of nets) if (x.netUsd != null && (n == null || x.netUsd > (n.netUsd ?? -1e9))) n = x;
    if (n && n.grossEdgeUsd != null && n.feesUsd != null && n.grossEdgeUsd > 0 && n.feesUsd > n.grossEdgeUsd) return "BLOCKED_BY_FEES";
    return "NO_EDGE";
  }
  if (liveOnly) return hasFees ? "INSUFFICIENT_INVENTORY" : "NEEDS_KEYS";
  return "NEEDS_ACCOUNT";
}

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
  // Optional Gemini keys — READ-ONLY: detected fee tier + balances for honest
  // candidate labeling. Gemini live trading is never enabled from here.
  const gc = z.object({ geminiKey: z.string().min(1), geminiSecret: z.string().min(1) }).safeParse(req.body ?? {});
  let gemini: GeminiAccount | null = null;
  let geminiNote: string | null = null;
  if (gc.success) {
    try { gemini = await geminiVerify(gc.data); }
    catch (e) { geminiNote = `Gemini keys provided but verification failed (${(e as Error).message.slice(0, 80)}) — falling back to labeled assumptions`; }
  }
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
      if (b) {
        const isGem = v.id === "gemini" && gemini != null;
        legs.push({
          id: v.id, name: v.name, quote: v.quote,
          takerPct: isGem ? gemini!.takerPct : v.assumedTakerPct,
          feeSource: isGem ? "detected" : "assumed",
          basisHaircutPct: v.basisHaircutPct, regionOk: v.regionOk, candidate: v.candidate,
          assumedMakerPct: isGem ? gemini!.makerPct : v.assumedMakerPct,
          book: b,
        });
      }
    }
    const kBook = getStreamBook(OB_USD_PAIRS[asset]);
    if (kBook && kBook.ageMs < MAX_STREAM_AGE_MS && kBook.bids.length && kBook.asks.length) {
      legs.push({ id: "kraken", name: "Kraken", quote: "USD", takerPct: fees ? fees.kTakerPct : 0.40, feeSource: fees ? "detected" : "assumed", basisHaircutPct: 0, regionOk: true, candidate: false, assumedMakerPct: 0.16, book: { bids: kBook.bids, asks: kBook.asks } });
    }
    const cBook = getCoinbaseStreamBook(`${asset}-USD`);
    if (cBook && cBook.ageMs < MAX_STREAM_AGE_MS && cBook.bids.length && cBook.asks.length) {
      legs.push({ id: "coinbase", name: "Coinbase", quote: "USD", takerPct: fees ? fees.cbTakerPct : 1.20, feeSource: fees ? "detected" : "assumed", basisHaircutPct: 0, regionOk: true, candidate: false, assumedMakerPct: 0.60, book: { bids: cBook.bids, asks: cBook.asks } });
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
      const net10 = nets.find(n => n.sizeUsd === EXEC_SIZE)?.netUsd ?? null;
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
      } else if (!buy.regionOk || !sell.regionOk) {
        // Route touches a venue the user's app reports as region-blocked
        // (Binance.US in Puerto Rico) — market context ONLY, never actionable.
        category = "not_profitable";
        requirement = `${[buy, sell].filter(l => !l.regionOk).map(l => l.name).join(" + ")} UNAVAILABLE in your region — shown as market context only`;
      } else {
        category = "requires_setup";
        const foreign = [buy, sell].filter(l => l.id !== "kraken" && l.id !== "coinbase");
        requirement = `needs a funded account on ${foreign.map(l => `${l.name} (${l.feeSource === "detected" ? `YOUR detected ${l.takerPct}% taker` : `assumed ${l.takerPct}% taker`}${l.quote === "USDT" ? ", USDT-quoted" : ""}${l.candidate ? ", PR-accessible candidate" : ""})`).join(" + ")} — ${foreign.every(l => l.id === "gemini") && gemini ? "Gemini keys connected (read-only) — still NOT executable from this app; execution stays Kraken/Coinbase only" : "public data only until API access is connected + verified; verify real fees/withdrawal costs before funding"}`;
      }

      // Is Coinbase's taker tier specifically what kills this route?
      let coinbaseFeeIsBlocker = false;
      if (net10 <= 0 && (buy.id === "coinbase" || sell.id === "coinbase") && fees) {
        const cbLegFee10 = (buy.id === "coinbase" ? EXEC_SIZE * (buy.takerPct / 100) : 0) + (sell.id === "coinbase" ? EXEC_SIZE * (sell.takerPct / 100) : 0);
        coinbaseFeeIsBlocker = net10 + cbLegFee10 - EXEC_SIZE * 0.001 > 0; // would flip positive at a 0.10% tier
      }

      // Candidate-venue upside: what would the $10 net be if candidate-venue
      // legs (Gemini / Crypto.com) paid their published ENTRY-TIER MAKER fee
      // instead of taker? Pure assumption analysis — never marks executable.
      const regionUnavailable = !buy.regionOk || !sell.regionOk;
      // Gemini-side funding check (read-only honesty label, never executability):
      // buying on Gemini needs USD there; selling on Gemini needs the asset there.
      let geminiFunded: boolean | null = null;
      if (gemini && (buy.id === "gemini" || sell.id === "gemini")) {
        const buyOk = buy.id !== "gemini" || gemini.usdBalance >= EXEC_SIZE * 1.02;
        const qty10g = EXEC_SIZE / (sell.book.bids[0]?.[0] ?? 1);
        const sellOk = sell.id !== "gemini" || (gemini.balances[asset] ?? 0) >= qty10g * 1.02;
        geminiFunded = buyOk && sellOk;
      }
      let entryTierMakerNet10: number | null = null;
      if (!regionUnavailable && (buy.candidate || sell.candidate)) {
        const mb = buy.candidate ? { ...buy, takerPct: buy.assumedMakerPct } : buy;
        const ms = sell.candidate ? { ...sell, takerPct: sell.assumedMakerPct } : sell;
        entryTierMakerNet10 = projectRoute(mb, ms, EXEC_SIZE).netUsd;
      }

      const sweep = bestOfSweep(nets);
      rows.push({
        asset, buyVenue: buy.name, sellVenue: sell.name,
        structure: "taker-taker",
        quoteNote: [buy, sell].some(l => l.quote === "USDT") ? "USDT-quoted leg(s) — basis haircut applied" : "USD",
        buyTakerPct: buy.takerPct, sellTakerPct: sell.takerPct,
        feeSource: buy.feeSource === "detected" && sell.feeSource === "detected" ? "detected" : buy.feeSource === "assumed" && sell.feeSource === "assumed" ? "assumed" : "mixed",
        nets, net10,
        bestSizeUsd: sweep.size, bestNetUsd: sweep.net, costsAtBest: sweep.costs,
        category, blockedBy: regionUnavailable ? "REGION_UNAVAILABLE" : blockedByOf(net10, nets, category, liveOnly, !!fees), requirement, coinbaseFeeIsBlocker,
        regionUnavailable, entryTierMakerNet10, geminiFunded,
        seenPositiveScans: streak,
      });
    }
  }

  // 2b. MAKER-HEDGE structures on the live venues — the lowest-fee routes we
  // can actually execute (maker fee on one leg instead of two taker fees).
  // Uses YOUR detected maker tiers when keys are connected; labeled entry-tier
  // assumptions otherwise (then never executable_now).
  const ASSUMED_CB_MAKER = 0.60, ASSUMED_K_MAKER = 0.16, ASSUMED_K_TAKER = 0.40, ASSUMED_CB_TAKER = 1.20;
  for (const asset of ASSETS) {
    for (const direction of ["buy", "sell"] as MmDirection[]) {
      const structures = [
        { st: "cb-maker-hedge" as const, makerVenue: "Coinbase (maker)", hedgeVenue: "Kraken (taker)", makerPct: fees ? fees.cbMakerPct : ASSUMED_CB_MAKER, hedgePct: fees ? fees.kTakerPct : ASSUMED_K_TAKER,
          proj: (sz: number, mk: number, hg: number) => projectCbMakerHedge(asset, direction, sz, mk, hg) },
        { st: "kraken-maker-hedge" as const, makerVenue: "Kraken (maker)", hedgeVenue: "Coinbase (taker)", makerPct: fees ? (fees.kMakerPct ?? ASSUMED_K_MAKER) : ASSUMED_K_MAKER, hedgePct: fees ? fees.cbTakerPct : ASSUMED_CB_TAKER,
          proj: (sz: number, mk: number, hg: number) => projectMakerHedge(asset, direction, sz, mk, hg) },
      ];
      for (const { st, makerVenue, hedgeVenue, makerPct, hedgePct, proj } of structures) {
        const nets: SizeNet[] = SIZES.map(sz => {
          const p = proj(sz, makerPct, hedgePct);
          const buffer = SAFETY_BUFFER_USD_PER_10 * (sz / 10);
          if (!p) return { sizeUsd: sz, grossEdgeUsd: null, feesUsd: null, slippageUsd: null, basisHaircutUsd: null, netUsd: null };
          return {
            sizeUsd: sz,
            grossEdgeUsd: p.projectedNetUsd + p.makerFeeUsd + p.hedgeFeeUsd + p.hedgeSlippageUsd,
            feesUsd: p.makerFeeUsd + p.hedgeFeeUsd,
            slippageUsd: p.hedgeSlippageUsd,
            basisHaircutUsd: 0,
            netUsd: p.projectedNetUsd - buffer,
          };
        });
        const net10 = nets.find(n => n.sizeUsd === 10)?.netUsd ?? null;
        if (net10 == null && nets.every(n => n.netUsd == null)) continue;
        const key = `${asset}:${st}:${direction}`;
        const streak = (net10 ?? -1) > 0 ? (positiveStreak.get(key) ?? 0) + 1 : 0;
        if (streak > 0) positiveStreak.set(key, streak); else positiveStreak.delete(key);

        // Inventory at the $10 live cap (maker side funds + hedge side inventory).
        let category: DiscRow["category"]; let requirement: string;
        if ((net10 ?? -1) <= 0) {
          category = "not_profitable";
          requirement = "none — fees + slippage exceed the edge";
        } else if (fees && bal) {
          const p10 = proj(EXEC_SIZE, makerPct, hedgePct);
          const qty = p10?.makerQty ?? 0;
          const kAsset = krakenCodesFor(asset).reduce((a2, code) => a2 + (bal!.kAssets.get(code) ?? 0), 0);
          const cbAsset = bal.cbAssets.get(asset) ?? 0;
          const cbIsMaker = st === "cb-maker-hedge";
          const usdOk = direction === "buy" ? (cbIsMaker ? bal.cbUsd : bal.kUsd) >= EXEC_SIZE * 1.02 : (cbIsMaker ? bal.kUsd : bal.cbUsd) >= EXEC_SIZE * 1.02;
          const assetOk = direction === "buy" ? (cbIsMaker ? kAsset : cbAsset) >= qty * 1.02 : (cbIsMaker ? cbAsset : kAsset) >= qty * 1.02;
          if (usdOk && assetOk) { category = "executable_now"; requirement = `ready — maker on ${makerVenue}, hedge on ${hedgeVenue}; execution stays $10-capped, post-only + confirmed-fill hedge`; }
          else { category = "requires_setup"; requirement = !usdOk ? `needs ~$${(EXEC_SIZE * 1.02).toFixed(2)} USD on the ${direction === "buy" ? (cbIsMaker ? "Coinbase" : "Kraken") : (cbIsMaker ? "Kraken" : "Coinbase")} side` : `needs ~${(qty * 1.02).toFixed(6)} ${asset} pre-positioned for the hedge`; }
        } else {
          category = "requires_setup";
          requirement = "connect Kraken + Coinbase API keys — maker tiers must be YOUR detected tiers before this can be executable";
        }
        const sweep = bestOfSweep(nets);
        rows.push({
          asset, buyVenue: makerVenue, sellVenue: hedgeVenue,
          structure: st,
          quoteNote: `USD · ${direction} side · maker-post + confirmed-fill hedge`,
          buyTakerPct: makerPct, sellTakerPct: hedgePct,
          feeSource: fees ? "detected" : "assumed",
          nets, net10,
          bestSizeUsd: sweep.size, bestNetUsd: sweep.net, costsAtBest: sweep.costs,
          category, blockedBy: blockedByOf(net10, nets, category, true, !!fees), requirement,
          coinbaseFeeIsBlocker: false,
          regionUnavailable: false, entryTierMakerNet10: null, geminiFunded: null,
          seenPositiveScans: streak,
        });
      }
    }
  }

  // 3. Rank: persistent, low-fee, high-net first.
  // Executable candidates are ranked by the buffer-inclusive $10 net — the
  // ONLY size live execution can use. Larger-size sweep results are research
  // projections and rank only the research lists.
  const rankExec = (a: DiscRow, b: DiscRow) =>
    (b.net10 ?? -1e9) - (a.net10 ?? -1e9) || b.seenPositiveScans - a.seenPositiveScans;
  const rank = (a: DiscRow, b: DiscRow) =>
    (b.bestNetUsd ?? -1e9) - (a.bestNetUsd ?? -1e9) || b.seenPositiveScans - a.seenPositiveScans;
  const executable = rows.filter(r => r.category === "executable_now").sort(rankExec).slice(0, 10);
  const setup = rows.filter(r => r.category === "requires_setup").sort(rank).slice(0, 15);
  const notProf = rows.filter(r => r.category === "not_profitable").sort(rank).slice(0, 10);
  // Dedicated candidate-venue section: the user's realistically-accessible
  // lower-fee venues (Gemini, Crypto.com) must stay visible even when other
  // public venues crowd the top-10 lists. Public-data-only until API access
  // is connected + verified — never executable from here.
  const candidateRoutes = rows
    .filter(r => !r.regionUnavailable && r.entryTierMakerNet10 != null)
    .sort((a, b) => (b.entryTierMakerNet10 ?? -1e9) - (a.entryTierMakerNet10 ?? -1e9) || (b.net10 ?? -1e9) - (a.net10 ?? -1e9))
    .slice(0, 8);

  const errors = getVenueErrors();

  // Verdicts: the single best executable route, and the best near-miss on the
  // live venues (closest to positive), with its exact shortfall and blocker.
  const bestExecutable = executable[0] ?? null;
  const liveRows = rows.filter(r => r.structure !== "taker-taker" || (["Kraken", "Coinbase"].includes(r.buyVenue) && ["Kraken", "Coinbase"].includes(r.sellVenue)));
  const nearMisses = liveRows.filter(r => r.category !== "executable_now" && r.net10 != null).sort(rankExec);
  const bestNearMiss = nearMisses[0] ?? null;

  res.json({
    at: new Date().toISOString(),
    bestExecutable,
    bestNearMiss,
    sizes: SIZES,
    executionCapUsd: EXEC_SIZE,
    feesNote: hasCreds && fees
      ? "Kraken/Coinbase fees are YOUR detected tiers; all other venues use published entry-tier ASSUMPTIONS."
      : "No keys connected — ALL fees are published entry-tier assumptions. Connect keys for real Kraken/Coinbase tiers.",
    credNote,
    gemini: gc.success ? {
      connected: gemini != null,
      makerPct: gemini?.makerPct ?? null,
      takerPct: gemini?.takerPct ?? null,
      usdBalance: gemini?.usdBalance ?? null,
      note: gemini
        ? "Gemini connected (read-only): detected fee tier + balance-verified candidate labels. Live Gemini trading is NOT enabled — execution stays Kraken/Coinbase, $10 cap."
        : geminiNote,
    } : null,
    venues: VENUES.map(v => ({
      id: v.id, name: v.name, quote: v.quote, assumedTakerPct: v.assumedTakerPct, assumedMakerPct: v.assumedMakerPct,
      regionOk: v.regionOk, candidate: v.candidate, accessNote: v.accessNote ?? null,
      status: !v.regionOk ? "region-unavailable (context only)" : errors[v.id] ? `error: ${errors[v.id]}` : "ok",
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
    candidateRoutes,
  });
});

export default router;
