import { Router, type IRouter } from "express";
import { desc, sql, sum, count, max, avg } from "drizzle-orm";
import { db, tradesTable, triScanTable, triScanRollupTable, executionQualityTable, accountSnapshotsTable, routeGateStateTable } from "@workspace/db";
import { desc as dbDesc, eq as dbEq, and as dbAnd, gte as dbGte, count as dbCount } from "drizzle-orm";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import {
  FetchPricesBody,
  FetchBalancesBody,
  TestKrakenBody,
  GetFeeTierBody,
  GetAccountPnlBody,
  TestCoinbaseBody,
  ExecuteTradeBody,
  ExecuteTriangularBody,
  ObExecuteBody,
  GraphExecuteBody,
  ExecPreviewBody,
  ListTradesQueryParams,
  ExecuteCrossMmBody,
} from "@workspace/api-zod";
import {
  getKrakenPrice,
  getKrakenBalances,
  krakenCancelAllOrders,
  bindLockHeartbeat,
  krakenPairMeta,
  armLatencyProbe,
  disarmLatencyProbe,
  krakenMarketOrder,
  krakenLimitOrder,
  krakenRawMarketOrder,
  krakenRawLimitOrder,
  krakenRawIocLimitOrder,
  krakenOrderFilled,
  krakenOrderInfo,
  krakenTakerFeePct,
  krakenFeeTiers,
  krakenFillPrice,
  krakenCancelOrder,
  krakenAccountValueUsd,
  krakenNetCashFlowUsd,
  coinbaseAccountValueUsd,
  getCoinbaseBalances,
  coinbaseMarketOrder,
  coinbaseIocLimitOrder,
  coinbaseLimitOrder,
  coinbaseOrderFilled,
  coinbaseOrderDetails,
  coinbaseFillPrice,
  coinbaseCancelOrder,
  getKrakenBidAsk,
  getCoinbaseBidAsk,
  getCoinbaseProductIncrements,
  quantizeDown,
  PAIRS,
  getKrakenNonceHealth,
  type Pair,
} from "../lib/exchange";
import { getBestPairPrices, getTriPrices, getBtcTriPrices, scanAllPairs, getPairPrices, getAllPairSnapshots } from "../lib/price-cache";
import { scanOrderBookCycles, preflightObCycle, discoverCrossPairs, freshJoinPrice, makerQuote, takerCycleBreakdown, cachedTakerCycleBreakdown, getEventScan, krakenStreamStats, getStreamBook, waitForBookTouch, formatLegAges, OB_ASSETS, OB_USD_PAIRS, CROSS_LOOKUP, type ObAsset } from "../lib/order-book";
import { scanGraphOpportunities, type GeminiScanInput, type GeminiEdgeBook, type BookLevels } from "../lib/graph-engine";
import { crossTakerBreakdown, crossTakerBreakdownRest } from "../lib/cross-pricing";
import { routeSanityError } from "../lib/route-sanity";
import { projectMakerHedge, bestMakerHedgeProjection, projectTakerTaker, type MmProjection, type MmDirection } from "../lib/cross-mm";
import { detectFees as detectRealFees } from "../lib/fees";
import { coinbaseBookKey, coinbaseStreamStats, getCoinbaseStreamBook, getGeminiStreamBook, startGeminiBookStream } from "../lib/book-stream";
import { geminiSymbols, geminiSymbolDetails } from "../lib/gemini-exec";
import { geminiVerify, type GeminiCreds } from "../lib/gemini";
import { createPairHistory, updatePairHistory, type PairHistory } from "../lib/kalman";
import { waitForTriLimitFill } from "../lib/tri-fill.js";
import { listTradesPage } from "../lib/trades-page.js";

// ── Cointegration pairs-trading state (in-process memory) ─────────────────────
// Pairs: SOL/ETH, BTC/ETH, AVAX/DOT
// Prices are fetched from the multi-pair cache; no extra exchange calls needed.

interface CointPairConfig {
  label: string;   // display name e.g. "SOL/ETH"
  asset1: string;  // canonical pair key in pairCache, e.g. "SOL/USD"
  asset2: string;  // e.g. "ETH/USD"
  sym1: string;    // short symbol e.g. "SOL"
  sym2: string;    // e.g. "ETH"
}

const COINT_PAIRS: CointPairConfig[] = [
  { label: "SOL/ETH",  asset1: "SOL/USD",  asset2: "ETH/USD",  sym1: "SOL",  sym2: "ETH"  },
  { label: "BTC/ETH",  asset1: "BTC/USD",  asset2: "ETH/USD",  sym1: "BTC",  sym2: "ETH"  },
  { label: "AVAX/DOT", asset1: "AVAX/USD", asset2: "DOT/USD",  sym1: "AVAX", sym2: "DOT"  },
];

// Keyed by pair label — persists between requests in the same server process
const cointHistories = new Map<string, PairHistory>();

// Minimum |z-score| to surface a signal
const COINT_Z_THRESHOLD = 2.0;

// ── Triangular arb helpers ─────────────────────────────────────────────────────

// Fee model (matches Python v13 scan_triangular / FORCE TRIANGULAR):
// Gross profit is computed without fee adjustment in volumes.
// Net = Gross − TRI_TOTAL_FEES_PCT (flat deduction, 3 legs at maker rate).
// TRI_FEE_PER_LEG kept for the per-leg product formula used in ETH scanner.
const TRI_FEE_PER_LEG   = 0.0026;  // 0.26% taker fee per leg (ETH scanner, conservative)
const TRI_TOTAL_FEES_PCT = 0.50;   // 0.50% total for 3 limit-order legs (3 × 0.16% maker, Python default)
const TRI_MIN_PROFIT_PCT = 0.10;   // minimum net profit % to surface an opportunity

interface TriOpp {
  exchange: string;
  loop: string;
  profitPct: number;
  solUsd: number;
  ethUsd: number;   // for BTC variant: holds BTC/USD mid
  ethSol: number;   // for BTC variant: holds SOL/BTC mid
  variant?: "eth" | "btc";
  timestamp: string;
}

/**
 * For a single exchange with known bid/ask on all three pairs, compute the
 * profitability of both triangular loops after taker fees.
 *
 * Loop 1: USD → SOL → ETH → USD
 *   product1 = ethBid×(1–f) / (solAsk×ethSolAsk×(1+f)²)
 *
 * Loop 2: USD → ETH → SOL → USD
 *   product2 = ethSolBid×solBid×(1–f)² / (ethAsk×(1+f))
 */
function computeTriLoops(
  exchange: string,
  solBid: number, solAsk: number,
  ethBid: number, ethAsk: number,
  ethSolBid: number, ethSolAsk: number,
): TriOpp[] {
  const f = TRI_FEE_PER_LEG;
  const ts = new Date().toISOString();
  const solUsdMid = (solBid + solAsk) / 2;
  const ethUsdMid = (ethBid + ethAsk) / 2;
  const ethSolMid = (ethSolBid + ethSolAsk) / 2;
  const result: TriOpp[] = [];

  // Loop 1: USD → SOL → ETH → USD
  const product1 = (ethBid * (1 - f)) / (solAsk * (1 + f) * ethSolAsk * (1 + f));
  const profit1 = (product1 - 1) * 100;
  if (profit1 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange, loop: "USD→SOL→ETH→USD", profitPct: profit1, solUsd: solUsdMid, ethUsd: ethUsdMid, ethSol: ethSolMid, timestamp: ts });
  }

  // Loop 2: USD → ETH → SOL → USD
  const product2 = (ethSolBid * (1 - f) * solBid * (1 - f)) / (ethAsk * (1 + f));
  const profit2 = (product2 - 1) * 100;
  if (profit2 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange, loop: "USD→ETH→SOL→USD", profitPct: profit2, solUsd: solUsdMid, ethUsd: ethUsdMid, ethSol: ethSolMid, timestamp: ts });
  }

  return result;
}

/**
 * Port of Python v13 scan_triangular(): BTC/SOL/USD loops on Kraken.
 * Gross profit is computed with no per-leg fee adjustment in volumes —
 * fees are applied as a flat deduction (TRI_TOTAL_FEES_PCT), matching
 * the Python's `net = profit_pct - tri_fees` model.
 *
 * Loop 1: USD → BTC → SOL → USD
 *   gross = solBid / (btcAsk × solBtcAsk) − 1   (in %)
 *   net   = gross − TRI_TOTAL_FEES_PCT
 *
 * Loop 2: USD → SOL → BTC → USD
 *   gross = solBtcBid × btcBid / solAsk − 1   (in %)
 *   net   = gross − TRI_TOTAL_FEES_PCT
 */
function computeBtcTriLoops(
  solBid: number, solAsk: number,
  btcBid: number, btcAsk: number,
  solBtcBid: number, solBtcAsk: number,
): TriOpp[] {
  const ts = new Date().toISOString();
  const solUsdMid = (solBid + solAsk) / 2;
  const btcUsdMid = (btcBid + btcAsk) / 2;
  const solBtcMid = (solBtcBid + solBtcAsk) / 2;
  const result: TriOpp[] = [];

  // Loop 1: USD → BTC → SOL → USD
  const gross1 = (solBid / (btcAsk * solBtcAsk) - 1) * 100;
  const net1   = gross1 - TRI_TOTAL_FEES_PCT;
  if (net1 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange: "Kraken", loop: "USD→BTC→SOL→USD", profitPct: net1, solUsd: solUsdMid, ethUsd: btcUsdMid, ethSol: solBtcMid, variant: "btc", timestamp: ts });
  }

  // Loop 2: USD → SOL → BTC → USD
  const gross2 = (solBtcBid * btcBid / solAsk - 1) * 100;
  const net2   = gross2 - TRI_TOTAL_FEES_PCT;
  if (net2 >= TRI_MIN_PROFIT_PCT) {
    result.push({ exchange: "Kraken", loop: "USD→SOL→BTC→USD", profitPct: net2, solUsd: solUsdMid, ethUsd: btcUsdMid, ethSol: solBtcMid, variant: "btc", timestamp: ts });
  }

  return result;
}

// ── SOL/BTC (SOLXBT) listing status ───────────────────────────────────────────
// Cached REST probe used by the triangular scan when the WS-fed BTC tri price
// cache is empty. It distinguishes "SOL/BTC is unlisted on Kraken" (the
// dashboard shows a persistent banner and BTC loops are paused) from a merely
// stale/warming cache. The execute path also writes this cache so a 503 there
// surfaces on the very next scan without waiting for a fresh probe.
const SOL_BTC_UNAVAILABLE_MSG = "SOL/BTC direct market unavailable on Kraken — BTC triangular loops cannot execute";
const SOL_BTC_CHECK_TTL_MS = 60_000;
let solBtcCheckCache: { at: number; listed: boolean } | null = null;

function recordSolBtcListing(listed: boolean): void {
  solBtcCheckCache = { at: Date.now(), listed };
}

/** Returns true/false when the listing state is known, null when the probe is
 *  inconclusive (network/API failure) — never flag "unlisted" on a guess. */
async function checkSolBtcListed(): Promise<boolean | null> {
  const now = Date.now();
  if (solBtcCheckCache && now - solBtcCheckCache.at < SOL_BTC_CHECK_TTL_MS) return solBtcCheckCache.listed;
  try {
    const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=SOLXBT", {
      signal: AbortSignal.timeout(5_000),
    });
    const data = await r.json() as { error?: string[]; result?: Record<string, unknown> };
    if (data.result && Object.keys(data.result).some(k => k.startsWith("SOL") && k.includes("XBT"))) {
      recordSolBtcListing(true);
      return true;
    }
    // Kraken reports an unlisted pair as EQuery:Unknown asset pair — that is a
    // definitive "not listed". Any other empty/failed response is inconclusive.
    if ((data.error ?? []).some(e => /unknown asset pair/i.test(e))) {
      recordSolBtcListing(false);
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

const router: IRouter = Router();

// ── GET /prices/all-pairs — cache snapshot, no REST fallbacks ─────────────────
router.get("/prices/all-pairs", (req, res): void => {
  try {
    // Accept enabledPairs as a comma-separated string or repeated query params
    const raw = req.query["enabledPairs"];
    let enabledPairs: string[] | undefined;
    if (raw != null) {
      const vals = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
      const filtered = vals.map(v => v.trim()).filter(Boolean);
      if (filtered.length > 0) enabledPairs = filtered;
    }
    res.json(getAllPairSnapshots(enabledPairs));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/scan — all 10 pairs ranked by gross spread ───────────────────────
// Optional query param: enabledPairs (comma-separated or repeated) — same filter
// as the /prices POST so disabled pairs don't appear in scan results.
router.get("/arb/scan", async (req, res): Promise<void> => {
  try {
    // Accept enabledPairs as a comma-separated string or repeated query params
    const raw = req.query["enabledPairs"];
    let enabledPairs: string[] | undefined;
    if (raw != null) {
      const vals = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
      const filtered = vals.map(v => v.trim()).filter(Boolean);
      if (filtered.length > 0) enabledPairs = filtered;
    }
    const entries = await scanAllPairs(enabledPairs);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/fresh-quote — cache-bypassing live bid/ask for one pair ──────────
// Fetches bid/ask directly from Kraken and Coinbase REST APIs, skipping the
// in-process WS cache entirely. Used by Force Trade for a stale-price preflight
// check immediately before execution. Returns the best executable route and a
// quotedAt ISO timestamp so the caller can measure true quote age.
router.get("/arb/fresh-quote", async (req, res): Promise<void> => {
  const pair = String(req.query["pair"] ?? "SOL/USD");
  if (!PAIRS.includes(pair as Pair)) {
    res.status(400).json({ error: `Unknown pair: ${pair}. Valid pairs: ${PAIRS.join(", ")}` });
    return;
  }
  try {
    const [krakenQ, coinbaseQ] = await Promise.all([
      getKrakenBidAsk(pair as Pair),
      getCoinbaseBidAsk(pair as Pair),
    ]);
    const quotedAt = new Date().toISOString();

    // Route 1: buy Kraken ask → sell Coinbase bid
    const kToC = ((coinbaseQ.bid - krakenQ.ask) / krakenQ.ask) * 100;
    // Route 2: buy Coinbase ask → sell Kraken bid
    const cToK = ((krakenQ.bid - coinbaseQ.ask) / coinbaseQ.ask) * 100;

    const useKraken     = kToC >= cToK;
    const grossSpreadPct = useKraken ? kToC : cToK;
    const buyExchange   = useKraken ? "Kraken"   : "Coinbase";
    const sellExchange  = useKraken ? "Coinbase" : "Kraken";
    const buyPrice      = useKraken ? krakenQ.ask  : coinbaseQ.ask;
    const sellPrice     = useKraken ? coinbaseQ.bid : krakenQ.bid;

    res.json({
      pair,
      krakenBid:    krakenQ.bid,
      krakenAsk:    krakenQ.ask,
      coinbaseBid:  coinbaseQ.bid,
      coinbaseAsk:  coinbaseQ.ask,
      grossSpreadPct,
      buyExchange,
      sellExchange,
      buyPrice,
      sellPrice,
      quotedAt,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/graph-scan ───────────────────────────────────────────────────────
// Multi-exchange graph opportunity engine: builds a directed graph over Kraken
// (34 assets + all verified cross pairs) and Coinbase (10 shared assets), then
// DFS-searches all USD→…→USD cycles up to 4 hops and ranks by net profit.
// Cross-exchange routes use an inventory bridge (no transfer lag assumed).
// Query params: tradeSizeUsd (default 10), krakenFeesPct (default 0.16),
//               coinbaseFeesPct (default 0.40), maxHops (default 4)
/** Detect a directly-executable Kraken triangle route: USD→A→B→USD, all Kraken. */
function krakenTriangleAssets(r: { hops: { from: string; to: string; exchange: string }[] }): { a: string; b: string } | null {
  const real = r.hops.filter(h => h.exchange !== "bridge");
  if (r.hops.length !== 3 || real.length !== 3 || !real.every(h => h.exchange === "kraken")) return null;
  const asset = (n: string) => n.split(":").pop()!;
  return { a: asset(r.hops[0]!.to), b: asset(r.hops[1]!.to) };
}

/**
 * PRICING CONSISTENCY: re-price every Kraken-triangle route with the SAME
 * depth-walk simulator, fee application, and streamed in-memory snapshot the
 * executor's pre-fire micro-check uses. The graph engine's own estimate
 * (separate leg math, possibly REST-cached books) is what caused the table to
 * show +1.3% while a 1ms-later pre-fire computed a negative net — the
 * displayed number must be the executable number.
 */
async function repriceKrakenTriangles(routes: { hops: { from: string; to: string; exchange: string }[]; description: string; netProfitUsd: number; profitPct: number; startUsd: number; quoteAgeMs?: number | null; pricedFrom?: string | null; marketUpdateMs?: number | null; repricedFeePct?: number | null }[], sizeUsd: number, takerFeePct: number, log: { debug: (o: object, m: string) => void }): Promise<void> {
  for (const r of routes) {
    const tri = krakenTriangleAssets(r);
    if (!tri) continue;
    try {
      const c = await cachedTakerCycleBreakdown(tri.a as ObAsset, tri.b as ObAsset, sizeUsd, takerFeePct, 30_000);
      if (c?.ok) {
        r.netProfitUsd = c.bd.netProfitUsd;
        r.profitPct = (c.bd.netProfitUsd / sizeUsd) * 100;
        r.quoteAgeMs = c.quoteAgeMs;
        r.pricedFrom = "stream";
        r.marketUpdateMs = c.marketUpdateMs;
        r.repricedFeePct = takerFeePct;
        log.debug({ route: r.description, netUsd: c.bd.netProfitUsd, quoteAgeMs: c.quoteAgeMs, legs: c.bd.legDiag }, "[SCAN LEGS] stream-priced route");
      } else {
        r.pricedFrom = "graph"; // stream unavailable — graph estimate retained, marked
      }
    } catch { r.pricedFrom = "graph"; }
  }
}

/** Identify a 2-leg cross-exchange inventory route (buy venue A → bridge →
 *  sell venue B, same asset) and return its pricing inputs, or null. */
function crossRouteShape(r: { hops: { from: string; to: string; exchange: string; side?: string }[] }): { asset: ObAsset; buyVenue: "kraken" | "coinbase" } | null {
  const real = r.hops.filter(h => h.exchange !== "bridge");
  if (r.hops.length !== 3 || real.length !== 2) return null;
  const a = (n: string) => n.split(":").pop()!;
  const buy = real[0]!, sell = real[1]!;
  if (a(buy.to) !== a(sell.from)) return null;
  const assetName = a(buy.to) as ObAsset;
  if (!(assetName in OB_USD_PAIRS)) return null;
  const bv = buy.exchange;
  if (bv !== "kraken" && bv !== "coinbase") return null;
  if (sell.exchange !== (bv === "kraken" ? "coinbase" : "kraken")) return null;
  return { asset: assetName, buyVenue: bv };
}

/** EXECUTOR-GRADE cross-route repricing: overwrite the graph estimate for
 *  2-leg Kraken↔Coinbase inventory routes with the depth-walked net from
 *  LIVE stream books on both venues (real fee tiers, VWAP fills). Routes
 *  whose books aren't streaming keep the graph number but stay marked
 *  "graph" — an estimate is never presented as executable. */
function repriceCrossRoutes(routes: { hops: { from: string; to: string; exchange: string }[]; description: string; netProfitUsd: number; profitPct: number; quoteAgeMs?: number | null; pricedFrom?: string | null; marketUpdateMs?: number | null; repricedFeePct?: number | null }[], sizeUsd: number, krakenTakerFeePct: number, coinbaseTakerFeePct: number, log: { debug: (o: object, m: string) => void }): void {
  for (const r of routes) {
    const shape = crossRouteShape(r);
    if (!shape) continue;
    try {
      const bd = crossTakerBreakdown(shape.asset, shape.buyVenue, sizeUsd, krakenTakerFeePct, coinbaseTakerFeePct);
      if (bd) {
        r.netProfitUsd = bd.netProfitUsd;
        r.profitPct = (bd.netProfitUsd / sizeUsd) * 100;
        r.quoteAgeMs = bd.quoteAgeMs;
        r.pricedFrom = "stream";
        r.marketUpdateMs = bd.marketUpdateMs;
        r.repricedFeePct = krakenTakerFeePct;
        log.debug({ route: r.description, netUsd: bd.netProfitUsd, quoteAgeMs: bd.quoteAgeMs, legs: bd.legDiag }, "[SCAN LEGS] stream-priced cross route");
      } else {
        r.pricedFrom = "graph";
      }
    } catch { r.pricedFrom = "graph"; }
  }
}

// ── Gemini SCAN-ONLY universe for the graph scanner ───────────────────────────
// Mirror of cross-venue.ts's Gemini universe discovery, kept local to avoid an
// arb↔cross-venue import cycle. Only symbols Gemini ACTUALLY lists with a USD
// book (never guessed); books warm via startGeminiBookStream so the first scan
// finds them fresh. Assumed Gemini taker % for credential-less display (labeled).
const GEMINI_ASSUMED_TAKER_PCT = 0.4;
let geminiGraphListed: string[] = []; // UPPER asset codes with a live Gemini USD book
let geminiGraphMinCache = new Map<string, number>(); // asset (UPPER) → minOrderSize (base)
let geminiGraphUniverseAt = 0;

async function refreshGeminiGraphUniverse(): Promise<void> {
  if (Date.now() - geminiGraphUniverseAt < 6 * 3600_000 && geminiGraphListed.length) return;
  const syms = await geminiSymbols(); // lowercase like "btcusd"
  const usd = new Set(syms.filter(s => s.endsWith("usd")).map(s => s.slice(0, -3).toUpperCase()));
  // Restrict to the shared graph universe (OB_ASSETS + USDC) so we only build
  // cross-venue hops against assets the other venues also carry.
  const wanted = [...OB_ASSETS, "USDC"].filter(a => usd.has(a));
  geminiGraphListed = wanted;
  geminiGraphUniverseAt = Date.now();
  startGeminiBookStream(wanted.map(a => `${a}USD`));
  // Prime symbol minimums (base units) for the SCAN minimum gate. Best-effort:
  // a missing minimum simply omits the gate for that asset (never fabricated).
  await Promise.all(wanted.map(async (a) => {
    try {
      const det = await geminiSymbolDetails(`${a}USD`);
      geminiGraphMinCache.set(a, det.minOrderSize);
    } catch { /* leave unset — no synthetic minimum */ }
  }));
}
/** Assemble the SCAN-ONLY Gemini input (live USD books + fee + minimums) for the
 *  graph engine, or null when no Gemini book is warm yet. Fees are DETECTED only
 *  when Gemini keys are in the request (else assumed+labeled). Fully defensive:
 *  ANY failure (universe fetch, missing book, verify) degrades to "no Gemini
 *  hops in this scan" rather than breaking the endpoint — Gemini is additive. */
async function buildGeminiScanInput(geminiKey: string | null, geminiSecret: string | null): Promise<GeminiScanInput | null> {
  try {
    try { await refreshGeminiGraphUniverse(); } catch { /* stale universe reused */ }
    const books = new Map<string, GeminiEdgeBook>();
    for (const asset of geminiGraphListed) {
      const b = getGeminiStreamBook(`${asset}USD`);
      if (!b || b.asks.length === 0 || b.bids.length === 0) continue;
      books.set(asset, {
        asks: b.asks as BookLevels,
        bids: b.bids as BookLevels,
        ageMs: b.ageMs,
        minOrderSize: geminiGraphMinCache.get(asset) ?? 0,
      });
    }
    if (books.size === 0) return null; // no warm Gemini book → skip Gemini entirely

    // Fee detection: DETECTED only when Gemini keys are supplied AND verify. A
    // detect-or-refuse rule — but this is a SCAN endpoint, so an assumed fee
    // just labels the route (routes are forced research-only regardless).
    let feePct = GEMINI_ASSUMED_TAKER_PCT;
    let feesDetected = false;
    if (geminiKey && geminiSecret) {
      try {
        const gc: GeminiCreds = { geminiKey, geminiSecret };
        const acct = await geminiVerify(gc);
        feePct = acct.takerPct;
        feesDetected = true;
      } catch { /* verify failed → stay assumed+labeled */ }
    }
    return { assets: [...books.keys()], books, feePct, feesDetected };
  } catch {
    return null; // Gemini scan input unavailable → scan Kraken/Coinbase as before
  }
}

router.get("/arb/graph-scan", async (req, res): Promise<void> => {
  const tradeSizeUsd    = Math.max(1,  parseFloat(String(req.query["tradeSizeUsd"]    ?? "10"))   || 10);
  const krakenFeesPct   = Math.max(0,  parseFloat(String(req.query["krakenFeesPct"]   ?? "0.16")) || 0.16);
  const coinbaseFeesPct = Math.max(0,  parseFloat(String(req.query["coinbaseFeesPct"] ?? "0.40")) || 0.40);
  const maxHops         = Math.min(5, Math.max(2, parseInt(String(req.query["maxHops"] ?? "4"), 10) || 4));
  const executionStyle  = String(req.query["executionStyle"] ?? "taker") === "maker" ? "maker" as const : "taker" as const;
  // Optional non-reversible account scope (sha256 prefix computed client-side
  // from the held keys — same derivation as accountIdFromKey). Without it,
  // history-based ranking is skipped: every route gets the neutral prior.
  const accountId = String(req.query["accountId"] ?? "").trim() || null;
  // Optional Gemini keys (SCAN-ONLY): when present, Gemini fees are DETECTED and
  // labeled as such; routes through Gemini are ALWAYS research-only regardless.
  const geminiKey    = String(req.query["geminiKey"]    ?? "").trim() || null;
  const geminiSecret = String(req.query["geminiSecret"] ?? "").trim() || null;
  try {
    // Feed live Gemini USD books into the graph so cross-venue hops through
    // Gemini surface in ranked routes. STRICTLY scan-only — the engine forces
    // executable:false on every route containing a Gemini leg.
    const geminiInput = await buildGeminiScanInput(geminiKey, geminiSecret);
    // Display endpoint: no Kraken keys here, so fee inputs are ASSUMED tiers,
    // not detected — every route stays research-only ("fees assumed") until the
    // executor path (which passes detected tiers) prices it.
    const result = await scanGraphOpportunities(tradeSizeUsd, krakenFeesPct, coinbaseFeesPct, maxHops, executionStyle, false, geminiInput ?? undefined);
    // Taker/adaptive display: Kraken triangles priced by the executor's own
    // simulator on the streamed snapshot — table number == pre-fire number.
    if (executionStyle === "taker") {
      await repriceKrakenTriangles(result.routes, tradeSizeUsd, krakenFeesPct, req.log);
      repriceCrossRoutes(result.routes, tradeSizeUsd, krakenFeesPct, coinbaseFeesPct, req.log);
    }
    // Repricing overwrote netProfitUsd on stream-priced routes — keep the
    // ranked, buffered net (netAfterBufferUsd) in lockstep so ranking stays on
    // the pessimistic post-buffer number. The buffer mirrors the execution
    // preflight: max(0.02, size×0.0005). (Fallback derive when a route object
    // predates the field.)
    const graphSafetyBufferUsd = Math.max(0.02, tradeSizeUsd * 0.0005);
    for (const r of result.routes) {
      if (r.safetyBufferUsd == null) r.safetyBufferUsd = graphSafetyBufferUsd;
      r.netAfterBufferUsd = r.netProfitUsd - r.safetyBufferUsd;
      r.status = r.netAfterBufferUsd > 0 ? "VIABLE" : "REJECTED";
      // Canonical sanity guard: an implausible net (unit inversion, notional
      // reset, corrupt book) must never display as viable or reach execution.
      const sanity = routeSanityError(r.startUsd, r.netProfitUsd, r.grossProfitUsd);
      if (sanity) {
        r.status = "PRICING CONSISTENCY ERROR";
        r.executable = false;
        r.researchReason = sanity;
        r.netAfterBufferUsd = Math.min(r.netAfterBufferUsd, 0);
      }
    }
    // Fill-rate-weighted ranking (advisor-reviewed): rank executable routes by
    // expected REALIZED profit — net profit × historical live fill rate — not
    // theoretical edge alone. A +$0.10 route that fills 20% of the time (≈$0.02)
    // should rank below a +$0.07 route that fills 80% (≈$0.056).
    // Tiers: <10 live attempts → insufficient history, neutral 0.7 prior;
    // ≥10 & <50% → gate blocks it anyway; 50–70% → ranked down by its rate;
    // >70% → prioritized (multiplier near 1).
    const stats = accountId ? await routeFillStats(executionStyle, accountId) : new Map<string, { liveAttempts: number; fillRate: number }>();
    for (const r of result.routes) {
      const s = stats.get(r.description);
      const enough = (s?.liveAttempts ?? 0) >= GATE_MIN_ATTEMPTS;
      r.histLiveAttempts = s?.liveAttempts ?? 0;
      r.histFillRate = enough ? s!.fillRate : null;
      // Multiplier only discounts POSITIVE edges — scaling a negative net
      // toward zero would perversely rank chronic non-fillers higher. (The
      // safety buffer already ranked routes inside the graph engine's own
      // sort; this fill-rate layer weights the display net.)
      r.effectiveScoreUsd = r.netProfitUsd > 0 ? r.netProfitUsd * (enough ? s!.fillRate : 0.7) : r.netProfitUsd;
    }
    result.routes.sort((a, b) =>
      (Number(b.executable) - Number(a.executable)) ||
      ((b.effectiveScoreUsd ?? b.netProfitUsd) - (a.effectiveScoreUsd ?? a.netProfitUsd)));
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "graph-scan error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/ob-scan ──────────────────────────────────────────────────────────
// Port of Python v18 "Scaling Analyzer" (34 assets; top route re-simulated at
// $10/$50/$100/$500/$1,000 with VIABLE / HIGH_SLIPPAGE / REJECTED statuses).
// Fetches L2 depth from Kraken, walks the book for all simulatable cycles,
// classifies each READY / HIGH_SLIPPAGE / LOW_PROFIT and scores liquidity
// confidence. Optional volatility filter scans only assets moving >1.5%/24h.
// Query params: tradeSizeUsd (default 10), feesPct (default 0.4, per-leg taker),
//               minProfitUsd (default 0.02, scaled by size/10), maxSlippagePct (default 0.5),
//               volatilityFilter (default true)
router.get("/arb/ob-scan", async (req, res): Promise<void> => {
  const tradeSizeUsd   = Math.max(1, parseFloat(String(req.query["tradeSizeUsd"]   ?? "10"))   || 10);
  const feesPct        = Math.max(0, parseFloat(String(req.query["feesPct"]        ?? "0.26")) || 0.26);
  const minProfitUsd   = Math.max(0, parseFloat(String(req.query["minProfitUsd"]   ?? "0.02")) || 0.02);
  const maxSlippagePct = Math.max(0, parseFloat(String(req.query["maxSlippagePct"] ?? "0.4"))  || 0.4);
  const volatilityFilter = String(req.query["volatilityFilter"] ?? "true") !== "false";
  // v20: 3 = triangles only; 4 (default) adds USD→A→BTC→ETH→USD / USD→A→ETH→BTC→USD
  const maxLegs = String(req.query["maxLegs"] ?? "4") === "3" ? 3 as const : 4 as const;
  try {
    const result = await scanOrderBookCycles(tradeSizeUsd, feesPct, minProfitUsd, maxSlippagePct, volatilityFilter, maxLegs);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "OB scan error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/ob-pairs-refresh ─────────────────────────────────────────────────
// Force-invalidates the discovered cross-pair cache and re-queries Kraken
// AssetPairs immediately, so an operator can pick up new listings on demand.
router.get("/arb/ob-pairs-refresh", async (req, res): Promise<void> => {
  try {
    const d = await discoverCrossPairs(true);
    res.json({
      refreshed: d.cachedAt > 0,
      crossPairsDiscovered: d.cachedAt > 0 ? d.crossMap.length : 0,
      cachedAt: d.cachedAt > 0 ? new Date(d.cachedAt).toISOString() : null,
    });
  } catch (err) {
    req.log.error({ err }, "ob-pairs-refresh error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /arb/ob-execute ──────────────────────────────────────────────────────
// Port of Python v18 "MANUAL EXECUTION BUTTON": re-fetches FRESH order books
// for the top route, re-simulates (pre-flight), and only places orders when
// the edge survives (profit > minProfitUsd × size/10). Three sequential Kraken
// market orders with orientation-aware legs.
// NOTE: the Python's leg math is buggy (unconditional "sell" on the cross leg,
// nonsense leg-3 volume `vol × profit/size`) — we size all legs from the
// pre-flight simulation instead. On leg failure, previously filled legs are
// unwound with reverse market orders (best effort).
router.post("/arb/ob-execute", async (req, res): Promise<void> => {
  const parsed = ObExecuteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const out = await runKrakenTriangle(parsed.data, req.log);
  if (out.badRequest) { res.status(400).json({ error: out.badRequest }); return; }
  res.json(out.body);
});

// ── Live execution status (per-leg maker fill timers) ────────────────────────
// In-memory snapshot of the currently-executing triangle, updated by the leg
// fill machinery and polled by the dashboard (GET /arb/execution-status).
interface ExecStatus {
  active: boolean;
  route: string | null;
  leg: number | null;          // 1..3
  legLabel: string | null;     // e.g. "leg2: buy SOL/BTC"
  pair: string | null;
  orderId: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  startedAtMs: number | null;  // current attempt start (server clock)
  timeoutMs: number | null;    // per-leg fill timer
  filledPct: number | null;    // 0..100 of the leg's target volume
  phase: string | null;        // "waiting fill" | "retrying — fresh book + pre-flight" | ...
  // Maker-quality telemetry (leg 1 aggressive pricing)
  orderPrice: number | null;   // our resting post-only price
  bestBid: number | null;
  bestAsk: number | null;
  queueAheadVol: number | null; // book volume ahead of us at our level (0 = front)
  reprices: number | null;      // reprices consumed this leg
  updatedAtMs: number;
}
const idleExecStatus = (): ExecStatus => ({
  active: false, route: null, leg: null, legLabel: null, pair: null, orderId: null,
  attempt: null, maxAttempts: null, startedAtMs: null, timeoutMs: null,
  filledPct: null, phase: null, orderPrice: null, bestBid: null, bestAsk: null,
  queueAheadVol: null, reprices: null, updatedAtMs: Date.now(),
});
let execStatus: ExecStatus = idleExecStatus();
function setExecStatus(patch: Partial<ExecStatus>): void {
  execStatus = { ...execStatus, ...patch, updatedAtMs: Date.now() };
  // Heartbeat: a live execution proves it's alive every time it transitions
  // phase/leg/fill state. Staleness is measured from this, not lock age.
  if (liveExecLockHeld) liveExecLockSinceMs = Date.now();
}

// Single-flight lock for LIVE order placement. One process, one live triangle
// at a time: prevents two executions (AUTO + manual, two browser tabs) from
// interleaving orders, corrupting each other's execStatus, or double-spending
// the same balance. Dry runs and pre-flights are not serialized.
let liveExecLockHeld = false;
let liveExecLockSinceMs = 0; // heartbeat — refreshed by every setExecStatus()
let liveExecLockGen = 0;     // generation token: only the CURRENT holder may release
// Failsafe: every phase of a live execution updates execStatus within seconds
// (bounded poll loops / order placements). A lock whose holder has produced NO
// heartbeat for this long belongs to a dead execution (crashed promise, lost
// await) — clear it instead of refusing new trades forever. Deliberately far
// above the longest single bounded wait (~15s confirm polls, ~35s exchange
// waits) so a slow-but-alive execution is never evicted.
// Heartbeat SILENCE (not runtime) evicts a dead lock holder. Every executor
// heartbeats each status update and every 1s poll tick, and every private
// exchange call (Kraken AND Coinbase) beats on start/finish plus every ≤5s
// during rate-limit backoff sleeps — so the worst LEGITIMATE silence is one
// HTTP timeout (~10s). A crashed execution is cleared in ≤30s. A hard
// wall-clock cap (e.g. 5s) is unsafe: legs legitimately take longer, and
// evicting a lock mid-order lets two executions spend the same balance.
const LIVE_LOCK_STALE_MS = 30_000;
function liveLockBusy(): boolean {
  if (!liveExecLockHeld) return false;
  if (Date.now() - liveExecLockSinceMs > LIVE_LOCK_STALE_MS) {
    liveExecLockHeld = false;
    liveExecLockGen++; // invalidate the dead holder's token — its finally becomes a no-op
    execStatus = idleExecStatus();
    return false;
  }
  return true;
}
/** Returns a generation token; pass it to releaseLiveLock so a stale-evicted
 *  holder can never release a NEWER execution's lock. */
export function acquireLiveLock(): number {
  liveExecLockHeld = true;
  liveExecLockSinceMs = Date.now();
  return ++liveExecLockGen;
}
/** Heartbeat for live executors that don't drive execStatus (graph-cross,
 *  inventory): call from every poll/order/unwind step to prove liveness. */
export function touchLiveLock(): void {
  if (liveExecLockHeld) liveExecLockSinceMs = Date.now();
}
export function releaseLiveLock(gen: number): void {
  if (gen === liveExecLockGen && liveExecLockHeld) {
    liveExecLockHeld = false;
    execStatus = idleExecStatus();
  }
}

/** Cross-module tryAcquire for OTHER route modules (e.g. the two-exchange
 *  scanner): refuses whenever ANY live executor holds the shared lock — no
 *  stale eviction, refusal is always the safe answer for an opportunistic
 *  strategy. Returns a generation token or null. */
export function tryAcquireSharedLiveLock(): number | null {
  return liveExecLockHeld ? null : acquireLiveLock();
}

/** True while `gen` is still the CURRENT lock owner. A KILL/HARD RESET bumps
 *  the generation, so executors can check this before placing further orders
 *  (cooperative abort). */
export function liveLockOwned(gen: number): boolean {
  return liveExecLockHeld && gen === liveExecLockGen;
}
/** Milliseconds since the current lock holder's last heartbeat. */
function liveLockSilentMs(): number {
  return liveExecLockHeld ? Date.now() - liveExecLockSinceMs : 0;
}
/** FORCE MODE eviction threshold — executors heartbeat every ~1s, so 15s of
 *  silence means the holder is dead. Shorter than LIVE_LOCK_STALE_MS (30s)
 *  because the trader has explicitly opted into aggressive behavior. */
const FORCE_LOCK_STALE_MS = 15_000;
/** Ownership-scoped heartbeat for the lock holder: executors bind this (via
 *  bindLockHeartbeat) right after acquiring the lock, so THEIR private
 *  exchange calls — including rate-limit backoff sleeps and paced-queue
 *  waits — beat the lock heartbeat every ≤5s and a legitimately waiting
 *  executor is never silent long enough (>15s) for FORCE MODE to evict it.
 *  The generation check makes it a no-op the moment ownership is revoked
 *  (KILL / eviction / release), and calls OUTSIDE the owner's scope beat
 *  nothing — unrelated traffic can never keep a dead lock alive. */
export function liveLockHeartbeat(gen: number): () => void {
  return () => { if (liveLockOwned(gen)) touchLiveLock(); };
}

/** HARD RESET: force-release the live lock regardless of holder. Bumps the
 *  generation so the evicted holder's finally-release becomes a no-op. */
function forceReleaseLiveLock(): boolean {
  const wasHeld = liveExecLockHeld;
  liveExecLockHeld = false;
  liveExecLockGen++;
  execStatus = idleExecStatus();
  return wasHeld;
}

// ── Consecutive-failure route blacklist ──────────────────────────────────────
// 5 failed LIVE full cycles IN A ROW → route blacklisted for 5 minutes so the
// engine immediately moves to the next best route instead of grinding a dead
// one. A single completed cycle resets the streak. Scoped per account+style.
const ROUTE_BLACKLIST_AFTER = 5;
const ROUTE_BLACKLIST_MS = 5 * 60_000;
// PERSISTED in route_gate_state (DB is the source of truth) so a server
// restart — or a second process behind the published app — never resets a
// failure streak or blacklist ban. The Map is a resilience fallback only:
// when the DB is briefly unreachable we degrade to the old per-process
// behavior instead of dropping the gates entirely.
const routeFailStreaks = new Map<string, { streak: number; blacklistedUntil: number }>();
const streakKey = (accountId: string, style: string, route: string) => `${accountId}|${style}|${route}`;
const routeGateWhere = (accountId: string, style: string, route: string) =>
  dbAnd(dbEq(routeGateStateTable.accountId, accountId), dbEq(routeGateStateTable.style, style), dbEq(routeGateStateTable.route, route));
async function noteRouteLiveResult(accountId: string, style: string, route: string, filled: boolean): Promise<void> {
  const key = streakKey(accountId, style, route);
  if (filled) {
    routeFailStreaks.delete(key);
    // Reset streak+ban but keep the row (and its probe timestamp).
    try {
      await db.update(routeGateStateTable).set({ failStreak: 0, blacklistedUntilMs: 0, updatedAt: new Date() })
        .where(routeGateWhere(accountId, style, route));
    } catch { /* fallback Map already cleared */ }
    return;
  }
  const now = Date.now();
  try {
    // Atomic increment (multi-process safe): the DB computes the new streak
    // and applies the ban in one statement. Streak is NOT reset by the ban —
    // only a SUCCESS clears it. Otherwise a chronically failing route would
    // re-earn the profitable-route override (streak < 5) immediately after
    // every ban expiry.
    const [row] = await db.insert(routeGateStateTable)
      .values({ accountId, style, route, failStreak: 1, blacklistedUntilMs: 1 >= ROUTE_BLACKLIST_AFTER ? now + ROUTE_BLACKLIST_MS : 0 })
      .onConflictDoUpdate({
        target: [routeGateStateTable.accountId, routeGateStateTable.style, routeGateStateTable.route],
        set: {
          failStreak: sql`${routeGateStateTable.failStreak} + 1`,
          blacklistedUntilMs: sql`CASE WHEN ${routeGateStateTable.failStreak} + 1 >= ${ROUTE_BLACKLIST_AFTER} THEN ${now + ROUTE_BLACKLIST_MS} ELSE ${routeGateStateTable.blacklistedUntilMs} END`,
          updatedAt: new Date(),
        },
      })
      .returning({ failStreak: routeGateStateTable.failStreak, blacklistedUntilMs: routeGateStateTable.blacklistedUntilMs });
    if (row) routeFailStreaks.set(key, { streak: row.failStreak, blacklistedUntil: row.blacklistedUntilMs });
    return;
  } catch { /* DB unavailable — fall through to in-memory bookkeeping */ }
  const cur = routeFailStreaks.get(key) ?? { streak: 0, blacklistedUntil: 0 };
  cur.streak += 1;
  if (cur.streak >= ROUTE_BLACKLIST_AFTER) cur.blacklistedUntil = now + ROUTE_BLACKLIST_MS;
  routeFailStreaks.set(key, cur);
}
/** Current gate state for a route: DB first (survives restarts, shared across
 *  processes), in-memory fallback when the DB read fails. */
async function getRouteGate(accountId: string, style: string, route: string): Promise<{ streak: number; blacklistedUntil: number }> {
  const key = streakKey(accountId, style, route);
  try {
    const [row] = await db.select().from(routeGateStateTable).where(routeGateWhere(accountId, style, route)).limit(1);
    const val = row ? { streak: row.failStreak, blacklistedUntil: row.blacklistedUntilMs } : { streak: 0, blacklistedUntil: 0 };
    if (row) routeFailStreaks.set(key, val); else routeFailStreaks.delete(key);
    return val;
  } catch {
    return routeFailStreaks.get(key) ?? { streak: 0, blacklistedUntil: 0 };
  }
}
function routeBlacklistRemainingOf(gate: { blacklistedUntil: number }): number {
  return Math.max(0, gate.blacklistedUntil - Date.now());
}

// ── Operator proof ────────────────────────────────────────────────────────────
// The server has no login, so every control that LOOSENS money-safety behavior
// (blacklist wipe, FORCE MODE, lock clears) must prove account ownership with
// valid Kraken credentials before it is honored. Successful verifications are
// cached briefly by SHA-256 of the credential pair so repeated operator actions
// don't hammer Kraken's private API — a failed or missing proof is never cached.
const OPERATOR_PROOF_TTL_MS = 5 * 60_000;
const operatorProofCache = new Map<string, number>(); // sha256(key␀secret) → verifiedAt ms

async function verifyOperatorProof(krakenKey: unknown, krakenSecret: unknown): Promise<"ok" | "missing" | "failed"> {
  const key = typeof krakenKey === "string" ? krakenKey.trim() : "";
  const secret = typeof krakenSecret === "string" ? krakenSecret.trim() : "";
  if (!key || !secret) return "missing";
  const hash = createHash("sha256").update(`${key}\u0000${secret}`).digest("hex");
  const verifiedAt = operatorProofCache.get(hash);
  if (verifiedAt != null && Date.now() - verifiedAt < OPERATOR_PROOF_TTL_MS) return "ok";
  try {
    await getKrakenBalances({ krakenKey: key, krakenSecret: secret }); // proves account ownership
    operatorProofCache.set(hash, Date.now());
    return "ok";
  } catch {
    operatorProofCache.delete(hash);
    return "failed";
  }
}

// CLEAR BLACKLIST — reset all route history gates: consecutive-failure streaks,
// blacklist bans, and probe cool-downs. Requires operator proof (valid Kraken
// credentials): wiping the blacklist makes the bot trade MORE aggressively, so
// an anonymous caller on the public URL must never be able to trigger it.
router.post("/arb/route-history/clear", async (req, res): Promise<void> => {
  const proof = await verifyOperatorProof(req.body?.krakenKey, req.body?.krakenSecret);
  if (proof === "missing") { res.status(400).json({ error: "Kraken credentials required to clear the route blacklist." }); return; }
  if (proof === "failed")  { res.status(403).json({ error: "Kraken credential check failed — route blacklist not cleared." }); return; }
  let clearedRoutes = routeFailStreaks.size;
  routeFailStreaks.clear();
  routeProbeAt.clear();
  try {
    const deleted = await db.delete(routeGateStateTable).returning({ id: routeGateStateTable.id });
    clearedRoutes = Math.max(clearedRoutes, deleted.length);
  } catch (err) {
    req.log.error({ err }, "route-history clear: failed to delete persisted gate rows (in-memory state cleared)");
  }
  req.log.info({ clearedRoutes }, "Route blacklist + failure streaks cleared manually");
  res.json({ clearedRoutes });
});

// HARD RESET — manual lock clear for a stuck/dead execution. Requires VALID
// Kraken credentials: the server is otherwise unauthenticated, and clearing
// a live-execution lock is a concurrency-safety control — an anonymous
// caller must not be able to force two live executions to overlap.
router.post("/arb/exec-lock/clear", async (req, res): Promise<void> => {
  const key = typeof req.body?.krakenKey === "string" ? req.body.krakenKey : "";
  const secret = typeof req.body?.krakenSecret === "string" ? req.body.krakenSecret : "";
  if (!key || !secret) { res.status(400).json({ error: "Kraken credentials required to clear the execution lock." }); return; }
  try {
    await getKrakenBalances({ krakenKey: key, krakenSecret: secret }); // proves account ownership
  } catch {
    res.status(403).json({ error: "Kraken credential check failed — lock not cleared." });
    return;
  }
  let cancelledOrders: number | undefined;
  if (req.body?.cancelOrders === true) {
    // KILL SWITCH: cancel every open Kraken order BEFORE releasing the lock,
    // so a resting maker leg can't fill while a new execution starts.
    try {
      cancelledOrders = await krakenCancelAllOrders({ krakenKey: key, krakenSecret: secret });
    } catch (e) {
      res.status(502).json({ error: `Kraken CancelAll failed — lock NOT cleared (open orders may still be live): ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
  }
  // KILL must also resolve a pending indeterminate maker order — CancelAll
  // only covers Kraken; a Coinbase maker order needs its own cancel+confirm.
  let indeterminateResolved: boolean | undefined;
  let indeterminateNote: string | null = null;
  if (req.body?.cancelOrders === true && pendingIndeterminate) {
    const out = await resolvePendingIndeterminate(
      { krakenKey: key, krakenSecret: secret },
      { coinbaseKey: typeof req.body?.coinbaseKey === "string" ? req.body.coinbaseKey : undefined,
        coinbaseSecret: typeof req.body?.coinbaseSecret === "string" ? req.body.coinbaseSecret : undefined },
      req.log,
    );
    indeterminateResolved = out.cleared;
    indeterminateNote = out.message;
  }
  const wasHeld = forceReleaseLiveLock();
  req.log.info({ wasHeld, cancelledOrders, indeterminateResolved }, "HARD RESET: live execution lock force-cleared");
  res.json({ cleared: true, wasHeld, cancelledOrders, indeterminateResolved, indeterminateNote });
});

/** Cancel confirmed only by a TERMINAL Kraken order status — a cancel ack is
 *  not proof: the order may still fill in the race. Thrown when we cannot
 *  confirm; callers must NOT retry or unwind on assumed volumes. */
class IndeterminateOrderError extends Error {
  constructor(public readonly txid: string, label: string) {
    super(`${label}: order ${txid} state INDETERMINATE after cancel — no automatic retry/unwind performed; verify on Kraken before trading again.`);
  }
}

/** Thrown when a KILL / HARD RESET / FORCE eviction revoked this run's
 * execution lock mid-leg. Must propagate to the top-level catch WITHOUT
 * triggering taker fallbacks or retries — a revoked run may cancel its own
 * resting order and unwind ACTUAL fills, but must never place new orders. */
class LockRevokedError extends Error {
  constructor(label: string, detail: string, public readonly fill?: { volExec: number; cost: number; fee: number; txid: string }) {
    super(`${label}: execution lock revoked (KILL/HARD RESET) — ${detail}`);
  }
}

// ── Indeterminate maker-order reconciliation gate ─────────────────────────────
// When a maker order's cancel can't be confirmed to a TERMINAL status, the
// order may still be resting (or have filled late). Releasing the live lock is
// not enough — a later execution could overlap with that resting order. This
// gate persists past the lock: ALL live execution stays blocked until the
// specific order is verified terminal (automatically retried with the next
// live request's credentials, or via KILL/HARD RESET).
interface PendingIndeterminate { exchange: "kraken" | "coinbase"; orderId: string; route: string; sinceMs: number; }

// The gate is persisted to disk so a server RESTART cannot lose it while the
// order may still be resting — it is reloaded at module init and re-checked
// before any live-execution lock is acquired.
const PENDING_STATE_FILE = nodePath.join(process.cwd(), ".state", "pending-indeterminate-order.json");
function loadPendingIndeterminate(): PendingIndeterminate | null {
  try {
    const raw = JSON.parse(nodeFs.readFileSync(PENDING_STATE_FILE, "utf8")) as PendingIndeterminate;
    if ((raw.exchange === "kraken" || raw.exchange === "coinbase") && typeof raw.orderId === "string" && raw.orderId) return raw;
  } catch { /* no persisted gate */ }
  return null;
}
let pendingIndeterminate: PendingIndeterminate | null = loadPendingIndeterminate();
function setPendingIndeterminate(p: PendingIndeterminate | null): void {
  pendingIndeterminate = p;
  try {
    if (p) {
      nodeFs.mkdirSync(nodePath.dirname(PENDING_STATE_FILE), { recursive: true });
      nodeFs.writeFileSync(PENDING_STATE_FILE, JSON.stringify(p));
    } else {
      nodeFs.rmSync(PENDING_STATE_FILE, { force: true });
    }
  } catch (e) {
    // Persisting is defense-in-depth; the in-memory gate still holds.
    console.error(`Failed to persist indeterminate-order gate state: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function pendingIndeterminateMsg(): string | null {
  if (!pendingIndeterminate) return null;
  const p = pendingIndeterminate;
  return `LIVE execution blocked: maker order ${p.orderId} on ${p.exchange} (route ${p.route}) is in an INDETERMINATE cancel state — it may still be resting or have filled. It must be confirmed terminal before any new live trade.`;
}
// Test-scaled timers so mocked tests can exercise the full state machine fast.
const IS_TEST_ENV = process.env["NODE_ENV"] === "test" || process.env["VITEST"] === "true";
const MAKER_CROSS_FILL_WINDOW_MS = IS_TEST_ENV ? 60 : 30_000; // maker leg fill window
const CANCEL_CONFIRM_MS          = IS_TEST_ENV ? 60 : 10_000; // cancel → terminal confirmation window
const MAKER_POLL_MS              = IS_TEST_ENV ? 10 : 1_000;  // order-status poll interval

/**
 * Try to drive the pending indeterminate order to a TERMINAL status: re-issue
 * the cancel, then poll. Clears the gate ONLY on a confirmed terminal state.
 * Returns { cleared, message } — when cleared with a late fill, message
 * reports the ACTUAL filled volume needing manual rebalance (no hedge was
 * ever placed for it).
 */
async function resolvePendingIndeterminate(
  kCreds: { krakenKey: string; krakenSecret: string },
  cb: { coinbaseKey?: string; coinbaseSecret?: string },
  log: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void },
): Promise<{ cleared: boolean; message: string | null }> {
  const p = pendingIndeterminate;
  if (!p) return { cleared: true, message: null };
  const deadline = Date.now() + CANCEL_CONFIRM_MS;
  if (p.exchange === "kraken") {
    try { await krakenCancelOrder(kCreds, p.orderId); } catch { /* may already be terminal */ }
    for (;;) {
      try {
        const info = await krakenOrderInfo(kCreds, p.orderId);
        if (info.status === "closed" || info.status === "canceled" || info.status === "expired") {
          setPendingIndeterminate(null);
          log.info({ orderId: p.orderId, status: info.status, volExec: info.volExec }, "Indeterminate maker order resolved to terminal state");
          return {
            cleared: true,
            message: info.volExec > 0
              ? `Previously indeterminate maker order ${p.orderId} (${p.route}) resolved ${info.status} with ${info.volExec.toFixed(8)} filled — that fill was NEVER hedged; rebalance manually before trading.`
              : null,
          };
        }
      } catch { /* keep polling */ }
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, MAKER_POLL_MS));
    }
  } else {
    if (!cb.coinbaseKey || !cb.coinbaseSecret) {
      return { cleared: false, message: `${pendingIndeterminateMsg()} Coinbase credentials are required to verify/cancel it.` };
    }
    const cbCreds = { coinbaseKey: cb.coinbaseKey, coinbaseSecret: cb.coinbaseSecret };
    try { await coinbaseCancelOrder(cbCreds, p.orderId); } catch { /* may already be terminal */ }
    for (;;) {
      try {
        const d = await coinbaseOrderDetails(cbCreds, p.orderId);
        if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(d.status)) {
          setPendingIndeterminate(null);
          log.info({ orderId: p.orderId, status: d.status, filledSize: d.filledSize }, "Indeterminate maker order resolved to terminal state");
          return {
            cleared: true,
            message: d.filledSize > 0
              ? `Previously indeterminate maker order ${p.orderId} (${p.route}) resolved ${d.status} with ${d.filledSize.toFixed(8)} filled — that fill was NEVER hedged; rebalance manually before trading.`
              : null,
          };
        }
      } catch { /* keep polling */ }
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, MAKER_POLL_MS));
    }
  }
  return { cleared: false, message: pendingIndeterminateMsg() };
}


router.get("/arb/execution-status", (_req, res): void => {
  const s = execStatus;
  res.json({
    ...s,
    elapsedMs: s.active && s.startedAtMs != null ? Date.now() - s.startedAtMs : null,
    // Kraken key nonce health — flags when ANOTHER process (published app +
    // workspace) appears to be sharing this key, causing EAPI:Invalid nonce.
    nonceHealth: getKrakenNonceHealth(),
  });
});

// Shared core for ob-execute and graph-execute (Kraken-only triangles).
interface TriangleExecInput {
  krakenKey: string; krakenSecret: string;
  assetA: string; assetB: string;
  tradeSizeUsd: number; feesPct: number; minProfitUsd: number; isDryRun: boolean;
  /** Override the per-leg maker fill window (e.g. 2s probe attempts). */
  makerTimeoutMs?: number;
  /** Trader's freshness window (adaptive path): the pre-submission pre-flight
   *  must price ALL legs from the live stream within this age (measured from
   *  the EXCHANGE's market-data timestamps). Any stale leg → whole route
   *  stale → no order is submitted. REST is never consulted. */
  maxQuoteAgeMs?: number;
  /** Max leg-1 maker reprices before abandoning the route (default 4). */
  maxReprices?: number;
  /** Total leg-1 maker rest window in ms (clamped 5000–120000 server-side).
   *  Overrides the derived/makerTimeoutMs rest window for leg 1 only. */
  leg1RestMs?: number;
  /** Leg-1 edge re-check / reprice interval in ms while the maker order rests
   *  (clamped 500–30000 server-side; default 2500). */
  edgeCheckMs?: number;
  /** Trader-directed: when leg-1 maker doesn't fill in its window, go taker
   *  IMMEDIATELY without the taker-priced profit-floor gate. WARNING: a
   *  decayed edge will execute at whatever the fresh taker price gives —
   *  possibly a loss. Never applies when the fresh pre-flight is unavailable. */
  alwaysTakerFallback?: boolean;
  /** Trader-tuned partial-fill acceptance, in percent (clamped 50–100 server
   *  side; default 99.9). A leg whose confirmed fill reaches this fraction of
   *  its ordered volume counts as complete: the cycle proceeds sized to the
   *  ACTUAL fill and any residual inventory is swept back to USD at market
   *  (proceeds counted in realized P&L) instead of the whole cycle unwinding. */
  partialFillTolerancePct?: number;
  /** Caller ALREADY holds the live execution lock with this generation token.
   *  Skip the internal acquire (which would see the caller's own lock and
   *  self-block) — the caller releases it. */
  heldLockGen?: number;
  /** TAKER mode: no maker attempts at all — market/IOC on all 3 legs, gated
   *  by a FRESH taker-priced pre-flight (actual taker fee tier + depth-walked
   *  slippage + safety buffer must leave net > minProfitUsd). Fresh prices are
   *  re-fetched between legs (IOC caps / join re-quotes). */
  takerOnly?: boolean;
  /** Extra USD subtracted from the taker pre-flight net before the floor
   *  comparison (default max($0.02, 0.05% of size)). Taker mode only. */
  safetyBufferUsd?: number;
}
interface TriangleExecOut { badRequest?: string; body?: Record<string, unknown>; }
type ReqLog = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

/** Control-flow marker: taker-only mode skips the maker attempt entirely. */
class TakerOnlySkip extends Error { constructor() { super("taker-only mode — maker attempt skipped"); } }

/** Sell-leg failure carrying the UNSOLD residual (base units) needing unwind. */
class ResidualError extends Error {
  constructor(message: string, public readonly residual: number) { super(message); }
}

async function runKrakenTriangle(input: TriangleExecInput, reqLog: ReqLog): Promise<TriangleExecOut> {
  const { krakenKey, krakenSecret, assetA, assetB, tradeSizeUsd, feesPct, minProfitUsd, isDryRun } = input;
  const creds = { krakenKey, krakenSecret };
  const route = `USD→${assetA}→${assetB}→USD`;
  let lockGen: number | null = null;
  let ownsLock = false; // true only when WE acquired the lock (not adopted from caller)
  // Per-leg diagnostic: how many legs CONFIRMED filled before the run ended.
  // null until a live run actually starts placing orders (dry runs, pre-flight
  // rejections stay null so they can't skew leg-level fill rates).
  let legsCompleted: number | null = null;

  if (!(OB_ASSETS as readonly string[]).includes(assetA) || !(OB_ASSETS as readonly string[]).includes(assetB)) {
    return { badRequest: `Unknown asset(s): ${assetA}/${assetB}` };
  }

  // Failure-ledger context: kept OUTSIDE the try so the catch can persist a
  // FAILED row with the confirmed fill evidence gathered before the error.
  const failCtx: {
    legFills: Array<{ leg: number; volume: number; costUsd: number; txid: string }>;
    /** EVERY order Kraken accepted (txid returned), even zero-fill /
     * indeterminate / revoked ones — a failed run must never vanish. */
    acceptedOrders: Array<{ leg: number; label: string; pair: string; side: string; txid: string }>;
    expectedProfitUsd: number;
  } = { legFills: [], acceptedOrders: [], expectedProfitUsd: 0 };

  try {
    // 0. Use the account's ACTUAL taker fee tier when possible (advisor
    //    recommendation) instead of the caller's assumption. Falls back to the
    //    request's feesPct if the fee query fails (e.g. dry run with bad keys).
    //    v19: use the dynamically-discovered cross map so execution works for
    //    pairs not present in the hardcoded fallback.
    const { lookup: activeLookup } = await discoverCrossPairs();
    const crossPair = activeLookup.get(`${assetA}-${assetB}`)?.pair;
    const feePairs = [OB_USD_PAIRS[assetA as ObAsset], OB_USD_PAIRS[assetB as ObAsset], crossPair].filter((p): p is string => !!p);
    // All three legs are submitted POST-ONLY (limit at best bid/ask), so the
    // fee actually paid is the MAKER tier — the same tier the scanner uses in
    // maker mode. Using the taker tier here caused scanner-vs-preflight fee
    // mismatch (e.g. scan at 0.22% approving a route preflight rejected at 0.38%).
    const tiers = await krakenFeeTiers(creds, feePairs);
    const takerOnly = input.takerOnly === true;
    const actualFeePct = takerOnly
      ? (tiers?.takerFeePct ?? null)
      : (tiers?.makerFeePct ?? tiers?.takerFeePct ?? null);
    const effectiveFeesPct = actualFeePct ?? feesPct;
    const feeStyleNote = takerOnly
      ? (tiers?.takerFeePct != null ? "verified taker tier — all 3 legs market/IOC" : "assumed taker (fee query failed)")
      : tiers?.makerFeePct != null
        ? "verified maker tier — all 3 legs post-only"
        : tiers != null
          ? "verified taker tier — maker tier unavailable from Kraken"
          : "assumed (fee query failed)";
    // Taker-mode safety buffer: subtracted from the fresh taker net before
    // every floor comparison — covers movement between pre-flight and fills.
    const safetyBufferUsd = takerOnly
      ? Math.min(tradeSizeUsd * 0.05, Math.max(0.02, input.safetyBufferUsd ?? Math.max(0.02, tradeSizeUsd * 0.0005)))
      : 0;

    // 1. Fresh pre-flight (cache bypassed, depth 10)
    // Price the pre-flight the way the orders actually execute: POST-ONLY
    // limits at join prices (maker), not a taker depth-walk — otherwise the
    // simulation understates the edge by the spread and rejects routes the
    // maker scanner correctly approved.
    const pf = await preflightObCycle(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, effectiveFeesPct, takerOnly ? "taker" : "maker", input.maxQuoteAgeMs);
    if (!pf) {
      return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: null, error: "Could not fetch fresh order books (or depth can't absorb the size)." } };
    }
    // Canonical sanity guard on the fresh pre-fire number: an implausible net
    // (unit inversion, notional reset, corrupt book) must never fire — this
    // gate cannot be bypassed by force mode or big-edge history bypasses.
    {
      const sanityErr = routeSanityError(tradeSizeUsd, pf.profitUsd);
      if (sanityErr) {
        reqLog.error({ route, freshProfitUsd: pf.profitUsd, tradeSizeUsd }, "PRICING CONSISTENCY ERROR — triangle pre-fire net implausible; execution blocked");
        return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: sanityErr } };
      }
    }
    // Execution gate: fresh profit AFTER FEES must clear the caller's
    // minProfitUsd floor (flat USD, not scaled by trade size). Taker mode
    // additionally subtracts the safety buffer — the depth-walked taker net
    // minus buffer must still clear the floor.
    const threshold = minProfitUsd;
    // PROFITABILITY SAFEGUARD (2026-08-08 audit): all 9 verified live maker
    // fills lost money — expected avg +$0.04, realized avg −$0.19; completion/
    // unwind cost ≈ $0.23 on a $10 cycle. Maker attempts are therefore gated
    // by a HIGHER floor than the generic one: expected net must clearly exceed
    // the historical completion cost, or the maker leg is not worth resting.
    const makerFloor = makerFloorUsd(tradeSizeUsd, threshold);
    if (!takerOnly && pf.profitUsd <= makerFloor) {
      reqLog.info({ route, freshProfitUsd: pf.profitUsd, makerFloorUsd: makerFloor, threshold }, "Pre-flight REJECTED — maker floor (thin maker edges are proven losers; audit-based safeguard)");
      return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: `Pre-flight failed — maker safeguard: expected net $${pf.profitUsd.toFixed(4)} ≤ maker floor $${makerFloor.toFixed(4)} (historical completion/unwind cost ≈ $0.23 on $10; verified live maker fills at thin edges averaged −$0.19 realized). Use adaptive/taker, or a route with a clearly larger edge.` } };
    }
    if (pf.profitUsd - safetyBufferUsd <= threshold) {
      reqLog.info({ route, freshProfitUsd: pf.profitUsd, threshold, safetyBufferUsd, effectiveFeesPct, takerOnly }, "Pre-flight REJECTED — fresh books below profit floor");
      return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: takerOnly
        ? `Pre-flight failed — taker-priced net (depth-walked, ${effectiveFeesPct.toFixed(2)}%/leg taker fees, ${feeStyleNote}) $${pf.profitUsd.toFixed(4)} − safety buffer $${safetyBufferUsd.toFixed(4)} ≤ minimum $${threshold.toFixed(4)}.`
        : `Pre-flight failed — fresh profit after ${effectiveFeesPct.toFixed(2)}%/leg fees (${feeStyleNote}) is $${pf.profitUsd.toFixed(4)} ≤ minimum $${threshold.toFixed(4)}.` } };
    }

    // 2. Dry run — record a ledger row, no orders
    if (isDryRun) {
      await db.insert(tradesTable).values({
        pair: route,
        buyExchange: "kraken",
        sellExchange: "kraken",
        volume: pf.volumeA.toFixed(8),
        estimatedProfitUsd: pf.profitUsd.toFixed(6),
        netEdgePct: ((pf.profitUsd / tradeSizeUsd) * 100).toFixed(4),
        isDryRun: true,
        krakenPrice: "0",
        coinbasePrice: "0",
        status: "simulated",
      });
      reqLog.info({ route, tradeSizeUsd, profit: pf.profitUsd }, "OB manual execute (dry run)");
      return { body: { success: true, isDryRun: true, executed: true, route, preflightProfitUsd: pf.profitUsd, leg1OrderId: null, leg2OrderId: null, leg3OrderId: null } };
    }

    // 3. Live — three sequential market orders. Each leg must FULLY fill or
    //    the execution aborts and unwinds the ACTUAL residual positions
    //    (queried from the exchange, never assumed from the plan). Success is
    //    only reported when the position ends flat.
    // Indeterminate-order gate: a maker order from a previous cross-exchange
    // run whose cancel was never confirmed blocks ALL live execution.
    const pendMsg = pendingIndeterminateMsg();
    if (pendMsg) {
      return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: pendMsg } };
    }
    // Single-flight: only one LIVE triangle may run in this process. When the
    // caller (graph-execute) already holds the lock, adopt its token instead
    // of re-checking — checking would see the caller's own lock and self-block.
    if (input.heldLockGen != null) {
      lockGen = input.heldLockGen;
    } else {
      if (liveLockBusy()) {
        return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: "Another live execution is already in progress — wait for it to finish." } };
      }
      lockGen = acquireLiveLock();
      ownsLock = true;
    }
    bindLockHeartbeat(liveLockHeartbeat(lockGen));
    // An ADOPTED lock may already be stale (caller evicted during its own
    // preflight). Verify ownership BEFORE placing any order.
    if (!liveLockOwned(lockGen)) {
      throw new LockRevokedError("leg1", "aborted before any order was placed.");
    }
    legsCompleted = 0;

    const log = { info: (m: string) => reqLog.info(m), error: (m: string) => reqLog.error(m) };
    const [l1, l2, l3] = pf.legs;
    // v19: use the dynamically-discovered lookup (same activeLookup from step 0)
    // so routes found only via AssetPairs discovery execute correctly.
    const cross = activeLookup.get(`${assetA}-${assetB}`)!; // validated by pre-flight
    const pairA = OB_USD_PAIRS[assetA as ObAsset];
    const pairB = OB_USD_PAIRS[assetB as ObAsset];

    // Route-level precision preflight (BEFORE any order): every planned leg —
    // and therefore every full-size unwind, which uses the same USD pairs —
    // must have Kraken precision metadata AND clear the pair's minimum volume.
    // Rejecting here costs nothing; a KrakenPrecisionError on leg 2/3 would
    // strand inventory mid-cycle.
    try {
      for (const leg of pf.legs) {
        const meta = await krakenPairMeta(leg.pair);
        if (meta.ordermin > 0 && leg.volume < meta.ordermin) {
          return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: `Pre-flight failed — planned ${leg.pair} volume ${leg.volume.toFixed(8)} is below Kraken's minimum ${meta.ordermin}; increase trade size or skip this route.` } };
        }
      }
    } catch (e) {
      return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: pf.profitUsd, error: `Pre-flight failed — ${(e as Error).message}` } };
    }
    // Trader-tuned: a leg counts as complete once its confirmed fill reaches
    // this fraction of ordered volume. Clamped to 50–100%: below 50% a
    // "successful" cycle would be mostly unwind and its P&L meaningless.
    const FILL_TOLERANCE = input.partialFillTolerancePct != null
      ? Math.min(1, Math.max(0.5, input.partialFillTolerancePct / 100))
      : 0.999;

    // Never-throwing order info — used in recovery paths to learn actual fills.
    const safeInfo = async (txid: string) => {
      try { return await krakenOrderInfo(creds, txid); }
      catch { return { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 }; }
    };

    // ── Per-leg maker fill timers ─────────────────────────────────────────────
    // A post-only leg gets MAKER_LEG_TIMEOUT_MS to fill. On expiry: cancel,
    // read the ACTUAL final fill (it may have filled in the cancel race),
    // refresh the order book, re-check, and retry the REMAINDER at the fresh
    // join price — up to MAX_LEG_ATTEMPTS. No order ever waits indefinitely.
    // Poll at 1s — QueryOrders counts against Kraken's private rate limit.
    // Deadlines are WALL-CLOCK: limiter queuing/backoff stretches iterations.
    // Hybrid maker→taker execution (advisor-directed): give the post-only
    // limit ONE short window to fill at maker fees; if the market doesn't
    // come to us, cancel and complete the leg with a MARKET order rather
    // than missing the window. Leg 1 only falls back when the edge still
    // covers taker fees; legs 2/3 always complete at market — we already
    // hold inventory, and completing beats unwinding at the same taker cost.
    const MAKER_LEG_TIMEOUT_MS = input.makerTimeoutMs ?? 3_000; // fill-or-abort: 3s per maker window (2s on probes)
    // Leg 1 rests longer: no inventory is at risk before it fills, so give the
    // passive order a real chance to be hit — while the edge-recheck cancels
    // it early if the opportunity decays. Legs 2/3 keep the short window (we
    // hold inventory there; completing at market beats waiting).
    // Leg 1 reprice loop (trader-tuned): re-run pre-flight + re-place at the
    // most aggressive valid maker price every LEG1_REPRICE_MS; after
    // LEG1_MAX_REPRICES the leg is abandoned so the caller can fall through to
    // the next-best route. Total window derives from the two.
    // Server-side clamps — never trust client numbers for live orders.
    const LEG1_REPRICE_MS = input.edgeCheckMs != null
      ? Math.min(30_000, Math.max(500, Math.round(input.edgeCheckMs)))
      : 2_500;
    const LEG1_MAX_REPRICES = input.maxReprices != null
      ? Math.min(10, Math.max(1, Math.round(input.maxReprices)))
      : 4;
    const LEG1_MAX_REST_MS = input.leg1RestMs != null
      ? Math.min(120_000, Math.max(5_000, Math.round(input.leg1RestMs)))
      : (input.makerTimeoutMs ?? (LEG1_MAX_REPRICES + 1) * LEG1_REPRICE_MS);
    const MAX_LEG_ATTEMPTS = 1;
    interface AggFill { volExec: number; cost: number; fee: number; txid: string }
    const isFinal = (s: string) => s === "closed" || s === "canceled" || s === "expired";

    /**
     * Place a post-only leg and drive it to completion under the fill timer.
     * `beforeRetry` re-prices the leg from a FRESH order book (and, for leg 1,
     * re-runs the full pre-flight gate); returning null stops retries and the
     * caller's tolerance check + unwind takes over. Aggregates partial fills
     * across attempts. Throws only when NOTHING was placed/filled at all.
     */
    // Confirmed per-leg fill evidence for the ledger: ACTUAL exchange numbers
    // (volExec/cost/fee/txid), never scanner estimates.
    type LegFillRecord = { leg: number; label: string; pair: string; side: string; price: number | null; volume: number; costUsd: number; fee: number; txid: string; taker?: boolean; unwind?: boolean };
    const legFillRecords: LegFillRecord[] = [];
    failCtx.legFills = legFillRecords; // shared reference — mutated in place
    failCtx.expectedProfitUsd = pf.profitUsd;
    const fillLegRaw = async (
      legIndex: number, label: string,
      spec: { pair: string; side: "buy" | "sell"; volume: number; limitPrice: number },
      beforeRetry: () => Promise<number | null>,
      // Edge-aware resting + book chasing (leg 1 only): rest up to restMs
      // TOTAL, re-checking every EDGE_CHECK_EVERY_MS via freshLimit():
      //   null  → edge gone: cancel EARLY, stop.
      //   price → if the join price moved, cancel and RE-JOIN at the fresh
      //           price (still post-only/maker) — a stale resting order behind
      //           a drifted book never fills; chasing keeps us at the front.
      opts?: { restMs?: number; repriceMs?: number; maxReprices?: number; freshLimit?: () => Promise<{ price: number; bestBid?: number; bestAsk?: number; queueAheadVol?: number } | null> },
    ): Promise<AggFill> => {
      const restMs = opts?.restMs ?? MAKER_LEG_TIMEOUT_MS;
      const EDGE_CHECK_EVERY_MS = opts?.repriceMs ?? 2_500;
      const MAX_CHASES = opts?.maxReprices ?? 6; // re-joins within the SAME restMs window
      const legDeadline = Date.now() + restMs; // wall-clock cap across chases
      let chases = 0;
      let remaining = spec.volume;
      let limit = spec.limitPrice;
      const agg: AggFill = { volExec: 0, cost: 0, fee: 0, txid: "" };
      const pctOf = (v: number) => Math.min(100, (v / spec.volume) * 100);
      for (let attempt = 1; attempt <= MAX_LEG_ATTEMPTS; attempt++) {
        // A revoked run (KILL / HARD RESET / FORCE eviction) must never place
        // ANOTHER order — not even a chase re-join at a fresh price. The
        // resting poll loop catches revocation while an order rests, but a
        // revoke landing during the cancel-confirm window of a reprice would
        // otherwise slip through to the re-placement here. Confirmed fills
        // ride on the error so the caller unwinds ACTUAL inventory only.
        if (lockGen != null && !liveLockOwned(lockGen)) {
          throw new LockRevokedError(label, `aborted before ${chases > 0 ? "chase re-join" : "order placement"} — lock revoked, no new orders placed.`, agg.volExec > 0 ? agg : undefined);
        }
        setExecStatus({
          active: true, route, leg: legIndex, legLabel: `${label}: ${spec.side} ${spec.pair}`,
          pair: spec.pair, orderId: null, attempt, maxAttempts: MAX_LEG_ATTEMPTS,
          startedAtMs: Date.now(), timeoutMs: MAKER_LEG_TIMEOUT_MS,
          filledPct: pctOf(agg.volExec), phase: "placing order",
        });
        let txid = "";
        try {
          const r = await krakenRawLimitOrder(creds, spec.side, remaining, limit, spec.pair);
          txid = r.txid[0] ?? "";
        } catch (e) {
          // Post-only rejection (price moved through our limit) is routine —
          // re-price from a fresh book and retry instead of giving up.
          if (attempt < MAX_LEG_ATTEMPTS) {
            setExecStatus({ phase: "order rejected — refreshing book" });
            const freshPx = await beforeRetry();
            if (freshPx != null) { limit = freshPx; continue; }
          }
          if (agg.volExec > 0) return agg; // caller's tolerance check unwinds
          throw new Error(`${label} failed (no order placed): ${(e as Error).message}`);
        }
        agg.txid = txid;
        if (txid) failCtx.acceptedOrders.push({ leg: legIndex, label, pair: spec.pair, side: spec.side, txid });
        setExecStatus({ orderId: txid, phase: "waiting for fill" });
        const deadline = opts?.freshLimit ? legDeadline : Date.now() + restMs;
        let nextEdgeCheck = Date.now() + EDGE_CHECK_EVERY_MS;
        let edgeGone = false;
        let revoked = false;
        let repriceTo: number | null = null;
        let info = await safeInfo(txid);
        while (!isFinal(info.status) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1_000));
          info = await safeInfo(txid);
          setExecStatus({ filledPct: pctOf(agg.volExec + info.volExec) });
          // Cooperative KILL: if HARD RESET / KILL / FORCE eviction revoked our
          // lock while this order rests, cancel it and stop — no new orders.
          if (lockGen != null && !liveLockOwned(lockGen)) {
            log.info(`${label}: execution lock revoked while resting — cancelling order and aborting`);
            revoked = true;
            break;
          }
          if (opts?.freshLimit && Date.now() >= nextEdgeCheck && !isFinal(info.status)) {
            nextEdgeCheck = Date.now() + EDGE_CHECK_EVERY_MS;
            setExecStatus({ phase: "resting — re-checking edge" });
            const q = await opts.freshLimit();
            if (q == null) {
              log.info(`${label}: edge no longer clears the floor while resting — cancelling early`);
              edgeGone = true;
              break;
            }
            setExecStatus({ bestBid: q.bestBid ?? null, bestAsk: q.bestAsk ?? null, queueAheadVol: q.queueAheadVol ?? null, orderPrice: limit, reprices: chases });
            if (q.price !== limit && chases < MAX_CHASES && Date.now() < deadline - 2_000) {
              log.info(`${label}: repricing (${limit} → ${q.price}) — cancel and re-place at the most aggressive maker price`);
              repriceTo = q.price;
              break;
            }
            setExecStatus({ phase: "waiting for fill" });
          }
        }
        if (!isFinal(info.status)) {
          setExecStatus({ phase: edgeGone ? "edge gone — cancelling" : repriceTo != null ? "book moved — re-joining" : "fill timer expired — cancelling" });
          await tryCancel(creds, txid, label, log);
          // A cancel ACK is not terminal — the order can still fill in the
          // race. Poll until Kraken reports a TERMINAL status; if we can't
          // confirm, fail closed: no retry, no unwind on assumed volumes.
          const confirmDeadline = Date.now() + 10_000;
          info = await safeInfo(txid);
          while (!isFinal(info.status) && Date.now() < confirmDeadline) {
            await new Promise(r => setTimeout(r, 1_000));
            info = await safeInfo(txid);
          }
          if (!isFinal(info.status)) throw new IndeterminateOrderError(txid, label);
        }
        agg.volExec += info.volExec; agg.cost += info.cost; agg.fee += info.fee;
        remaining = spec.volume - agg.volExec;
        setExecStatus({ filledPct: pctOf(agg.volExec) });
        if (agg.volExec >= spec.volume * FILL_TOLERANCE) return agg; // filled
        if (revoked) throw new LockRevokedError(label, `order cancelled while resting; ${agg.volExec.toFixed(8)}/${spec.volume.toFixed(8)} confirmed filled — no fallback, no retry.`, agg);
        if (repriceTo != null) {
          // Chase: re-join at the fresh price for the REMAINDER. Does not
          // consume a retry attempt — bounded by MAX_CHASES + legDeadline.
          chases++;
          limit = repriceTo;
          attempt--;
          continue;
        }
        if (attempt >= MAX_LEG_ATTEMPTS) return agg;
        setExecStatus({ phase: "retrying — fresh book + pre-flight" });
        const freshPx = await beforeRetry();
        if (freshPx == null) {
          log.info(`${label}: retry abandoned (fresh book/pre-flight says no) — ${agg.volExec.toFixed(8)}/${spec.volume.toFixed(8)} filled`);
          return agg; // caller's tolerance check + unwind takes over
        }
        limit = freshPx;
      }
      return agg;
    };

    /** Market-complete a leg's remainder (taker fallback). Polls to a TERMINAL
     * status; throws IndeterminateOrderError if Kraken can't confirm one. */
    const fillLeg: typeof fillLegRaw = async (legIndex, label, spec, beforeRetry, opts) => {
      try {
        const agg = await fillLegRaw(legIndex, label, spec, beforeRetry, opts);
        if (agg.volExec > 0) legFillRecords.push({ leg: legIndex, label, pair: spec.pair, side: spec.side, price: agg.volExec > 0 ? agg.cost / agg.volExec : null, volume: agg.volExec, costUsd: agg.cost, fee: agg.fee, txid: agg.txid });
        return agg;
      } catch (e) {
        // A revoked run may still carry a CONFIRMED partial fill — keep the
        // evidence for the FAILED ledger row before rethrowing.
        if (e instanceof LockRevokedError && e.fill && e.fill.volExec > 0) {
          legFillRecords.push({ leg: legIndex, label: `${label} (revoked)`, pair: spec.pair, side: spec.side, price: e.fill.volExec > 0 ? e.fill.cost / e.fill.volExec : null, volume: e.fill.volExec, costUsd: e.fill.cost, fee: e.fill.fee, txid: e.fill.txid });
        }
        throw e;
      }
    };
    const marketFill = async (legIndex: number, label: string, side: "buy" | "sell", volume: number, pair: string, priceCap?: number): Promise<AggFill> => {
      // A revoked run (HARD RESET / KILL) must never place a NEW cycle-
      // advancing order. Residual sweeps are exempt — they SELL held inventory
      // back to USD, the same money-safest action a revoked-run unwind takes.
      if (!label.includes("sweep") && lockGen != null && !liveLockOwned(lockGen)) {
        throw new LockRevokedError(`leg${legIndex}`, `aborted before ${label} market order — lock revoked, no new orders placed.`);
      }
      setExecStatus({
        active: true, route, leg: legIndex, legLabel: `${label}: ${priceCap != null ? "IOC" : "MARKET"} ${side} ${pair} (taker fallback)`,
        pair, orderId: null, attempt: 1, maxAttempts: 1,
        startedAtMs: Date.now(), timeoutMs: 15_000, filledPct: 0, phase: "taker fallback",
      });
      // With a priceCap, use an IOC limit — crosses the spread like a market
      // order, but worst-case spend is HARD-BOUNDED at volume × priceCap.
      const r = priceCap != null
        ? await krakenRawIocLimitOrder(creds, side, volume, priceCap, pair)
        : await krakenRawMarketOrder(creds, side, volume, pair);
      const txid = r.txid[0] ?? "";
      if (txid) failCtx.acceptedOrders.push({ leg: legIndex, label: `${label} (taker)`, pair, side, txid });
      setExecStatus({ orderId: txid, phase: "confirming market fill" });
      const deadline = Date.now() + 15_000;
      let info = await safeInfo(txid);
      while (!isFinal(info.status) && Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 1_000));
        info = await safeInfo(txid);
      }
      if (!isFinal(info.status)) throw new IndeterminateOrderError(txid, `${label} market fallback`);
      log.info(`${label} taker fallback: market ${side} ${pair} filled ${info.volExec.toFixed(8)}/${volume.toFixed(8)} (${txid})`);
      if (info.volExec > 0) legFillRecords.push({ leg: legIndex, label, pair, side, price: info.volExec > 0 ? info.cost / info.volExec : null, volume: info.volExec, costUsd: info.cost, fee: info.fee, txid, taker: true });
      return { volExec: info.volExec, cost: info.cost, fee: info.fee, txid };
    };

    let leg1Id = "", leg2Id = "", leg3Id = "";
    let usdSpent = 0, usdReceived = 0, totalFees = 0;
    // USD recovered by sweeping tolerance-accepted residual inventory back to
    // USD at market (confirmed fills only) — counted into realized P&L.
    let residualSweepUsd = 0;
    // Set when a tolerance-accepted partial leaves NON-DUST residual inventory
    // that the sweep could not confirm flat — such a run must never be
    // recorded as "verified" (its USD delta doesn't reflect the full round
    // trip). Dust = residual ≤0.5% of the ordered leg volume.
    let unresolvedResidual = false;
    const DUST_FRAC = 0.005;

    // ── Leg 1: buy A with USD. Post-only limit at best bid → maker fee ────────
    // Retry gate: nothing is held yet, so a retry must survive a FULL fresh
    // pre-flight (route still profitable at the new prices), not just re-price.
    let aHeld = 0;
    {
      let f1: AggFill = { volExec: 0, cost: 0, fee: 0, txid: "" };
      try {
        if (takerOnly) throw new TakerOnlySkip(); // no maker attempt — straight to the gated taker path below
        // Aggressive maker pricing: place at the most aggressive VALID
        // post-only price (one tick inside the spread when possible) — front
        // of the queue instead of the back of the join-price level.
        // Tick-premium guard: improving one tick above the join price costs
        // (q.price − join) × volume. Only improve when the pre-flight profit
        // still clears the floor AFTER paying that premium; otherwise join.
        const tickPremiumUsd = (q: { price: number }) => Math.max(0, (q.price - l1.limitPrice) * l1.volume);
        const q0 = await makerQuote(l1.pair, l1.side);
        if (q0 && pf.profitUsd - tickPremiumUsd(q0) > threshold) {
          l1.limitPrice = q0.price;
          setExecStatus({ orderPrice: q0.price, bestBid: q0.bestBid, bestAsk: q0.bestAsk, queueAheadVol: q0.queueAheadVol, reprices: 0 });
        }
        f1 = await fillLeg(1, "leg1", l1, async () => {
          const fresh = await preflightObCycle(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, effectiveFeesPct, "maker");
          if (!fresh || fresh.profitUsd <= threshold) return null; // edge gone — stop retrying
          const q = await makerQuote(l1.pair, l1.side);
          return q?.price ?? fresh.legs[0].limitPrice;
        }, {
          // Leg 1 holds no inventory, so patience is free: rest the post-only
          // order up to LEG1_MAX_REST_MS, abort the MOMENT fresh books say the
          // cycle no longer clears the floor, and CHASE the join price when
          // the book drifts (a stale resting order never fills).
          restMs: LEG1_MAX_REST_MS,
          repriceMs: LEG1_REPRICE_MS,
          maxReprices: LEG1_MAX_REPRICES,
          // Full pre-flight before every reprice: null aborts (edge gone);
          // otherwise re-place at the freshest aggressive maker price.
          freshLimit: async () => {
            const fresh = await preflightObCycle(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, effectiveFeesPct, "maker");
            if (!fresh || fresh.profitUsd <= threshold) return null; // edge gone
            const q = await makerQuote(l1.pair, l1.side);
            if (!q) return { price: fresh.legs[0].limitPrice };
            // Tick-premium guard on repricing too: improve only when profit
            // still clears the floor at the improved price; else join.
            const premium = Math.max(0, (q.price - fresh.legs[0].limitPrice) * fresh.legs[0].volume);
            if (fresh.profitUsd - premium <= threshold) return { price: fresh.legs[0].limitPrice, bestBid: q.bestBid, bestAsk: q.bestAsk, queueAheadVol: q.queueAheadVol };
            return q;
          },
        });
      } catch (e) {
        if (e instanceof IndeterminateOrderError) throw e;
        if (e instanceof LockRevokedError) {
          // Revoked mid-rest: unwind any ACTUAL leg-1 fill (money-safest exit),
          // then abort — no taker fallback, no further legs.
          const v = e.fill?.volExec ?? 0;
          if (v > 0) await tryUnwindMarket(creds, "sell", v, pairA, `sell ${assetA} (unwind leg1 after lock revoked)`, log);
          throw e;
        }
        if (!(e instanceof TakerOnlySkip)) log.info(`leg1 maker attempt placed nothing (${(e as Error).message}) — evaluating taker fallback`);
      }
      leg1Id = f1.txid;
      aHeld = f1.volExec;
      usdSpent = f1.cost + f1.fee;
      totalFees += f1.fee;
      if (aHeld < l1.volume * FILL_TOLERANCE) {
        // Taker fallback gate (trader-directed): fire ONLY when the FRESH
        // taker-priced pre-flight (depth-walked, actual taker fee tier) still
        // clears the trader's profit floor. Otherwise abandon the route so the
        // caller can fall through to the next-best one.
        // A revoked run must not place NEW orders — re-verify lock ownership
        // immediately before the fallback order.
        if (lockGen != null && !liveLockOwned(lockGen)) {
          throw new LockRevokedError("leg1", "aborted before taker fallback — no new orders placed.");
        }
        const takerFeePct = tiers?.takerFeePct ?? effectiveFeesPct;
        const freshTaker = await preflightObCycle(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, takerFeePct, "taker", input.maxQuoteAgeMs);
        // Floor for the taker fire: taker mode adds the safety buffer on top
        // of the trader's minimum — fresh taker net must clear BOTH.
        const takerFloor = threshold + safetyBufferUsd;
        // Trader-directed "always taker" mode skips the profit-floor gate but
        // STILL requires a fresh taker pre-flight (books must be readable) —
        // firing blind into an unreadable book is never authorized. Never
        // applies in taker-only mode: there the fresh-calculation gate is the
        // whole point (trader-directed).
        const fireAnyway = !takerOnly && input.alwaysTakerFallback === true && !!freshTaker;
        if (freshTaker && (freshTaker.profitUsd > takerFloor || fireAnyway)) {
          if (freshTaker.profitUsd > takerFloor) {
            log.info(`leg1 taker ${takerOnly ? "fire" : "fallback"} firing — taker-priced net $${freshTaker.profitUsd.toFixed(4)} > floor $${threshold.toFixed(4)}${safetyBufferUsd > 0 ? ` + buffer $${safetyBufferUsd.toFixed(4)}` : ""}`);
          } else {
            log.info(`leg1 taker fallback firing (ALWAYS-TAKER override) — taker-priced net $${freshTaker.profitUsd.toFixed(4)} is BELOW floor $${threshold.toFixed(4)}; trader accepted fill-over-floor risk`);
          }
          // HARD-BOUND the USD spend: IOC limit capped 0.2% above the fresh
          // ask — a plain market buy has no spend ceiling if the book moves.
          const askPx = await freshJoinPrice(l1.pair, "sell"); // best ask
          const capPx = askPx != null && askPx > 0 ? askPx * 1.002 : undefined;
          const remVol = l1.volume - aHeld;
          // Re-size so worst-case spend (vol × cap × (1+fee)) stays ≈ tradeSize.
          const cappedVol = capPx != null ? Math.min(remVol, tradeSizeUsd / (capPx * (1 + takerFeePct / 100))) : remVol;
          const m = await marketFill(1, "leg1", l1.side, cappedVol, l1.pair, capPx);
          aHeld += m.volExec; usdSpent += m.cost + m.fee; totalFees += m.fee;
          leg1Id = [leg1Id, m.txid].filter(Boolean).join(",");
        } else {
          log.info(`leg1 taker ${takerOnly ? "fire" : "fallback"} declined — taker-priced net ${freshTaker ? `$${freshTaker.profitUsd.toFixed(4)}` : "unavailable"} ≤ floor $${threshold.toFixed(4)}${safetyBufferUsd > 0 ? ` + buffer $${safetyBufferUsd.toFixed(4)}` : ""}`);
        }
      }
      if (aHeld < l1.volume * FILL_TOLERANCE) {
        if (aHeld > 0) await tryUnwindMarket(creds, "sell", aHeld, pairA, `sell ${assetA} (unwind partial leg1)`, log);
        throw new Error(takerOnly
          ? `Leg 1 taker fire aborted — fresh taker-priced net (after real taker fees, depth slippage${safetyBufferUsd > 0 ? `, $${safetyBufferUsd.toFixed(4)} safety buffer` : ""}) ≤ your $${threshold.toFixed(4)} floor; no orders kept — trying the next-best route.`
          : `Leg 1 unfilled after ${LEG1_MAX_REPRICES} maker reprices (aggressive pricing, pre-flight each time) and taker fallback ${aHeld > 0 ? "left a shortfall" : "declined (taker-priced net ≤ your floor)"} (${aHeld.toFixed(8)}/${l1.volume.toFixed(8)} ${assetA}); order canceled — trying the next-best route.`);
      }
      legsCompleted = 1;
    }

    // Cooperative KILL check: if a HARD RESET / KILL revoked our lock while
    // leg 1 ran, stop BEFORE committing more capital. The throw routes into
    // the normal catch → actual-residual unwind (selling back what leg 1
    // bought is the money-safest exit even after a kill).
    if (lockGen != null && !liveLockOwned(lockGen)) {
      const unwound = aHeld > 0 ? await tryUnwindMarket(creds, "sell", aHeld, pairA, `sell ${assetA} (lock revoked before leg 2)`, log) : true;
      throw new Error(`Execution lock revoked (KILL/HARD RESET) — aborted before leg 2; leg 1 inventory ${unwound ? "unwound" : "UNWIND FAILED — position still held, reconcile manually"}.`);
    }

    // ── Leg 2: convert A → B on cross. Post-only limit at best bid/ask ───────
    // We already hold A, so retries just re-join the fresh top of book —
    // abandoning here means unwinding at market, which costs the spread anyway.
    const l2Volume = l2.volume * (aHeld / pf.volumeA); // scale to actual leg-1 fill
    let bHeld = 0;
    let f2: AggFill = { volExec: 0, cost: 0, fee: 0, txid: "" };
    try {
      if (takerOnly) throw new TakerOnlySkip(); // straight to the fresh-priced market completion below
      f2 = await fillLeg(2, "leg2", { ...l2, volume: l2Volume }, () => freshJoinPrice(l2.pair, l2.side));
      leg2Id = f2.txid;
    } catch (e) {
      // Indeterminate order state: the order may still be live/filling —
      // do NOT unwind on assumed volumes; surface for manual review.
      if (e instanceof IndeterminateOrderError) throw e;
      if (e instanceof LockRevokedError) {
        // Revoked mid-rest: unwind ACTUAL holdings only, then abort — no
        // taker fallback (that would be a NEW order on a revoked run).
        const fl = e.fill ?? { volExec: 0, cost: 0, fee: 0, txid: "" };
        const aConsumedR = cross.aIsQuote ? fl.cost + fl.fee : fl.volExec;
        const bAcquiredR = cross.aIsQuote ? fl.volExec : Math.max(0, fl.cost - fl.fee);
        const aResidualR = Math.max(0, aHeld - aConsumedR);
        if (aResidualR > 0) await tryUnwindMarket(creds, "sell", aResidualR, pairA, `sell residual ${assetA} (leg2 lock revoked)`, log);
        if (bAcquiredR > 0) await tryUnwindMarket(creds, "sell", bAcquiredR, pairB, `sell acquired ${assetB} (leg2 lock revoked)`, log);
        throw e;
      }
      // Nothing placed — fall through to the taker fallback below: we hold A,
      // and completing at market beats unwinding at market (same taker cost).
      if (!(e instanceof TakerOnlySkip)) log.info(`leg2 maker attempt placed nothing (${(e as Error).message}) — completing at market`);
    }
    {
      // Taker fallback: complete any remainder with a market order. We already
      // hold A, so this beats unwinding (same taker fee, backward). The order
      // is sized by the A THIS RUN still holds — never the original plan — so
      // it can never draw on pre-existing account inventory.
      if (f2.volExec < l2Volume * FILL_TOLERANCE) {
        try {
          const takerFeeFrac = (tiers?.takerFeePct ?? effectiveFeesPct) / 100;
          let fbVolume = 0;
          let fbPriceCap: number | undefined;
          if (cross.aIsQuote) {
            // buy B priced in A: budget = remaining A after the maker portion
            // (cost+fee are in A — fciq guarantees fee in quote). A plain
            // market buy has NO max quote spend, so use an IOC limit with an
            // explicit price cap: worst-case spend = fbVolume × cap × (1+fee),
            // sized to stay within remainingA. Never draws pre-existing A.
            const remainingA = Math.max(0, aHeld - (f2.cost + f2.fee));
            const px = await freshJoinPrice(l2.pair, l2.side);
            if (px != null && px > 0) {
              fbPriceCap = px * 1.002; // cross the spread, but bounded
              fbVolume = Math.min(l2Volume - f2.volExec, (remainingA * (1 - takerFeeFrac) * 0.999) / fbPriceCap);
            }
          } else {
            // sell A: volume is A units — cap at the A this run still holds.
            const remainingA = Math.max(0, aHeld - f2.volExec);
            fbVolume = Math.min(l2Volume - f2.volExec, remainingA);
          }
          if (fbVolume > 0) {
            const m = await marketFill(2, "leg2", l2.side, fbVolume, l2.pair, fbPriceCap);
            f2.volExec += m.volExec; f2.cost += m.cost; f2.fee += m.fee;
            leg2Id = [leg2Id, m.txid].filter(Boolean).join(",");
          }
        } catch (e) {
          if (e instanceof IndeterminateOrderError) throw e;
          log.error(`leg2 taker fallback failed: ${(e as Error).message}`);
        }
      }
      // aIsQuote → bought base B: volExec = B acquired, cost+fee = A consumed.
      // else     → sold base A:   volExec = A consumed, cost−fee = B received.
      const aConsumed = cross.aIsQuote ? f2.cost + f2.fee : f2.volExec;
      bHeld = cross.aIsQuote ? f2.volExec : Math.max(0, f2.cost - f2.fee);
      const fullFill = f2.volExec >= l2Volume * FILL_TOLERANCE;
      if (!fullFill) {
        // Unwind BOTH residuals from actual fills: leftover A + acquired B.
        const aResidual = Math.max(0, aHeld - aConsumed);
        if (aResidual > 0) await tryUnwindMarket(creds, "sell", aResidual, pairA, `sell residual ${assetA} (partial leg2)`, log);
        if (bHeld > 0)     await tryUnwindMarket(creds, "sell", bHeld,     pairB, `sell acquired ${assetB} (partial leg2)`, log);
        throw new Error(`Leg 2 did not fully fill (${f2.volExec.toFixed(8)}/${l2Volume.toFixed(8)}); residual ${assetA} and acquired ${assetB} unwound.`);
      }
      // Cross-leg fee is charged in A or B units and is implicitly captured in
      // the final USD delta (less B acquired → less USD out), so it is not
      // added to totalFees (which tracks USD-denominated fees only).
      if (bHeld <= 0) {
        throw new Error("Leg 2 reported zero acquired volume despite full fill.");
      }
      // Tolerance-accepted partial: the cycle proceeds sized to bHeld, but any
      // leftover A must not sit as inventory — sweep it back to USD at market
      // with a confirmed fill so the proceeds count in realized P&L. Dust below
      // Kraken's min order size just stays (cheaper than the error).
      {
        const aResidual = Math.max(0, aHeld - aConsumed);
        if (aResidual > 0 && f2.volExec < l2Volume) {
          let sweptA = 0;
          try {
            const sw = await marketFill(2, "leg2 residual sweep", "sell", aResidual, pairA);
            residualSweepUsd += Math.max(0, sw.cost - sw.fee);
            totalFees += sw.fee;
            sweptA = sw.volExec;
          } catch (e) {
            if (e instanceof IndeterminateOrderError) throw e;
            log.info(`leg2 residual sweep failed (${aResidual.toFixed(8)} ${assetA}): ${(e as Error).message}`);
          }
          // Anything above dust left unswept → the trade cannot be verified.
          if (aResidual - sweptA > aHeld * DUST_FRAC) {
            unresolvedResidual = true;
            log.error(`leg2 residual UNRESOLVED: ${(aResidual - sweptA).toFixed(8)} ${assetA} remains on account — trade will be recorded as estimated, not verified`);
          }
        }
      }
      legsCompleted = 2;
    }

    // Cooperative KILL check before the final leg (see leg-2 check above).
    if (lockGen != null && !liveLockOwned(lockGen)) {
      const unwound = bHeld > 0 ? await tryUnwindMarket(creds, "sell", bHeld, pairB, `sell ${assetB} (lock revoked before leg 3)`, log) : true;
      throw new Error(`Execution lock revoked (KILL/HARD RESET) — aborted before leg 3; held inventory ${unwound ? "unwound" : "UNWIND FAILED — position still held, reconcile manually"}.`);
    }

    // ── Leg 3: sell B for USD. Post-only limit at best ask → maker fee ───────
    let f3: AggFill = { volExec: 0, cost: 0, fee: 0, txid: "" };
    try {
      if (takerOnly) throw new TakerOnlySkip(); // straight to the market completion below
      f3 = await fillLeg(3, "leg3", { ...l3, volume: bHeld }, () => freshJoinPrice(l3.pair, l3.side));
      leg3Id = f3.txid;
    } catch (e) {
      // Indeterminate order state: do NOT unwind on assumed volumes.
      if (e instanceof IndeterminateOrderError) throw e;
      if (e instanceof LockRevokedError) {
        // Revoked mid-rest on the final leg: selling the remaining B is the
        // unwind itself — do it, then abort with the revocation surfaced.
        const soldR = e.fill?.volExec ?? 0;
        const bRemaining = Math.max(0, bHeld - soldR);
        if (bRemaining > 0) await tryUnwindMarket(creds, "sell", bRemaining, pairB, `sell remaining ${assetB} (leg3 lock revoked)`, log);
        throw e;
      }
      // Nothing placed — fall through to the taker fallback: selling B at
      // market IS the intended trade here, not an unwind.
      if (!(e instanceof TakerOnlySkip)) log.info(`leg3 maker attempt placed nothing (${(e as Error).message}) — completing at market`);
    }
    {
      // Taker fallback: sell any remaining B at market — identical action to
      // the "unwind", but accounted as completing the cycle.
      if (f3.volExec < bHeld * FILL_TOLERANCE) {
        try {
          const m = await marketFill(3, "leg3", l3.side, bHeld - f3.volExec, l3.pair);
          f3.volExec += m.volExec; f3.cost += m.cost; f3.fee += m.fee;
          leg3Id = [leg3Id, m.txid].filter(Boolean).join(",");
        } catch (e) {
          if (e instanceof IndeterminateOrderError) throw e;
          log.error(`leg3 taker fallback failed: ${(e as Error).message}`);
        }
      }
      usdReceived = Math.max(0, f3.cost - f3.fee) + residualSweepUsd;
      totalFees += f3.fee;
      const bResidual = Math.max(0, bHeld - f3.volExec);
      if (f3.volExec < bHeld * FILL_TOLERANCE) {
        // Sell the residual B; report as a partial (failed) execution, not success.
        if (bResidual > 0) await tryUnwindMarket(creds, "sell", bResidual, pairB, `sell residual ${assetB} (partial leg3)`, log);
        throw new Error(`Leg 3 partially filled (${f3.volExec.toFixed(8)}/${bHeld.toFixed(8)} ${assetB}); residual sold via unwind. USD received so far: $${usdReceived.toFixed(4)}.`);
      }
      // Tolerance-accepted partial: sweep leftover B to USD at market with a
      // confirmed fill so proceeds count in realized P&L (dust just stays).
      if (bResidual > 0) {
        let sweptB = 0;
        try {
          const sw = await marketFill(3, "leg3 residual sweep", "sell", bResidual, pairB);
          usdReceived += Math.max(0, sw.cost - sw.fee);
          totalFees += sw.fee;
          sweptB = sw.volExec;
        } catch (e) {
          if (e instanceof IndeterminateOrderError) throw e;
          log.info(`leg3 residual sweep failed (${bResidual.toFixed(8)} ${assetB}): ${(e as Error).message}`);
        }
        if (bResidual - sweptB > bHeld * DUST_FRAC) {
          unresolvedResidual = true;
          log.error(`leg3 residual UNRESOLVED: ${(bResidual - sweptB).toFixed(8)} ${assetB} remains on account — trade will be recorded as estimated, not verified`);
        }
      }
      legsCompleted = 3;
    }

    // Realized P&L from actual fills, fee-inclusive (cost fields exclude fees;
    // usdSpent includes leg1 fee, usdReceived deducts leg3 fee).
    // VERIFIED requires proof: all 3 legs completed, exchange order IDs for
    // every leg, and real USD in/out from confirmed fills. Anything less is
    // recorded as "estimated" — it NEVER counts toward realized P&L.
    // VERIFIED requires actual per-leg fill evidence — every one of the 3
    // legs must have a confirmed fill record with a real txid and volume —
    // not just bookkeeping flags and order IDs.
    const legEvidence = (leg: number) => legFillRecords.some(f => f.leg === leg && !f.unwind && f.volume > 0 && !!f.txid);
    const fullyVerified = legsCompleted === 3 && !!leg1Id && !!leg2Id && !!leg3Id && usdSpent > 0 && usdReceived > 0
      && legEvidence(1) && legEvidence(2) && legEvidence(3)
      // A tolerance-accepted partial with non-dust inventory left on account
      // has an incomplete USD round trip — never "verified" realized P&L.
      && !unresolvedResidual;
    const realizedProfit = usdSpent > 0 && usdReceived > 0 ? usdReceived - usdSpent : pf.profitUsd;
    await db.insert(tradesTable).values({
      pair: route,
      buyExchange: "kraken",
      sellExchange: "kraken",
      volume: aHeld.toFixed(8),
      estimatedProfitUsd: pf.profitUsd.toFixed(6), // scanner/pre-flight expectation — never realized
      netEdgePct: usdSpent > 0 ? ((realizedProfit / usdSpent) * 100).toFixed(4) : ((pf.profitUsd / tradeSizeUsd) * 100).toFixed(4),
      isDryRun: false,
      krakenPrice: "0",
      coinbasePrice: "0",
      buyOrderId: leg1Id || null,
      sellOrderId: leg3Id || null,
      status: fullyVerified ? "verified" : "estimated",
      realizedProfitUsd: fullyVerified ? realizedProfit.toFixed(6) : null,
      legFills: legFillRecords,
    });
    reqLog.info({ route, tradeSizeUsd, realizedProfit, usdSpent, usdReceived, totalFees, leg1Id, leg2Id, leg3Id }, "OB manual execute LIVE");
    return { body: { success: true, isDryRun: false, executed: true, route, preflightProfitUsd: realizedProfit, leg1OrderId: leg1Id, leg2OrderId: leg2Id, leg3OrderId: leg3Id, legsFilled: legsCompleted } };
  } catch (err) {
    reqLog.error({ err, route }, "OB manual execute error");
    // FAILED ledger row — a live route that placed ANY order but did not
    // complete is recorded as failed (with its confirmed fills + order IDs for
    // reconciliation), never as a profitable trade.
    if (!isDryRun && (failCtx.legFills.length > 0 || failCtx.acceptedOrders.length > 0)) {
      try {
        const l1Fills = failCtx.legFills.filter(f => f.leg === 1);
        const l3Fills = failCtx.legFills.filter(f => f.leg === 3);
        // Include accepted-but-unconfirmed orders (zero fill / indeterminate)
        // as zero-volume evidence rows so no accepted order vanishes.
        const filledTxids = new Set(failCtx.legFills.map(f => f.txid));
        const acceptedOnly = failCtx.acceptedOrders
          .filter(o => !filledTxids.has(o.txid))
          .map(o => ({ leg: o.leg, label: `${o.label} (accepted, no confirmed fill)`, pair: o.pair, side: o.side, price: null, volume: 0, costUsd: 0, fee: 0, txid: o.txid }));
        await db.insert(tradesTable).values({
          pair: `${route} [FAILED: ${(err as Error).message.slice(0, 120)}]`,
          buyExchange: "kraken", sellExchange: "kraken",
          volume: l1Fills.reduce((s, f) => s + f.volume, 0).toFixed(8),
          estimatedProfitUsd: failCtx.expectedProfitUsd.toFixed(6),
          netEdgePct: "0",
          isDryRun: false, krakenPrice: "0", coinbasePrice: "0",
          buyOrderId: (l1Fills.map(f => f.txid).filter(Boolean).join(",") || failCtx.acceptedOrders.filter(o => o.leg === 1).map(o => o.txid).join(",")) || null,
          sellOrderId: (l3Fills.map(f => f.txid).filter(Boolean).join(",") || failCtx.acceptedOrders.filter(o => o.leg === 3).map(o => o.txid).join(",")) || null,
          // Zero confirmed fills → nothing moved → realized is exactly $0.
          // With partial fills the net USD effect is unknown (unwinds aren't
          // reconciled yet) → null, rendered as "—", never an estimate.
          realizedProfitUsd: failCtx.legFills.length === 0 ? "0" : null,
          status: "failed", legFills: [...failCtx.legFills, ...acceptedOnly],
        });
      } catch (e) { reqLog.error(`Failed to write FAILED ledger row: ${(e as Error).message}`); }
    }
    // Indeterminate leg-1 order: Kraken never confirmed a terminal status, so
    // the leg may STILL fill — recording 0 would assert a failure we can't
    // prove. Keep the diagnostic null (unknown) rather than a false zero.
    // Later-leg indeterminacy keeps the last CONFIRMED count, which is true.
    const legsForRecord = err instanceof IndeterminateOrderError && legsCompleted === 0 ? null : legsCompleted;
    return { body: { success: false, isDryRun, executed: false, route, preflightProfitUsd: null, error: (err as Error).message, legsFilled: legsForRecord } };
  } finally {
    // Only the CURRENT lock holder may reset shared state — the generation
    // token makes this a no-op if this run was stale-evicted and a newer
    // execution now owns the lock. An ADOPTED lock (heldLockGen) is released
    // by its owning caller, not here.
    if (ownsLock && lockGen != null) releaseLiveLock(lockGen);
  }
}

// ── POST /arb/graph-execute ───────────────────────────────────────────────────
// Execute button for the Opportunity Engine. Re-runs a FRESH graph scan
// (pre-flight), locates the requested route (or the top route), and gates on
// fresh net profit > minProfitUsd. Two executable shapes:
//   • Kraken-only triangle (3 kraken hops) — delegates to the same 3-leg
//     post-only limit machinery as ob-execute (full-fill confirm + unwind).
//   • Cross-exchange inventory route (2 real hops + bridge, e.g.
//     USD[K]→X[K]→X[CB]→USD[CB]) — buys X on one venue and sells X on the
//     other simultaneously (market orders; requires inventory on both venues).
// Anything else executes as dry-run only.
// ── GET /arb/execution-quality ────────────────────────────────────────────────
// Per route+style aggregates of recorded execution attempts: fill rate and
// expected-vs-realized profit — the data that separates routes that LOOK
// profitable from routes that actually PAY.
router.get("/arb/execution-quality", async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(executionQualityTable)
      .orderBy(dbDesc(executionQualityTable.id)).limit(1000);
    const byKey = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.route}|${r.style}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(r);
    }
    const routes = Array.from(byKey.entries()).map(([key, rs]) => {
      const [route, style] = key.split("|") as [string, string];
      const live = rs.filter(r => !r.isDryRun);
      const liveFilled = live.filter(r => r.filled);
      const realized = liveFilled.filter(r => r.realizedProfitUsd != null);
      const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      const avgExpected = avg(realized.map(r => parseFloat(r.expectedProfitUsd)));
      const avgRealized = avg(realized.map(r => parseFloat(r.realizedProfitUsd!)));
      const slipRows = rs.filter(r => r.slippagePct != null);
      const avgSlippagePct = avg(slipRows.map(r => parseFloat(r.slippagePct!)));
      // Per-leg diagnostics: WHERE do live runs die? Only rows recorded after
      // leg tracking began carry legsFilled; older rows are excluded from the
      // denominator instead of being counted as leg failures.
      const legRows = live.filter(r => r.legsFilled != null);
      const legRate = (n: number) => legRows.length ? legRows.filter(r => (r.legsFilled ?? 0) >= n).length / legRows.length : null;
      // Conditional completion rates — the loss pattern is leg 1 filling and
      // leg 2 dying, which full-cycle rate alone hides.
      const l1Rows = legRows.filter(r => (r.legsFilled ?? 0) >= 1);
      const l2Rows = l1Rows.filter(r => (r.legsFilled ?? 0) >= 2);
      const l3Rows = l2Rows.filter(r => (r.legsFilled ?? 0) >= 3);
      const unwindLosses = l1Rows.filter(r => !r.filled && r.realizedProfitUsd != null)
        .map(r => Math.max(0, -parseFloat(r.realizedProfitUsd!)));
      const allRealized = live.filter(r => r.realizedProfitUsd != null);
      return {
        leg2GivenLeg1Rate: l1Rows.length ? l2Rows.length / l1Rows.length : null,
        leg3GivenLeg12Rate: l2Rows.length ? l3Rows.length / l2Rows.length : null,
        avgUnwindLossUsd: unwindLosses.length ? unwindLosses.reduce((a, b) => a + b, 0) / unwindLosses.length : null,
        realizedPnlUsd: allRealized.length ? allRealized.reduce((s, r) => s + parseFloat(r.realizedProfitUsd!), 0) : null,
        route, style,
        attempts: rs.length,
        liveAttempts: live.length,
        liveFillRate: live.length > 0 ? liveFilled.length / live.length : null,
        avgExpectedProfitUsd: avgExpected,
        avgRealizedProfitUsd: avgRealized,
        avgShortfallUsd: avgExpected != null && avgRealized != null ? avgExpected - avgRealized : null,
        avgSlippagePct,
        totalRealizedProfitUsd: realized.length ? realized.reduce((s, r) => s + parseFloat(r.realizedProfitUsd!), 0) : null,
        lastAttemptAt: rs[0]!.createdAt.toISOString(),
        legsTracked: legRows.length,
        leg1FillRate: legRate(1),
        leg2FillRate: legRate(2),
        leg3FillRate: legRate(3),
      };
    }).sort((a, b) => b.attempts - a.attempts).slice(0, 50);
    res.json({ routes, totalRecords: rows.length });
  } catch (err) {
    req.log.error({ err }, "execution-quality error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Execution-quality feedback loop ──────────────────────────────────────────
// Every execution ATTEMPT is recorded (expected vs realized, filled or not).
// The gate consults this history: routes whose realized profit historically
// falls short of the scanner's expectation must clear a correspondingly
// higher bar before real money is committed again.

async function recordQuality(row: {
  route: string; style: string; isDryRun: boolean; filled: boolean;
  tradeSizeUsd: number; expectedProfitUsd: number; realizedProfitUsd: number | null; slippagePct?: number; note?: string;
  /** Legs confirmed filled (0–3); null when unknown (dry runs, non-triangle routes) */
  legsFilled?: number | null;
  /** sha256-prefix scope of the executing Kraken key (accountIdFromKey(krakenKey)); "legacy" when unknown */
  accountId?: string;
}, log: { error: (o: object, m: string) => void }): Promise<void> {
  try {
    await db.insert(executionQualityTable).values({
      accountId: row.accountId ?? "legacy",
      route: row.route, style: row.style, isDryRun: row.isDryRun, filled: row.filled,
      tradeSizeUsd: row.tradeSizeUsd.toFixed(2),
      expectedProfitUsd: row.expectedProfitUsd.toFixed(6),
      realizedProfitUsd: row.realizedProfitUsd != null ? row.realizedProfitUsd.toFixed(6) : null,
      slippagePct: row.slippagePct != null ? row.slippagePct.toFixed(4) : null,
      legsFilled: row.legsFilled ?? null,
      note: row.note ?? null,
    });
  } catch (err) { log.error({ err }, "failed to record execution quality"); }
  // Consecutive-failure blacklist bookkeeping (live executions only).
  if (!row.isDryRun) await noteRouteLiveResult(row.accountId ?? "legacy", row.style, row.route, row.filled);
}

// Feedback-loop gate tuning (advisor-reviewed):
const GATE_MIN_ATTEMPTS = 10;        // don't blacklist on a thin sample — 3 misses can just be a fast market
const GATE_MIN_FILL_RATE = 0.5;      // block when fewer than half of attempts ever fill
const GATE_DECAY_MS = 5 * 60_000;    // 5 min since last attempt → penalty decays, route earns a fresh probe
const GATE_BIG_EDGE_MULT = 2;        // current edge > 2× the route's historical avg expected edge → treat as a NEW opportunity, never block
const PROBE_MAKER_TIMEOUT_MS = 2_000; // low-fill-rate probe attempts get a tighter 2s maker window
// One probe per route per decay window: a 0/10 route still gets ONE fresh
// attempt (with the tighter timer) instead of being blocked outright.
// PERSISTED in route_gate_state (lastProbeAtMs) so restarts don't hand out
// fresh probes; the Map is a per-process fallback for DB outages only.
const routeProbeAt = new Map<string, number>();

/**
 * Atomically claim the one-per-decay-window probe for a route. The claim is a
 * conditional DB upsert, so two processes racing for the same window can never
 * both win. Returns whether the probe was granted and the previous probe time
 * (for the block message when denied).
 */
async function claimRouteProbe(accountId: string, style: string, route: string): Promise<{ claimed: boolean; lastProbeAt: number }> {
  const now = Date.now();
  const key = streakKey(accountId, style, route);
  try {
    const rows = await db.insert(routeGateStateTable)
      .values({ accountId, style, route, lastProbeAtMs: now })
      .onConflictDoUpdate({
        target: [routeGateStateTable.accountId, routeGateStateTable.style, routeGateStateTable.route],
        set: { lastProbeAtMs: now, updatedAt: new Date() },
        setWhere: sql`${routeGateStateTable.lastProbeAtMs} <= ${now - GATE_DECAY_MS}`,
      })
      .returning({ lastProbeAtMs: routeGateStateTable.lastProbeAtMs });
    if (rows.length > 0) { // insert happened OR the conditional update fired
      routeProbeAt.set(key, now);
      return { claimed: true, lastProbeAt: now };
    }
    // Claim denied — read the standing probe time for the block message.
    const [row] = await db.select({ lastProbeAtMs: routeGateStateTable.lastProbeAtMs })
      .from(routeGateStateTable).where(routeGateWhere(accountId, style, route)).limit(1);
    const last = row?.lastProbeAtMs ?? routeProbeAt.get(key) ?? 0;
    routeProbeAt.set(key, last);
    return { claimed: false, lastProbeAt: last };
  } catch {
    // DB unavailable — degrade to the old per-process cool-down.
    const last = routeProbeAt.get(key) ?? 0;
    if (now - last >= GATE_DECAY_MS) { routeProbeAt.set(key, now); return { claimed: true, lastProbeAt: now }; }
    return { claimed: false, lastProbeAt: last };
  }
}

/**
 * Batch live fill-rate stats per route for one execution style, over each
 * route's newest ≤20 live attempts (same window the gate uses). One query
 * for the whole scan — never per-route.
 */
async function routeFillStats(style: string, accountId: string): Promise<Map<string, { liveAttempts: number; fillRate: number }>> {
  const out = new Map<string, { liveAttempts: number; fillRate: number }>();
  try {
    // STRICTLY account-scoped: one account's fill history must never rank
    // another account's routes. Pre-scoping "legacy" rows have an UNKNOWN
    // owner, so they are excluded too — an unattributable history must not
    // influence any trader's ranking or gates (neutral prior applies until
    // the account builds its own history).
    const rows = await db.select({ route: executionQualityTable.route, filled: executionQualityTable.filled })
      .from(executionQualityTable)
      .where(dbAnd(dbEq(executionQualityTable.style, style), dbEq(executionQualityTable.isDryRun, false),
        dbEq(executionQualityTable.accountId, accountId)))
      .orderBy(dbDesc(executionQualityTable.id)).limit(2000);
    const grouped = new Map<string, boolean[]>();
    for (const r of rows) {
      const g = grouped.get(r.route) ?? [];
      if (g.length < 20) { g.push(r.filled); grouped.set(r.route, g); }
    }
    for (const [route, fills] of grouped) {
      out.set(route, { liveAttempts: fills.length, fillRate: fills.filter(Boolean).length / fills.length });
    }
  } catch { /* stats are advisory — a DB hiccup must not fail the scan */ }
  return out;
}

/**
 * Historical penalty for a route+style, from LIVE attempts only:
 *  - shortfallUsd: average (expected − realized) across filled live attempts
 *    (≥2 samples) — added to the edge the route must clear.
 *  - blockReason: set when the route has ≥GATE_MIN_ATTEMPTS live attempts,
 *    <GATE_MIN_FILL_RATE ever filled, AND the streak is recent — history says
 *    this opportunity doesn't actually execute. Blocks decay: once the last
 *    attempt is over an hour old, the route gets one fresh probe.
 */
async function routeQualityPenalty(route: string, style: string, tradeSizeUsd: number, accountId: string, currentNetUsd = 0, allowProbe = false): Promise<{ shortfallUsd: number; attempts: number; blockReason: string | null; bigEdgeBypass: boolean; probe: boolean }> {
  try {
    const rows = await db.select().from(executionQualityTable)
      .where(dbAnd(dbEq(executionQualityTable.route, route), dbEq(executionQualityTable.style, style), dbEq(executionQualityTable.isDryRun, false),
        dbEq(executionQualityTable.accountId, accountId)))
      .orderBy(dbDesc(executionQualityTable.id)).limit(20);
    if (rows.length === 0) return { shortfallUsd: 0, attempts: 0, blockReason: null, bigEdgeBypass: false, probe: false };
    const fills = rows.filter(r => r.filled);
    // Historical average EXPECTED edge, normalized per trade size and scaled
    // to the CURRENT size. If today's edge is > 2× that average, the market
    // moved — treat it as a NEW opportunity and never block on history.
    const sized = rows.filter(r => parseFloat(r.tradeSizeUsd) > 0);
    const avgEdgeUsd = sized.length > 0
      ? (sized.reduce((s, r) => s + parseFloat(r.expectedProfitUsd) / parseFloat(r.tradeSizeUsd), 0) / sized.length) * tradeSizeUsd
      : 0;
    const bigEdgeBypass = avgEdgeUsd > 0 && currentNetUsd > GATE_BIG_EDGE_MULT * avgEdgeUsd;
    if (bigEdgeBypass) return { shortfallUsd: 0, attempts: rows.length, blockReason: null, bigEdgeBypass: true, probe: false };
    const lastAttemptAt = rows[0]?.createdAt ? new Date(rows[0].createdAt).getTime() : 0;
    const recentStreak = Date.now() - lastAttemptAt < GATE_DECAY_MS;
    if (rows.length >= GATE_MIN_ATTEMPTS && fills.length / rows.length < GATE_MIN_FILL_RATE && recentStreak) {
      // Even a 0/10 route earns ONE probe per decay window: a single attempt
      // under a tighter 2s maker timer. If it doesn't fill, the failure is
      // recorded and the block resumes until the next window.
      if (allowProbe) {
        const probe = await claimRouteProbe(accountId, style, route);
        if (probe.claimed) return { shortfallUsd: 0, attempts: rows.length, blockReason: null, bigEdgeBypass: false, probe: true };
        return { shortfallUsd: 0, attempts: rows.length, blockReason: `historical fill rate ${fills.length}/${rows.length} (needs ≥${Math.round(GATE_MIN_FILL_RATE * 100)}% over ≥${GATE_MIN_ATTEMPTS} attempts) — this route rarely executes; not committing funds. Next 2s probe in ≤${Math.ceil((GATE_DECAY_MS - (Date.now() - probe.lastProbeAt)) / 60_000)} min; block decays ${GATE_DECAY_MS / 60_000} min after the last attempt.`, bigEdgeBypass: false, probe: false };
      }
      const lastProbe = routeProbeAt.get(streakKey(accountId, style, route)) ?? 0;
      return { shortfallUsd: 0, attempts: rows.length, blockReason: `historical fill rate ${fills.length}/${rows.length} (needs ≥${Math.round(GATE_MIN_FILL_RATE * 100)}% over ≥${GATE_MIN_ATTEMPTS} attempts) — this route rarely executes; not committing funds. Next 2s probe in ≤${Math.ceil((GATE_DECAY_MS - (Date.now() - lastProbe)) / 60_000)} min; block decays ${GATE_DECAY_MS / 60_000} min after the last attempt.`, bigEdgeBypass: false, probe: false };
    }
    const realized = fills.filter(r => r.realizedProfitUsd != null && parseFloat(r.tradeSizeUsd) > 0);
    if (realized.length < 2) return { shortfallUsd: 0, attempts: rows.length, blockReason: null, bigEdgeBypass: false, probe: false };
    // Normalize shortfall by each attempt's trade size, then scale to the
    // CURRENT size — a $5 miss on a $1,000 trade must not block a $10 trade.
    const avgShortfallPct = realized.reduce((s, r) =>
      s + (parseFloat(r.expectedProfitUsd) - parseFloat(r.realizedProfitUsd!)) / parseFloat(r.tradeSizeUsd), 0) / realized.length;
    return { shortfallUsd: Math.max(0, avgShortfallPct * tradeSizeUsd), attempts: rows.length, blockReason: null, bigEdgeBypass: false, probe: false };
  } catch { return { shortfallUsd: 0, attempts: 0, blockReason: null, bigEdgeBypass: false, probe: false }; }
}

// ── Leg-conditional risk model ────────────────────────────────────────────────
// Full-cycle fill rate alone hides the expensive failure mode: leg 1 fills,
// leg 2 dies, and the unwind eats fees+spread (observed −$0.16..−$0.18 on $10).
// This models the cycle leg by leg from recorded live attempts.
const RISK_MIN_SAMPLES = 5;            // don't risk-gate on fewer live leg-tracked attempts
const LEG2_COND_BLOCK_RATE = 0.5;      // block when leg2|leg1 completion < 50% (≥5 conditional samples)
const DEFAULT_UNWIND_LOSS_FRAC = 0.015; // no measured unwind losses yet → assume 1.5% of size (matches observed)


/** PROFITABILITY SAFEGUARD (2026-08-08 audit): maker attempts must clearly exceed
 *  the historical completion/unwind cost (~$0.23 realized on $10; 9/9 verified
 *  live maker fills at thin edges lost money). Single source of truth so live
 *  execution, adaptive choice, legacy triangular, and previews all agree. */
function makerFloorUsd(tradeSizeUsd: number, minProfitUsd: number): number {
  return Math.max(minProfitUsd, 0.25, tradeSizeUsd * 0.025);
}

interface RouteLegRisk {
  samples: number;            // live attempts with leg tracking
  pLeg1: number;              // smoothed P(leg1 fills)
  pLeg2Given1: number;        // smoothed P(leg2 | leg1)
  pLeg3Given12: number;       // smoothed P(leg3 | leg1+2)
  leg2CondSamples: number;    // raw conditional sample count (attempts that filled leg1)
  leg2CondRateRaw: number;    // raw leg2|leg1 rate (no smoothing) — used for the hard block
  avgUnwindLossUsd: number | null; // avg realized loss on failure-after-leg1 rows (measured only)
  totalRealizedUsd: number;   // sum of realized P&L across live attempts (incl. losses)
  realizedSamples: number;    // live attempts with a measured realized P&L
  avgRealizedUsd: number | null; // mean realized P&L across those attempts
  lastAttemptAtMs: number;
}

/** Leg-conditional fill stats for one route+style from its newest ≤20 live
 *  leg-tracked attempts. Laplace-smoothed ((k+1)/(n+2)) so thin samples never
 *  produce a hard 0 or 1. */
async function routeLegRisk(route: string, style: string, accountId: string): Promise<RouteLegRisk | null> {
  try {
    const rows = await db.select().from(executionQualityTable)
      .where(dbAnd(dbEq(executionQualityTable.route, route), dbEq(executionQualityTable.style, style), dbEq(executionQualityTable.isDryRun, false),
        dbEq(executionQualityTable.accountId, accountId)))
      .orderBy(dbDesc(executionQualityTable.id)).limit(20);
    const legRows = rows.filter(r => r.legsFilled != null);
    if (legRows.length === 0) return null;
    const n = legRows.length;
    const l1 = legRows.filter(r => (r.legsFilled ?? 0) >= 1);
    const l2 = l1.filter(r => (r.legsFilled ?? 0) >= 2);
    const l3 = l2.filter(r => (r.legsFilled ?? 0) >= 3);
    const smooth = (k: number, m: number) => (k + 1) / (m + 2);
    // Measured unwind cost: realized loss on attempts that filled leg1 but not
    // the cycle. Most failed rows carry realized null (unreconciled) — only
    // measured numbers count; caller falls back to a conservative default.
    const unwindRows = l1.filter(r => !r.filled && r.realizedProfitUsd != null);
    const unwindLosses = unwindRows.map(r => Math.max(0, -parseFloat(r.realizedProfitUsd!)));
    const realizedRows = legRows.filter(r => r.realizedProfitUsd != null);
    return {
      samples: n,
      pLeg1: smooth(l1.length, n),
      pLeg2Given1: smooth(l2.length, l1.length),
      pLeg3Given12: smooth(l3.length, l2.length),
      leg2CondSamples: l1.length,
      leg2CondRateRaw: l1.length > 0 ? l2.length / l1.length : 0,
      avgUnwindLossUsd: unwindLosses.length > 0 ? unwindLosses.reduce((a, b) => a + b, 0) / unwindLosses.length : null,
      totalRealizedUsd: realizedRows.reduce((s, r) => s + parseFloat(r.realizedProfitUsd!), 0),
      realizedSamples: realizedRows.length,
      avgRealizedUsd: realizedRows.length > 0 ? realizedRows.reduce((s, r) => s + parseFloat(r.realizedProfitUsd!), 0) / realizedRows.length : null,
      lastAttemptAtMs: legRows[0]?.createdAt ? new Date(legRows[0].createdAt).getTime() : 0,
    };
  } catch { return null; }
}

/** Risk-adjusted expected value for firing leg 1:
 *  EV = edge × P(all legs) − P(leg1 fills but the rest doesn't) × unwind loss.
 *  Returns null when there aren't enough leg-tracked live samples to judge. */
function riskAdjustedEv(risk: RouteLegRisk | null, netProfitUsd: number, tradeSizeUsd: number): { evUsd: number; pAll: number; pStrand: number; unwindLossUsd: number } | null {
  if (!risk || risk.samples < RISK_MIN_SAMPLES) return null;
  const pAll = risk.pLeg1 * risk.pLeg2Given1 * risk.pLeg3Given12;
  const pStrand = risk.pLeg1 * (1 - risk.pLeg2Given1 * risk.pLeg3Given12);
  const unwindLossUsd = risk.avgUnwindLossUsd ?? DEFAULT_UNWIND_LOSS_FRAC * tradeSizeUsd;
  return { evUsd: netProfitUsd * pAll - pStrand * unwindLossUsd, pAll, pStrand, unwindLossUsd };
}

// liveGraphExecInFlight is now an alias for the shared liveExecLockHeld.
// All live executors (triangle, OB, graph, inventory) use the same lock.

/**
 * Snapshot the Kraken account's actual USD value into account_snapshots.
 * Best-effort: never throws (a valuation failure must not fail a trade
 * response). Returns the snapshot values or null.
 */
/** Stable, non-reversible per-account scope key. Includes the Coinbase key
 * when present so Kraken-only and combined valuations never share a baseline
 * (their totals aren't comparable). */
function accountIdFromKey(krakenKey: string, coinbaseKey?: string): string {
  return createHash("sha256").update(`${krakenKey}|${coinbaseKey ?? ""}`).digest("hex").slice(0, 16);
}

/** CANONICAL credential-presence rule for the per-account scope: the Coinbase
 * key participates ONLY when its secret is also usable. A lone key (no
 * secret) can't trade or be valued, so it must not fork the scope — the gate,
 * blacklist, risk stats, scan ranking, snapshots, and every recordQuality
 * write MUST all derive the accountId through this one helper, or a trader
 * could be gated under one scope while their fills are recorded under
 * another (their own history would become invisible to their own gate). */
function accountScope(krakenKey: string, coinbaseKey?: string, coinbaseSecret?: string): string {
  return accountIdFromKey(krakenKey, coinbaseKey && coinbaseSecret ? coinbaseKey : undefined);
}

async function snapshotAccountValue(creds: { krakenKey: string; krakenSecret: string; coinbaseKey?: string; coinbaseSecret?: string }, trigger: "poll" | "post_trade", log: { error: (o: object, m: string) => void }): Promise<{ totalUsd: number; usdBalance: number; holdingsUsd: number; unpriced: string[] } | null> {
  try {
    // Post-trade snapshots bypass the 30s balance cache — balances just changed.
    const k = await krakenAccountValueUsd(creds, trigger === "post_trade");
    let v = { totalUsd: k.totalUsd, usdBalance: k.usdBalance, holdingsUsd: k.holdingsUsd, unpriced: [...k.unpriced] };
    if (creds.coinbaseKey && creds.coinbaseSecret) {
      const c = await coinbaseAccountValueUsd({ coinbaseKey: creds.coinbaseKey, coinbaseSecret: creds.coinbaseSecret });
      v = {
        totalUsd: k.totalUsd + c.totalUsd,
        usdBalance: k.usdBalance + c.usdBalance,
        holdingsUsd: k.holdingsUsd + c.holdingsUsd,
        unpriced: [...k.unpriced, ...c.unpriced.map(a => `CB:${a}`)],
      };
    }
    const accountId = accountScope(creds.krakenKey, creds.coinbaseKey, creds.coinbaseSecret);
    // Dedupe poll spam: skip the insert when value is unchanged vs the last
    // snapshot (post-trade snapshots always record — they're the audit trail).
    if (trigger === "poll") {
      const [last] = await db.select().from(accountSnapshotsTable)
        .where(dbEq(accountSnapshotsTable.accountId, accountId))
        .orderBy(dbDesc(accountSnapshotsTable.id)).limit(1);
      if (last && Math.abs(parseFloat(last.totalUsd) - v.totalUsd) < 0.01) return v;
    }
    await db.insert(accountSnapshotsTable).values({
      accountId,
      totalUsd: v.totalUsd.toFixed(6),
      usdBalance: v.usdBalance.toFixed(6),
      holdingsUsd: v.holdingsUsd.toFixed(6),
      trigger,
      hasUnpriced: v.unpriced.length > 0,
    });
    return v;
  } catch (err) {
    log.error({ err }, "account snapshot failed");
    return null;
  }
}

// ── Snapshot retention (opportunistic, throttled) ────────────────────────────
// account_snapshots grows on every live trade and every changed 60s poll.
// Retention policy (P&L-safe by construction):
//   • post_trade rows: NEVER deleted — they're the audit trail.
//   • each account's first-ever row: NEVER deleted — it's the lifetime baseline.
//   • poll rows younger than 7 days: kept in full (today's baseline lives here).
//   • poll rows 7–30 days old: downsampled to one per hour (earliest in bucket).
//   • poll rows older than 30 days: downsampled to one per day.
// P&L math only reads the first-ever row, today's first row, and the latest
// row — all untouched by this policy, so reported numbers don't change.
const SNAPSHOT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // at most every 6h
let lastSnapshotPruneMs = 0;

async function pruneAccountSnapshots(log: { error: (o: object, m: string) => void }): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastSnapshotPruneMs < SNAPSHOT_PRUNE_INTERVAL_MS) return;
  lastSnapshotPruneMs = nowMs; // set first — a failing prune must not retry every request
  try {
    // Hourly downsample: poll rows older than 7 days, keep the earliest row in
    // each (account, hour) bucket. First-ever rows are excluded explicitly.
    await db.execute(sql`
      DELETE FROM account_snapshots s
      WHERE s.trigger = 'poll'
        AND s.created_at < now() - interval '7 days'
        AND s.created_at >= now() - interval '30 days'
        AND s.id <> (SELECT min(m.id) FROM account_snapshots m WHERE m.account_id = s.account_id)
        AND s.id NOT IN (
          SELECT min(b.id)
          FROM account_snapshots b
          WHERE b.trigger = 'poll'
            AND b.created_at < now() - interval '7 days'
            AND b.created_at >= now() - interval '30 days'
          GROUP BY b.account_id, date_trunc('hour', b.created_at)
        )
    `);
    // Daily downsample: poll rows older than 30 days, keep the earliest row in
    // each (account, day) bucket.
    await db.execute(sql`
      DELETE FROM account_snapshots s
      WHERE s.trigger = 'poll'
        AND s.created_at < now() - interval '30 days'
        AND s.id <> (SELECT min(m.id) FROM account_snapshots m WHERE m.account_id = s.account_id)
        AND s.id NOT IN (
          SELECT min(b.id)
          FROM account_snapshots b
          WHERE b.trigger = 'poll'
            AND b.created_at < now() - interval '30 days'
          GROUP BY b.account_id, date_trunc('day', b.created_at)
        )
    `);
  } catch (err) {
    log.error({ err }, "account snapshot prune failed");
  }
}

// ── POST /arb/account-pnl ─────────────────────────────────────────────────────
// Ground-truth P&L from ACTUAL exchange balances, never scanner estimates.
// Values Kraken (+ Coinbase when creds provided), stores a snapshot, then
// decomposes the equity change into three separately-attributable numbers:
//   equity change = external cash flows + trading P&L + unrealized drift
router.post("/arb/account-pnl", async (req, res): Promise<void> => {
  const parsed = GetAccountPnlBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "krakenKey and krakenSecret are required." }); return; }
  // Coinbase creds are all-or-nothing — a lone key must not fork the baseline.
  const hasCoinbase = !!(parsed.data.coinbaseKey && parsed.data.coinbaseSecret);
  const creds = {
    krakenKey: parsed.data.krakenKey, krakenSecret: parsed.data.krakenSecret,
    ...(hasCoinbase ? { coinbaseKey: parsed.data.coinbaseKey, coinbaseSecret: parsed.data.coinbaseSecret } : {}),
  };
  // Opportunistic retention pass — throttled, fire-and-forget so a slow
  // prune can never delay a P&L response.
  void pruneAccountSnapshots(req.log);
  try {
    const now = await snapshotAccountValue(creds, "poll", req.log);
    if (!now) { res.status(502).json({ error: "Could not value the account (balance or ticker fetch failed)." }); return; }
    const accountId = accountScope(creds.krakenKey, creds.coinbaseKey, creds.coinbaseSecret);
    const scope = dbEq(accountSnapshotsTable.accountId, accountId);
    const startOfTodayUtc = new Date(); startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    // Indexed baseline lookups — never load full history.
    const [[first], [firstToday], [{ n: snapshotCount }]] = await Promise.all([
      db.select().from(accountSnapshotsTable).where(scope).orderBy(accountSnapshotsTable.id).limit(1),
      db.select().from(accountSnapshotsTable).where(dbAnd(scope, dbGte(accountSnapshotsTable.createdAt, startOfTodayUtc))).orderBy(accountSnapshotsTable.id).limit(1),
      db.select({ n: dbCount() }).from(accountSnapshotsTable).where(scope),
    ]);
    if (!first) { res.status(500).json({ error: "Snapshot insert failed — no baseline available." }); return; }
    const todayBase = firstToday ?? first;
    // Trading P&L = sum of per-trade realized profits (balance-verified fill
    // accounting recorded at execution time), live fills only, scoped to THIS
    // Kraken account and to fills recorded since the equity baseline.
    const [tradingAgg] = await db.select({ total: sum(executionQualityTable.realizedProfitUsd), trades: dbCount() }).from(executionQualityTable)
      .where(dbAnd(
        dbEq(executionQualityTable.isDryRun, false),
        dbEq(executionQualityTable.filled, true),
        dbEq(executionQualityTable.accountId, accountId),
        dbGte(executionQualityTable.createdAt, first.createdAt),
      ));
    // External cash flows since the baseline (Kraken Ledgers). If the ledger
    // is unavailable or incomplete, FAIL CLOSED: withhold the decomposition
    // instead of presenting a wrong attribution.
    let netCashFlowUsd: number | null = 0;
    let netCashFlowTodayUsd: number | null = 0;
    let cashFlowNote: string | null = null;
    try {
      const sinceUnix = Math.floor(first.createdAt.getTime() / 1000);
      const cf = await krakenNetCashFlowUsd({ krakenKey: creds.krakenKey, krakenSecret: creds.krakenSecret }, sinceUnix);
      if (!cf.complete) {
        netCashFlowUsd = null;
        netCashFlowTodayUsd = null;
        cashFlowNote = "Kraken ledger history too long to fetch fully — attribution withheld this refresh.";
      } else {
        netCashFlowUsd = cf.netUsd;
        if (cf.approximated) cashFlowNote = "Some non-USD deposits/withdrawals valued at current (not historical) prices.";
        // Today's cash flows: a separate ledger fetch from today's baseline.
        // Reuse the lifetime result when the baselines coincide.
        if (todayBase.id === first.id) {
          netCashFlowTodayUsd = cf.netUsd;
        } else {
          const sinceTodayUnix = Math.floor(todayBase.createdAt.getTime() / 1000);
          const cfToday = await krakenNetCashFlowUsd({ krakenKey: creds.krakenKey, krakenSecret: creds.krakenSecret }, sinceTodayUnix);
          netCashFlowTodayUsd = cfToday.complete ? cfToday.netUsd : null;
          if (!cfToday.complete) cashFlowNote = (cashFlowNote ? cashFlowNote + " " : "") + "Today's ledger history couldn't be fetched fully — today's number is unadjusted.";
        }
      }
    } catch (err) {
      req.log.error({ err }, "ledger cash-flow fetch failed");
      netCashFlowUsd = null;
      netCashFlowTodayUsd = null;
      cashFlowNote = "Kraken ledger fetch failed — cash flows unknown, attribution withheld this refresh.";
    }
    // Coinbase deposits/withdrawals aren't retrievable yet — a Coinbase cash
    // movement would be misclassified as trading/drift, so withhold the
    // residual attribution for combined accounts.
    if (hasCoinbase) {
      netCashFlowUsd = null;
      netCashFlowTodayUsd = null;
      cashFlowNote = (cashFlowNote ? cashFlowNote + " " : "") + "Coinbase external deposits/withdrawals can't be tracked yet — attribution withheld for combined accounts.";
    }
    const equityChangeUsd = now.totalUsd - parseFloat(first.totalUsd);
    const equityChangeTodayUsd = now.totalUsd - parseFloat(todayBase.totalUsd);
    const tradingPnlUsd = tradingAgg?.total != null ? parseFloat(tradingAgg.total) : 0;
    res.json({
      startingValueUsd: parseFloat(first.totalUsd),
      startedAt: first.createdAt.toISOString(),
      currentValueUsd: now.totalUsd,
      usdBalance: now.usdBalance,
      unrealizedHoldingsUsd: now.holdingsUsd,
      // Headline numbers exclude external deposits/withdrawals when the
      // Kraken ledger could be fetched; otherwise fall back to raw equity
      // change and flag it via cashFlowAdjusted=false + cashFlowNote.
      realizedTodayUsd: netCashFlowTodayUsd != null ? equityChangeTodayUsd - netCashFlowTodayUsd : equityChangeTodayUsd,
      lifetimePnlUsd: netCashFlowUsd != null ? equityChangeUsd - netCashFlowUsd : equityChangeUsd,
      cashFlowAdjusted: netCashFlowUsd != null && netCashFlowTodayUsd != null,
      netCashFlowTodayUsd,
      // Three-way decomposition
      equityChangeUsd,
      netCashFlowUsd,
      tradingPnlUsd,
      tradedFillCount: tradingAgg?.trades ?? 0,
      unrealizedPnlUsd: netCashFlowUsd == null ? null : equityChangeUsd - netCashFlowUsd - tradingPnlUsd,
      cashFlowNote,
      includesCoinbase: hasCoinbase,
      snapshotCount,
      unpricedAssets: now.unpriced,
    });
  } catch (err) {
    req.log.error({ err }, "account-pnl error");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/arb/graph-execute", async (req, res): Promise<void> => {
  const parsed = GraphExecuteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, routeDescription, isDryRun } = parsed.data;
  const forceMode = parsed.data.forceMode === true;
  // FORCE MODE loosens money-safety gates (fill-rate gate, blacklist, stale-lock
  // eviction) — honor it only with operator proof. The credentials are already
  // required by the schema, but a live-order call only exercises them later (or
  // never, on dry-run), so an anonymous caller could otherwise pass garbage keys
  // with forceMode=true. Verify ownership up front before any gate is bypassed.
  if (forceMode) {
    const proof = await verifyOperatorProof(krakenKey, krakenSecret);
    if (proof !== "ok") {
      res.status(403).json({ error: "FORCE MODE requires valid Kraken credentials — credential check failed, execution refused." });
      return;
    }
  }
  const tRequestMs = Date.now(); // latency: request in (≈ opportunity handed to executor)
  // Micro-check freshness threshold — cached quotes older than this SKIP the
  // fire instead of executing blind. Clamped 50ms..5s; default 250ms.
  const maxQuoteAgeMs = Math.min(5_000, Math.max(50, Math.round(parsed.data.maxQuoteAgeMs ?? 200)));
  // Server-side safety bounds — never trust client numbers for live orders:
  // finite positive size, non-negative fees, and (live only) a non-negative
  // profit floor so a negative minProfitUsd can't push a losing route through.
  const tradeSizeUsd    = Math.min(100_000, Math.max(1, Number.isFinite(parsed.data.tradeSizeUsd) ? parsed.data.tradeSizeUsd : 10));
  const krakenFeesPct   = Math.max(0, Number.isFinite(parsed.data.krakenFeesPct)   ? parsed.data.krakenFeesPct   : 0.16);
  const coinbaseFeesPct = Math.max(0, Number.isFinite(parsed.data.coinbaseFeesPct) ? parsed.data.coinbaseFeesPct : 0.40);
  const minProfitUsd    = isDryRun ? parsed.data.minProfitUsd : Math.max(0, parsed.data.minProfitUsd);
  const executionStyleReq = parsed.data.executionStyle ?? "taker";
  // Adaptive resolves to a concrete maker/taker path per fire (decision made
  // after route selection, using fresh taker breakdown vs. maker EV). Until
  // then it scans/gates as maker — the superset view of opportunities.
  let executionStyle: "maker" | "taker" = executionStyleReq === "adaptive" ? "maker" : executionStyleReq;
  const asset = (node: string) => node.split(":")[1] ?? node;

  // Global execution lease — shared with all live executors (triangle, OB,
  // inventory). A second live request (another tab, an auto-fire racing a manual
  // click) must never run concurrently and double-spend the same balance.
  let lockGen: number | null = null;
  if (!isDryRun) {
    // FORCE MODE lock override: a genuinely live execution heartbeats every
    // ~1s, so a lock silent for >15s under FORCE MODE is treated as dead and
    // evicted immediately instead of waiting out the full 30s staleness
    // window. A lock with a recent heartbeat is NEVER evicted — that would
    // let two live executions spend the same balance.
    if (forceMode && liveLockBusy() && liveLockSilentMs() > FORCE_LOCK_STALE_MS) {
      req.log.warn({ silentMs: liveLockSilentMs() }, "FORCE MODE — evicting silent execution lock (cancelling open orders first)");
      // Cancel the dead run's resting orders BEFORE proceeding, so a stale
      // maker leg can't fill while the new trade runs. Failure to cancel =
      // do NOT evict; the trader can use the KILL button.
      try {
        const n = await krakenCancelAllOrders({ krakenKey, krakenSecret });
        req.log.info({ cancelledOrders: n }, "FORCE MODE eviction: open orders cancelled");
        forceReleaseLiveLock();
      } catch (e) {
        req.log.error({ err: e }, "FORCE MODE eviction aborted — CancelAll failed, lock kept");
      }
    }
    // Indeterminate-order gate: an unconfirmed maker cancel from a previous
    // run blocks ALL live execution until that specific order is verified
    // terminal. Try to resolve it now with this request's credentials.
    if (pendingIndeterminate) {
      const out = await resolvePendingIndeterminate({ krakenKey, krakenSecret }, { coinbaseKey, coinbaseSecret }, req.log);
      if (!out.cleared || out.message) {
        res.json({ success: false, isDryRun, executed: false, route: routeDescription ?? "(top route)", preflightProfitUsd: null, error: out.message ?? pendingIndeterminateMsg() });
        return;
      }
    }
    if (liveLockBusy()) {
      res.json({ success: false, isDryRun, executed: false, route: routeDescription ?? "(top route)", preflightProfitUsd: null, error: forceMode ? "A live execution with a RECENT heartbeat holds the lock — use HARD RESET / KILL if you're sure it's dead." : "Another LIVE execution is already in progress — refused to run concurrently." });
      return;
    }
    lockGen = acquireLiveLock();
    bindLockHeartbeat(liveLockHeartbeat(lockGen));
  }
  try {
    // 0. Prefer the account's ACTUAL Kraken fee tier over the caller's
    //    assumption — maker tier for post-only execution, taker for market.
    const tiers = await krakenFeeTiers({ krakenKey, krakenSecret }, ["XXBTZUSD", "ETHUSD", "SOLUSD"]);
    const effectiveKrakenFeesPct =
      (executionStyle === "maker" ? tiers?.makerFeePct : tiers?.takerFeePct) ?? krakenFeesPct;

    // 1. Fresh pre-flight scan (depth-walked VWAP prices in taker mode)
    const scan = await scanGraphOpportunities(tradeSizeUsd, effectiveKrakenFeesPct, coinbaseFeesPct, 4, executionStyle, tiers != null);
    // Same stream repricing as /arb/graph-scan (taker fee tier), so the route
    // net the gates see is the executable number, not the graph estimate.
    const scanTakerFeePct = tiers?.takerFeePct ?? krakenFeesPct;
    if (executionStyleReq !== "maker") {
      await repriceKrakenTriangles(scan.routes, tradeSizeUsd, scanTakerFeePct, req.log);
      repriceCrossRoutes(scan.routes, tradeSizeUsd, scanTakerFeePct, coinbaseFeesPct, req.log);
    }
    const route = routeDescription
      ? scan.routes.find(r => r.description === routeDescription)
      : scan.routes[0];
    if (!route) {
      res.json({ success: false, isDryRun, executed: false, route: routeDescription ?? "(top route)", preflightProfitUsd: null, error: "Route no longer present in a fresh scan — prices moved." });
      return;
    }
    // 1b. Route-pair-specific fee check: the scan above used fee tiers queried
    //     for BTC/ETH/SOL pairs. If this route's actual Kraken pairs carry a
    //     HIGHER fee schedule, penalize the fresh net profit by the delta
    //     (per Kraken leg, on notional) so the gate can't approve on an
    //     understated fee. A lower route fee is left as safety margin.
    let routeFeeAdjustedNetUsd = route.netProfitUsd;
    let routeTakerFeePct: number | null = null; // actual taker tier for THIS route's pairs — adaptive must decide with it
    const routeKrakenPairs = [...new Set(route.hops.filter(h => h.exchange === "kraken" && h.pair).map(h => h.pair!))];
    if (routeKrakenPairs.length > 0) {
      const routeTiers = await krakenFeeTiers({ krakenKey, krakenSecret }, routeKrakenPairs);
      routeTakerFeePct = routeTiers?.takerFeePct ?? null;
      const routeFeePct = (executionStyle === "maker" ? routeTiers?.makerFeePct : routeTiers?.takerFeePct) ?? null;
      if (routeFeePct != null && routeFeePct > effectiveKrakenFeesPct) {
        const deltaUsd = ((routeFeePct - effectiveKrakenFeesPct) / 100) * tradeSizeUsd * routeKrakenPairs.length;
        routeFeeAdjustedNetUsd -= deltaUsd;
        req.log.info({ route: route.description, routeFeePct, effectiveKrakenFeesPct, deltaUsd }, "Route pairs carry a higher fee tier — net profit penalized");
      }
    }
    const realHops = route.hops.filter(h => h.exchange !== "bridge");
    const isKrakenTriangle = route.hops.length === 3 && realHops.length === 3 && realHops.every(h => h.exchange === "kraken");
    const isCrossInventory = realHops.length === 2 && route.hops.length === 3 &&
      realHops[0]!.side === "buy" && realHops[1]!.side === "sell" &&
      asset(realHops[0]!.to) === asset(realHops[1]!.from);
    // 1c. ADAPTIVE mode: PROFITABILITY-FIRST resolution for THIS fire. The
    //     stale scanner edge never decides — a fresh taker breakdown (fresh
    //     executable books, real taker fees per leg, depth-walked slippage,
    //     safety buffer) is computed BEFORE any maker order:
    //       1. fresh taker net ≥ floor            → fire TAKER immediately
    //       2. else maker expected realized ≥ floor → attempt MAKER
    //          (maker expected realized = maker net × historical full-cycle
    //           fill probability − expected unwind cost; conservative default
    //           55% fill / 1.5% strand cost when history is thin)
    //       3. else                                → SKIP (falls through to
    //          the next-best route on the client).
    // Gate inputs must match the RESOLVED style: when adaptive picks taker,
    // the maker-scanned net/slippage would overstate the edge to the history
    // gates below — substitute the fresh taker numbers instead.
    let effNetProfitUsd = route.netProfitUsd;
    let effSlippagePct = route.slippagePct;
    let adaptiveResolved = false; // adaptive decision is TERMINAL — generic floor gate below must not re-reject it
    let quoteAgeMs: number | null = null;      // age of the snapshot the decision used
    let marketUpdateMs: number | null = null;  // latency: last book update in that snapshot
    let adaptiveBufferUsd: number | null = null; // scaled buffer the adaptive approval used — MUST be enforced by the executor too
    if (executionStyleReq === "adaptive" && isKrakenTriangle) {
      // Decide with the ROUTE's actual taker tier (never lower than the
      // account default) — a higher-fee pair must not be approved on an
      // understated fee.
      const takerFeePct = Math.max(routeTakerFeePct ?? 0, tiers?.takerFeePct ?? krakenFeesPct);
      // If the scan repriced this route at a lower fee, re-price it at the
      // decision fee so the buffer, gates, and consistency check all see the
      // same executable number.
      if (route.pricedFrom === "stream" && route.repricedFeePct != null && takerFeePct > route.repricedFeePct + 1e-9) {
        await repriceKrakenTriangles([route], tradeSizeUsd, takerFeePct, req.log);
      }
      // Safety buffer scales with the SCANNER edge: a large stale edge earns a
      // larger margin (10% of it), never a bypass of profitability validation.
      const bufferUsd = Math.max(0.02, tradeSizeUsd * 0.0005, route.netProfitUsd * 0.10);
      adaptiveBufferUsd = bufferUsd;
      // MICRO-CHECK: read the same timestamped in-memory stream snapshot the
      // scanner sees — zero network. Stale (> maxQuoteAgeMs) → wait for the
      // next WebSocket tick on this route's pairs and evaluate ONCE more;
      // still stale → SKIP. Old data is never reused and REST is never
      // fetched in the fire path.
      let bd: import("../lib/order-book").TakerCycleBreakdown | null = null;
      const triA = asset(route.hops[0]!.to) as ObAsset, triB = asset(route.hops[1]!.to) as ObAsset;
      let cachedRes = await cachedTakerCycleBreakdown(triA, triB, tradeSizeUsd, takerFeePct, maxQuoteAgeMs);
      if (cachedRes && !cachedRes.ok && cachedRes.reason === "stale") {
        // Watch the SAME pairs pricing uses — dynamically discovered cross,
        // not the hardcoded fallback (a discovered-only cross would otherwise
        // never wake this wait).
        const { lookup: activeLookup } = await discoverCrossPairs();
        const routePairs = [OB_USD_PAIRS[triA], OB_USD_PAIRS[triB], activeLookup.get(`${triA}-${triB}`)?.pair].filter((p): p is string => !!p);
        const waitMs = Math.min(2_000, Math.max(500, maxQuoteAgeMs * 4));
        req.log.info({ route: route.description, oldestAgeMs: cachedRes.oldestAgeMs, waitMs }, "Quotes stale — waiting for WebSocket updates before re-evaluating");
        // Re-evaluate on EVERY tick until the budget runs out: all three legs
        // must be inside the window at the same moment (one busy leg's tick
        // must not end the wait while a quiet leg is still stale).
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && cachedRes && !cachedRes.ok && cachedRes.reason === "stale") {
          const touched = await waitForBookTouch(routePairs, deadline - Date.now());
          if (!touched) break;
          cachedRes = await cachedTakerCycleBreakdown(triA, triB, tradeSizeUsd, takerFeePct, maxQuoteAgeMs);
        }
      }
      if (cachedRes?.ok) {
        bd = cachedRes.bd;
        quoteAgeMs = cachedRes.quoteAgeMs;
        marketUpdateMs = cachedRes.marketUpdateMs;
        // Per-leg pricing diagnostic — pair, side, top-of-book, VWAP for every leg.
        req.log.info({ route: route.description, netUsd: bd.netProfitUsd, quoteAgeMs, legs: bd.legDiag }, "[PRE-FIRE LEGS] stream snapshot pricing");
        req.log.info({ route: route.description }, `[FRESHNESS] ${formatLegAges(cachedRes.legAges)} | FRESH — evaluating`);
        // CONSISTENCY GATE: the scan above priced this route with the SAME
        // simulator + fee on the SAME stream books milliseconds ago. Any gap
        // beyond tiny book movement means a pricing bug — block, never fire.
        if (route.pricedFrom === "stream") {
          const tolUsd = Math.max(0.02, tradeSizeUsd * 0.002);
          const gap = Math.abs(route.netProfitUsd - bd.netProfitUsd);
          const sameSnapshot = route.marketUpdateMs != null && route.marketUpdateMs === cachedRes.marketUpdateMs;
          if (gap > tolUsd && !sameSnapshot) {
            // Books ticked between scan and micro-check — market movement,
            // not a pricing bug. The strict fresh pre-fire below governs.
            req.log.info({ route: route.description, scannerNetUsd: route.netProfitUsd, preFireNetUsd: bd.netProfitUsd, gapUsd: gap }, "Scanner/pre-fire gap across DIFFERENT snapshots — treating as market movement; fresh pre-fire decides");
          } else if (gap > tolUsd) {
            req.log.error({ route: route.description, scannerNetUsd: route.netProfitUsd, preFireNetUsd: bd.netProfitUsd, gapUsd: gap, tolUsd, quoteAgeMs, scannerQuoteAgeMs: route.quoteAgeMs ?? null, legs: bd.legDiag }, "PRICING CONSISTENCY ERROR — scanner and pre-fire disagree on the same snapshot; blocking execution");
            res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: bd.netProfitUsd, error: `Pre-flight failed — PRICING CONSISTENCY ERROR: scanner net $${route.netProfitUsd.toFixed(4)} vs pre-fire net $${bd.netProfitUsd.toFixed(4)} on the same snapshot (gap $${gap.toFixed(4)} > tol $${tolUsd.toFixed(4)}). Execution blocked until pricing agrees.` });
            return;
          }
        }
      } else if (cachedRes && !cachedRes.ok && cachedRes.reason === "stale") {
        req.log.info({ route: route.description, oldestAgeMs: cachedRes.oldestAgeMs, maxQuoteAgeMs }, `[FRESHNESS] ${formatLegAges(cachedRes.legAges)} | STALE — SKIP`);
        res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: null, error: `Pre-flight failed — adaptive SKIP: quotes are still ${cachedRes.oldestAgeMs}ms old (max ${maxQuoteAgeMs}ms) after waiting for the next book update. Stale data never fires.` });
        return;
      } else {
        // Stream has no book for a leg (WS down or warming up) — SKIP. The
        // fire path never falls back to REST: fresh streamed data or nothing.
        req.log.warn({ route: route.description, stream: krakenStreamStats() }, "ADAPTIVE → SKIP (stream snapshot unavailable — no REST fallback in the fire path)");
        res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: null, error: `Pre-flight failed — adaptive SKIP: live streamed books unavailable for this route (stream down or warming up). The fire path never uses REST data — waiting for the stream.` });
        return;
      }
      if (!bd) {
        // No fresh taker breakdown (books unavailable or depth can't absorb the
        // size) → SKIP. A maker order must never be authorized without the
        // fresh taker pre-flight, and the stale scanner edge never decides.
        req.log.info({ route: route.description }, "ADAPTIVE → SKIP (fresh taker breakdown unavailable — books unfetchable or depth insufficient)");
        res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: null, error: `Pre-flight failed — adaptive SKIP: fresh order books unavailable (or depth can't absorb $${tradeSizeUsd.toFixed(2)}), so the taker pre-flight could not run. No maker order is placed without it.` });
        return;
      }
      const takerNet = bd.netProfitUsd - bufferUsd;
      const riskM = await routeLegRisk(route.description, "maker", accountScope(krakenKey, coinbaseKey, coinbaseSecret));
      const evM = riskAdjustedEv(riskM, route.netProfitUsd, tradeSizeUsd);
      const makerEvUsd = evM ? evM.evUsd : route.netProfitUsd * 0.55 - 0.45 * DEFAULT_UNWIND_LOSS_FRAC * tradeSizeUsd;
      adaptiveResolved = true;
      if (takerNet >= minProfitUsd) {
        executionStyle = "taker";
        effNetProfitUsd = takerNet; // buffered fresh taker net — what taker execution actually expects
        effSlippagePct = bd ? (bd.slippageUsd / tradeSizeUsd) * 100 : 0;
        req.log.info({ route: route.description, takerNetUsd: takerNet, makerEvUsd, bufferUsd, takerFeePct }, "ADAPTIVE → TAKER (fresh buffered taker net clears floor — no maker attempt)");
        // Single-line trader-readable decision record: freshness + both nets + gate + verdict.
        req.log.info({ route: route.description }, `[DECISION] ${formatLegAges(cachedRes?.ok ? cachedRes.legAges : undefined)} | scanner_net=$${route.netProfitUsd.toFixed(4)} | prefire_net=$${(bd?.netProfitUsd ?? takerNet).toFixed(4)} | TAKER NET=$${takerNet.toFixed(4)} > FLOOR=$${minProfitUsd.toFixed(4)} (buffer $${bufferUsd.toFixed(4)}) | FIRE`);
      } else if (makerEvUsd >= makerFloorUsd(tradeSizeUsd, minProfitUsd)) {
        // Audit safeguard: maker EV must clear the RAISED maker floor (historical
        // completion/unwind cost), not just the generic floor — thin maker
        // edges are proven realized losers (9/9 fills negative).
        req.log.info({ route: route.description, takerNetUsd: takerNet, makerEvUsd, fillProb: evM?.pAll ?? 0.55, historyBacked: !!evM }, "ADAPTIVE → MAKER (taker net below floor, maker expected realized clears the raised maker floor)");
      } else {
        req.log.info({ route: route.description, takerNetUsd: takerNet, makerEvUsd }, "ADAPTIVE → SKIP (neither taker net nor maker expected realized clears floor)");
        res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: takerNet ?? route.netProfitUsd, error: `Pre-flight failed — adaptive SKIP: fresh taker net ${takerNet != null ? `$${takerNet.toFixed(4)}` : "unavailable (books)"} and maker expected realized $${makerEvUsd.toFixed(4)} (net × fill probability − unwind cost) are both below your $${minProfitUsd.toFixed(4)} floor. Stale scanner edge $${route.netProfitUsd.toFixed(4)} does not override the fresh pre-flight.` });
        return;
      }
    } else if (executionStyleReq === "adaptive") {
      executionStyle = "taker"; // cross/inventory shapes execute at market regardless
    }
    // 2. ADAPTIVE gate: fresh net profit (already after real fees + depth
    //    slippage in taker mode) must also clear a residual slippage buffer —
    //    edge must exceed fees + slippage + your floor, not just fees.
    const slippageBufferUsd = (effSlippagePct / 100) * tradeSizeUsd * 0.5; // half again, for movement between scan and fill
    // When adaptive already resolved (profitability-first, fresh taker
    // breakdown incl. buffer), its decision is terminal — don't re-reject with
    // this generic residual gate, which would double-count the buffer.
    if (!adaptiveResolved && effNetProfitUsd - slippageBufferUsd <= minProfitUsd) {
      res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: effNetProfitUsd, error: `Pre-flight failed — fresh net profit $${effNetProfitUsd.toFixed(4)} minus slippage buffer $${slippageBufferUsd.toFixed(4)} (${effSlippagePct.toFixed(3)}% depth-walked) ≤ minimum $${minProfitUsd.toFixed(4)}.` });
      return;
    }
    // 2b. FEEDBACK-LOOP gate (live only): this route's own execution history.
    //     Routes that historically filled short of expectation must clear the
    //     average shortfall too; routes that rarely fill are blocked outright.
    let probeAttempt = false;
    // Both live shapes now re-validate the edge with their OWN fresh
    // order-book pre-flight immediately before placing orders: Kraken
    // triangles inside runKrakenTriangle, and cross/inventory routes via the
    // executor-grade cross pre-fire below (live stream books on both venues,
    // per-leg freshness, consistency gate, buffer). A stale scanner edge can
    // never authorize a trade on either shape, so history-based bypasses are
    // safe to grant to both.
    const hasFreshPreFire = isKrakenTriangle || isCrossInventory;
    if (!isDryRun && forceMode && hasFreshPreFire) {
      // FORCE MODE: trader explicitly disabled all history-based gates.
      // Allowed only for shapes with their own final re-quote — the fresh
      // pre-flight remains the last line of defense before any order.
      req.log.info({ route: route.description }, `FORCE MODE — fill-rate gate, shortfall penalty, and blacklist bypassed (${isKrakenTriangle ? "Kraken triangle" : "cross-exchange inventory"})`);
    } else if (!isDryRun) {
      // 2a-bis. Consecutive-failure blacklist: 3 failed live cycles in a row
      // bans the route for 5 minutes — the dashboard's fall-through treats
      // any "Feedback-loop gate" error as "try the next best route".
      // Big-edge bypass and probes apply to any shape with its own fresh
      // final re-quote (Kraken triangles AND cross/inventory routes) — the
      // pre-fire re-validates the edge before any order is placed.
      const hist = await routeQualityPenalty(route.description, executionStyle, tradeSizeUsd, accountScope(krakenKey, coinbaseKey, coinbaseSecret), hasFreshPreFire ? effNetProfitUsd : 0, hasFreshPreFire);
      // Big-edge bypass overrides the blacklist too: an edge > 2× this
      // route's historical average is a NEW opportunity, not the old pattern.
      const gate = await getRouteGate(accountScope(krakenKey, coinbaseKey, coinbaseSecret), executionStyle, route.description);
      const banMs = routeBlacklistRemainingOf(gate);
      if (banMs > 0 && !hist.bigEdgeBypass) {
        res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: `Feedback-loop gate: route blacklisted for ${Math.ceil(banMs / 60_000)} more min after ${ROUTE_BLACKLIST_AFTER} consecutive failed live cycles — moving to the next best route.` });
        return;
      }
      // Profitable-route override: with fresh net profit > $0.01 and fewer
      // than 5 CONSECUTIVE failures, execute regardless of lifetime fill rate
      // — the streak (not the total) is what indicates a dead route now.
      const failStreak = gate.streak;
      // Rides on each shape's fresh order-book re-quote (triangle executor
      // pre-flight or the executor-grade cross pre-fire below).
      const profitableOverride = hasFreshPreFire && effNetProfitUsd > 0.01 && failStreak < ROUTE_BLACKLIST_AFTER;
      if (hist.blockReason && !profitableOverride) {
        res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: `Feedback-loop gate: ${hist.blockReason} (${hist.attempts} recorded live attempts).` });
        return;
      }
      if (hist.blockReason && profitableOverride) {
        req.log.info({ route: route.description, netProfitUsd: route.netProfitUsd, failStreak }, "Fill-rate block overridden — profitable edge with a short failure streak");
      }
      if (hist.shortfallUsd > 0 && effNetProfitUsd - slippageBufferUsd - hist.shortfallUsd <= minProfitUsd) {
        res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: `Feedback-loop gate: this route historically realizes $${hist.shortfallUsd.toFixed(4)} less than the scanner expects (${hist.attempts} live attempts); edge after that shortfall ≤ minimum $${minProfitUsd.toFixed(4)}.` });
        return;
      }
      // 2a-ter. Leg-conditional risk gate (advisor-directed): full-cycle fill
      // rate hides the expensive failure — leg 1 fills, leg 2 dies, unwind
      // eats fees+spread. Gates below run on leg-tracked live history and are
      // NOT bypassed by the profitable-route override (real losses observed);
      // only the big-edge bypass (market moved — history isn't the pattern)
      // and probes skip them.
      const risk = await routeLegRisk(route.description, executionStyle, accountScope(krakenKey, coinbaseKey, coinbaseSecret));
      // Persistent-negative-realized block (trader-directed): a route whose
      // MEASURED realized P&L averages below zero keeps losing money no matter
      // what the scanner claims — applies even under the big-edge bypass and
      // the profitable-route override. Recovery after decay is probe-mode only.
      if (risk && risk.realizedSamples >= 3 && (risk.avgRealizedUsd ?? 0) < 0) {
        if (Date.now() - risk.lastAttemptAtMs < GATE_DECAY_MS) {
          res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: `Risk gate: this route's measured realized P&L averages $${risk.avgRealizedUsd!.toFixed(4)} across ${risk.realizedSamples} live fills (total $${risk.totalRealizedUsd.toFixed(4)}) — it loses real money despite a positive scanner edge. Block decays ${GATE_DECAY_MS / 60_000} min after the last attempt.` });
          return;
        }
        probeAttempt = true;
        req.log.info({ route: route.description, avgRealizedUsd: risk.avgRealizedUsd, realizedSamples: risk.realizedSamples }, "negative-realized block decayed — recovery attempt runs in probe mode (2s maker window)");
      }
      if (!hist.bigEdgeBypass && !hist.probe) {
        // Hard block: poor leg2|leg1 completion is the exact loss pattern.
        if (risk && risk.leg2CondSamples >= RISK_MIN_SAMPLES && risk.leg2CondRateRaw < LEG2_COND_BLOCK_RATE) {
          if (Date.now() - risk.lastAttemptAtMs < GATE_DECAY_MS) {
            res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: `Risk gate: leg 2 completes only ${Math.round(risk.leg2CondRateRaw * 100)}% of the time after leg 1 fills (${risk.leg2CondSamples} conditional samples) — stranded leg-1 fills are unwound at a loss. Block decays ${GATE_DECAY_MS / 60_000} min after the last attempt.` });
            return;
          }
          // Decay expired: the recovery attempt runs as a PROBE (tight 2s
          // maker window), never a full-window trade — otherwise each decay
          // window buys one full-capital failed cycle at ~1.5% loss.
          probeAttempt = true;
          req.log.info({ route: route.description, leg2CondRate: risk.leg2CondRateRaw }, "leg2 risk block decayed — recovery attempt runs in probe mode (2s maker window)");
        }
        const ev = riskAdjustedEv(risk, effNetProfitUsd, tradeSizeUsd);
        if (ev && ev.evUsd <= 0) {
          res.json({ success: false, isDryRun, executed: false, route: route.description, preflightProfitUsd: effNetProfitUsd, error: `Risk gate: risk-adjusted EV $${ev.evUsd.toFixed(4)} ≤ 0 — $${effNetProfitUsd.toFixed(4)} edge × ${(ev.pAll * 100).toFixed(0)}% P(all legs fill) doesn't cover ${(ev.pStrand * 100).toFixed(0)}% chance of a stranded leg 1 costing ~$${ev.unwindLossUsd.toFixed(4)} to unwind (${risk!.samples} leg-tracked live attempts).` });
          return;
        }
        if (ev) req.log.info({ route: route.description, evUsd: ev.evUsd, pAll: ev.pAll, pStrand: ev.pStrand, unwindLossUsd: ev.unwindLossUsd }, "risk-adjusted EV gate passed");
      }
      probeAttempt = hist.probe;
    }

    // 3a. Kraken-only triangle → same machinery as ob-execute (incl. its own
    //     fresh order-book pre-flight, actual fee tier, fill confirm, unwind).
    if (isKrakenTriangle) {
      const tDecisionMs = Date.now(); // all gates passed — decision made
      const probe = isDryRun ? null : armLatencyProbe(); // first AddOrder stamps submit/ack
      let out: Awaited<ReturnType<typeof runKrakenTriangle>>;
      try {
      out = await runKrakenTriangle({
        krakenKey, krakenSecret,
        assetA: asset(route.hops[0]!.to),
        assetB: asset(route.hops[1]!.to),
        tradeSizeUsd, feesPct: krakenFeesPct, minProfitUsd, isDryRun,
        makerTimeoutMs: probeAttempt
          ? PROBE_MAKER_TIMEOUT_MS
          // Clamp trader-supplied maker window to 1–30s.
          : parsed.data.makerTimeoutMs != null ? Math.min(30_000, Math.max(1_000, Math.round(parsed.data.makerTimeoutMs))) : undefined,
        // Clamp: 1..10 reprices — never trust client numbers for live orders.
        maxReprices: Math.min(10, Math.max(1, Math.round(parsed.data.maxReprices ?? 4))),
        // Trader-tuned leg-1 rest window + edge-check interval (re-clamped
        // inside runKrakenTriangle: 5000–120000ms / 500–30000ms).
        leg1RestMs: parsed.data.leg1RestMs,
        edgeCheckMs: parsed.data.edgeCheckMs,
        alwaysTakerFallback: parsed.data.alwaysTakerFallback === true,
        partialFillTolerancePct: parsed.data.partialFillTolerancePct,
        // TAKER path (requested or adaptive-chosen): market/IOC all 3 legs,
        // gated by the fresh taker pre-flight + safety buffer inside.
        takerOnly: executionStyle === "taker",
        // Adaptive fires: extend the freshness contract THROUGH submission —
        // the executor's own pre-submission pre-flight must price every leg
        // from the stream within the trader's window (exchange timestamps);
        // any stale leg aborts before any order is placed. Never REST.
        maxQuoteAgeMs: adaptiveResolved ? maxQuoteAgeMs : undefined,
        // Enforce the SAME scaled buffer the adaptive approval used — the
        // executor's own preflight and taker-fallback gates must not be
        // looser than the decision that authorized this fire.
        safetyBufferUsd: adaptiveBufferUsd ?? undefined,
        heldLockGen: lockGen ?? undefined, // graph-execute already holds the live lock
      }, req.log);
      } finally {
        disarmLatencyProbe(); // exception-safe — a leaked armed probe would contaminate a later order's telemetry
      }
      if (out.badRequest) { res.status(400).json({ error: out.badRequest }); return; }
      const b = out.body!;
      const errText = typeof b["error"] === "string" ? b["error"] : "";
      // Record EVERY real attempt: executed runs (filled or not), plus live
      // failures past pre-flight (a leg may have been accepted before the
      // error). Pre-flight rejections placed no orders and are excluded so
      // they cannot skew the fill-rate gate.
      const wasPreflightReject = !b["executed"] && (errText.startsWith("Pre-flight failed") || errText.startsWith("Could not fetch"));
      const isLiveTri = b["isDryRun"] === false;
      // Live triangles report realized profit (actual cost/fee accounting)
      // in preflightProfitUsd when all legs filled.
      const realizedTri = isLiveTri && b["success"] === true && typeof b["preflightProfitUsd"] === "number" ? b["preflightProfitUsd"] as number : null;
      if (b["executed"] === true || (isLiveTri && !wasPreflightReject)) {
        await recordQuality({
          accountId: accountScope(parsed.data.krakenKey, parsed.data.coinbaseKey, parsed.data.coinbaseSecret),
          route: route.description, style: executionStyle, isDryRun: !!b["isDryRun"],
          filled: b["success"] === true, tradeSizeUsd,
          expectedProfitUsd: effNetProfitUsd,
          realizedProfitUsd: realizedTri,
          slippagePct: effSlippagePct,
          legsFilled: typeof b["legsFilled"] === "number" ? b["legsFilled"] as number : null,
          note: errText || undefined,
        }, req.log);
      }
      // Snapshot after ANY live attempt past pre-flight — an accepted leg may
      // have moved balances even when the run ultimately failed.
      if (isLiveTri && !wasPreflightReject) {
        await snapshotAccountValue({ krakenKey: parsed.data.krakenKey, krakenSecret: parsed.data.krakenSecret, coinbaseKey: parsed.data.coinbaseKey, coinbaseSecret: parsed.data.coinbaseSecret }, "post_trade", req.log);
      }
      // Total pipeline latency: market update → detected/decided → submitted →
      // exchange acknowledgement. Pinpoints whether the bottleneck is
      // detection, processing, API submission, or the exchange itself.
      const latency = {
        quoteAgeMs,
        marketToDecisionMs: marketUpdateMs != null ? tDecisionMs - marketUpdateMs : null,
        requestToDecisionMs: tDecisionMs - tRequestMs,
        decisionToSubmitMs: probe?.submitAtMs != null ? probe.submitAtMs - tDecisionMs : null,
        submitToAckMs: probe?.submitAtMs != null && probe.ackAtMs != null ? probe.ackAtMs - probe.submitAtMs : null,
        totalMs: marketUpdateMs != null && probe?.ackAtMs != null ? probe.ackAtMs - marketUpdateMs : null,
      };
      if (b["executed"] === true) {
        req.log.info({ route: route.description, ...latency }, "[LATENCY] market update → decision → submit → exchange ack");
      }
      res.json({ success: b["success"], isDryRun: b["isDryRun"], executed: b["executed"], route: route.description, preflightProfitUsd: b["preflightProfitUsd"], realizedProfitUsd: realizedTri, orderIds: [b["leg1OrderId"], b["leg2OrderId"], b["leg3OrderId"]].filter(Boolean), error: b["error"] ?? null, chosenMode: executionStyle, latency });
      return;
    }

    // 3b. Dry run (any shape) — ledger row, no orders
    if (isDryRun) {
      await db.insert(tradesTable).values({
        pair: route.description,
        buyExchange: realHops[0]?.exchange ?? "kraken",
        sellExchange: realHops[realHops.length - 1]?.exchange ?? "kraken",
        volume: (realHops[0]?.amountOut ?? 0).toFixed(8),
        estimatedProfitUsd: route.netProfitUsd.toFixed(6),
        netEdgePct: route.profitPct.toFixed(4),
        isDryRun: true,
        krakenPrice: "0",
        coinbasePrice: "0",
        status: "simulated",
      });
      await recordQuality({
        accountId: accountScope(parsed.data.krakenKey, parsed.data.coinbaseKey, parsed.data.coinbaseSecret),
        route: route.description, style: executionStyle, isDryRun: true, filled: true,
        tradeSizeUsd, expectedProfitUsd: route.netProfitUsd, realizedProfitUsd: null, slippagePct: route.slippagePct,
      }, req.log);
      req.log.info({ route: route.description, tradeSizeUsd, profit: route.netProfitUsd }, "Graph execute (dry run)");
      res.json({ success: true, isDryRun: true, executed: true, route: route.description, preflightProfitUsd: route.netProfitUsd, orderIds: [] });
      return;
    }

    // 3c. Live cross-exchange inventory route — SEQUENTIAL confirmed legs.
    //     Buy first, confirm the actual fill, then sell the FILLED amount on
    //     the other venue. If the sell leg fails, unwind the buy on its own
    //     venue so the position ends flat. Never report success on an
    //     unconfirmed order.
    if (!isCrossInventory) {
      res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: "Live execution supports Kraken triangles and 2-leg cross-exchange inventory routes only. Run as dry-run to record the opportunity." });
      return;
    }
    const [buyHop, sellHop] = [realHops[0]!, realHops[1]!];
    if ((buyHop.exchange === "coinbase" || sellHop.exchange === "coinbase") && (!coinbaseKey || !coinbaseSecret)) {
      res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: "Coinbase API credentials are required for this cross-exchange route." });
      return;
    }
    const cbCreds = { coinbaseKey: coinbaseKey ?? "", coinbaseSecret: coinbaseSecret ?? "" };
    const kCreds  = { krakenKey, krakenSecret };
    const log = { info: (m: string) => req.log.info(m), error: (m: string) => req.log.error(m) };
    const plannedVolume = buyHop.amountOut; // base units the route expects to acquire

    // ── EXECUTOR-GRADE CROSS PRE-FIRE ────────────────────────────────────────
    // Same standard as Kraken triangles: LIVE stream books on BOTH venues,
    // per-leg freshness (route age = oldest leg, stale → wait-a-tick → skip),
    // scanner/pre-fire consistency on the SAME snapshot, real fee tiers,
    // depth-walked slippage, and a safety buffer — before ANY order.
    const crossShape = crossRouteShape(route);
    if (!crossShape) {
      res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: route.netProfitUsd, error: "Cross route shape could not be resolved for executor-grade pricing — refusing to fire on a graph estimate." });
      return;
    }
    const crossKFee = routeTakerFeePct ?? scanTakerFeePct;
    const crossWaitKeys = [OB_USD_PAIRS[crossShape.asset], coinbaseBookKey(`${crossShape.asset}-USD`)];
    let crossBd = crossTakerBreakdown(crossShape.asset, crossShape.buyVenue, tradeSizeUsd, crossKFee, coinbaseFeesPct);
    if (!crossBd || crossBd.quoteAgeMs > maxQuoteAgeMs) {
      // Wait for the next relevant update on either venue, then re-evaluate on
      // every touch until fresh or the wait budget runs out. No REST fallback.
      const deadline = Date.now() + Math.min(2_000, Math.max(500, 4 * maxQuoteAgeMs));
      req.log.info({ route: route.description, oldestAgeMs: crossBd?.quoteAgeMs ?? null, waitMs: deadline - Date.now() }, "Cross quotes stale — waiting for WebSocket updates before re-evaluating");
      while (Date.now() < deadline) {
        const touched = await waitForBookTouch(crossWaitKeys, deadline - Date.now());
        if (!touched) break;
        crossBd = crossTakerBreakdown(crossShape.asset, crossShape.buyVenue, tradeSizeUsd, crossKFee, coinbaseFeesPct);
        if (crossBd && crossBd.quoteAgeMs <= maxQuoteAgeMs) break;
      }
    }
    let crossPricedFrom: "stream" | "rest" = "stream";
    if (!crossBd || crossBd.quoteAgeMs > maxQuoteAgeMs) {
      // Stream books still unavailable/stale — re-price BOTH legs from
      // cache-bypassed REST level-2 books at the ACTUAL trade size (the
      // Coinbase leg uses the SAME level-2 endpoint the graph scan prices
      // from). Same depth-walked VWAP + drop-if-too-thin rules: a book that
      // can't absorb the size returns null and the trade ABORTS — the route
      // is never re-priced from top-of-book.
      const restBd = await crossTakerBreakdownRest(crossShape.asset, crossShape.buyVenue, tradeSizeUsd, crossKFee, coinbaseFeesPct, maxQuoteAgeMs).catch(() => null);
      if (restBd && restBd.quoteAgeMs <= maxQuoteAgeMs) {
        crossBd = restBd;
        crossPricedFrom = "rest";
        req.log.info({ route: route.description, netUsd: restBd.netProfitUsd, legs: restBd.legDiag }, "Cross pre-fire re-priced from REST level-2 books (stream unavailable) — depth-walked at trade size");
      }
    }
    if (!crossBd || crossBd.quoteAgeMs > maxQuoteAgeMs) {
      req.log.info({ route: route.description, oldestAgeMs: crossBd?.quoteAgeMs ?? null, maxQuoteAgeMs }, `[FRESHNESS] ${formatLegAges(crossBd?.legAges)} | STALE — SKIP`);
      res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: crossBd?.netProfitUsd ?? route.netProfitUsd, error: crossBd
        ? `Pre-flight failed — cross SKIP: quotes are still ${crossBd.quoteAgeMs}ms old (max ${maxQuoteAgeMs}ms) after waiting for fresh WebSocket updates on both venues.`
        : "Pre-flight failed — cross SKIP: level-2 depth books unavailable (or too thin to absorb the trade size) on one or both venues — refusing to price from top-of-book." });
      return;
    }
    req.log.info({ route: route.description, pricedFrom: crossPricedFrom }, `[FRESHNESS] ${formatLegAges(crossBd.legAges)} | FRESH — evaluating`);
    // Consistency gate: scanner and pre-fire priced the SAME snapshot →
    // numbers must agree within tolerance; disagreement = pricing bug, block.
    if (route.pricedFrom === "stream" && route.marketUpdateMs != null && route.marketUpdateMs === crossBd.marketUpdateMs) {
      const tol = Math.max(0.02, 0.002 * tradeSizeUsd);
      if (Math.abs(route.netProfitUsd - crossBd.netProfitUsd) > tol) {
        req.log.error({ route: route.description, scannerNetUsd: route.netProfitUsd, prefireNetUsd: crossBd.netProfitUsd, toleranceUsd: tol, legs: crossBd.legDiag }, "PRICING CONSISTENCY ERROR — cross scanner and pre-fire disagree on the same snapshot; execution blocked");
        res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: crossBd.netProfitUsd, error: `PRICING CONSISTENCY ERROR: scanner net $${route.netProfitUsd.toFixed(4)} vs pre-fire net $${crossBd.netProfitUsd.toFixed(4)} on the same snapshot (tolerance $${tol.toFixed(4)}). Execution blocked — this is a pricing bug, not market movement.` });
        return;
      }
    }
    // Canonical sanity guard on the fresh cross pre-fire net — cannot be
    // bypassed by force mode or big-edge bypasses (those only skip history gates).
    {
      const sanityErr = routeSanityError(tradeSizeUsd, crossBd.netProfitUsd);
      if (sanityErr) {
        req.log.error({ route: route.description, prefireNetUsd: crossBd.netProfitUsd, tradeSizeUsd }, "PRICING CONSISTENCY ERROR — cross pre-fire net implausible; execution blocked");
        res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: crossBd.netProfitUsd, error: sanityErr });
        return;
      }
    }
    // Floor + safety buffer on the EXECUTABLE net (both venues' real fees,
    // depth-walked). Same buffer scale as the triangle executor.
    const crossBufferUsd = Math.min(tradeSizeUsd * 0.05, Math.max(0.02, tradeSizeUsd * 0.0005));
    const crossFloor = Math.max(0, minProfitUsd);
    req.log.info({ route: route.description }, `[DECISION] ${formatLegAges(crossBd.legAges)} | scanner_net=$${route.netProfitUsd.toFixed(4)} | prefire_net=$${crossBd.netProfitUsd.toFixed(4)} | TAKER NET=$${(crossBd.netProfitUsd - crossBufferUsd).toFixed(4)} ${crossBd.netProfitUsd - crossBufferUsd > crossFloor ? ">" : "≤"} FLOOR=$${crossFloor.toFixed(4)} (buffer $${crossBufferUsd.toFixed(4)}) | ${crossBd.netProfitUsd - crossBufferUsd > crossFloor ? "FIRE" : "SKIP"}`);
    if (crossBd.netProfitUsd - crossBufferUsd <= crossFloor) {
      res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: crossBd.netProfitUsd, error: `Pre-flight failed — cross executable net $${crossBd.netProfitUsd.toFixed(4)} (fees $${crossBd.feesUsd.toFixed(4)}, slippage $${crossBd.slippageUsd.toFixed(4)}) − safety buffer $${crossBufferUsd.toFixed(4)} ≤ floor $${crossFloor.toFixed(4)}.` });
      return;
    }
    const crossDecisionAtMs = Date.now();
    void crossDecisionAtMs;
    // Pre-order inventory validation: buy venue must hold the USD, sell venue
    // must hold the base units. Checked HERE (after all pricing gates, before
    // any order) so a missing balance can never be discovered mid-trade.
    try {
      const [kBals, cBals] = await Promise.all([
        getKrakenBalances({ krakenKey, krakenSecret }, true),
        getCoinbaseBalances({ coinbaseKey: coinbaseKey ?? "", coinbaseSecret: coinbaseSecret ?? "" }),
      ]);
      const kVariants: Record<string, string[]> = { BTC: ["XXBT", "XBT", "BTC"], DOGE: ["XXDG", "XDG", "DOGE"], ETH: ["XETH", "ETH"], LTC: ["XLTC", "LTC"], XRP: ["XXRP", "XRP"] };
      const kAmt = (names: string[]) => kBals.filter(b => names.includes(b.currency)).reduce((a, b) => a + b.amount, 0);
      const cAmt = (name: string) => cBals.filter(b => b.currency === name).reduce((a, b) => a + b.amount, 0);
      const baseNames = kVariants[crossShape.asset] ?? [crossShape.asset];
      const usdAvail  = crossShape.buyVenue === "kraken" ? kAmt(["ZUSD", "USD"]) : cAmt("USD");
      const baseAvail = crossShape.buyVenue === "kraken" ? cAmt(crossShape.asset) : kAmt(baseNames);
      const needBase = crossBd.baseQty * 1.001; // tiny cushion for fill drift
      if (usdAvail < tradeSizeUsd || baseAvail < needBase) {
        res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: crossBd.netProfitUsd, error: `Inventory check failed — need $${tradeSizeUsd.toFixed(2)} USD on ${crossShape.buyVenue} (have $${usdAvail.toFixed(2)}) and ${needBase.toFixed(6)} ${crossShape.asset} on ${crossShape.buyVenue === "kraken" ? "coinbase" : "kraken"} (have ${baseAvail.toFixed(6)}). Pre-position inventory first.` });
        return;
      }
    } catch (balErr) {
      res.json({ success: false, isDryRun: false, executed: false, route: route.description, preflightProfitUsd: crossBd.netProfitUsd, error: `Inventory check failed — could not fetch balances on both venues: ${(balErr as Error).message}. Refusing to fire unverified.` });
      return;
    }

    // Poll Kraken market order until closed (markets fill fast; 15 s cap).
    // 1s interval — QueryOrders counts against Kraken's private rate limit.
    const waitKrakenFill = async (txid: string) => {
      for (let i = 0; i < 15; i++) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, 1_000));
        try {
          const info = await krakenOrderInfo(kCreds, txid);
          if (info.status === "closed" || info.status === "canceled" || info.status === "expired") return info;
        } catch { /* transient — keep polling */ }
      }
      return { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 };
    };
    // Poll Coinbase order to a terminal state (15 s cap), then return details
    // with CUMULATIVE BASE fills — never assume quantity from a status flag.
    const CB_TERMINAL = new Set(["FILLED", "CANCELLED", "EXPIRED", "FAILED"]);
    const waitCoinbaseFill = async (orderId: string) => {
      for (let i = 0; i < 30; i++) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, 500));
        try {
          const d = await coinbaseOrderDetails(cbCreds, orderId);
          if (CB_TERMINAL.has(d.status)) return d;
        } catch { /* keep polling */ }
      }
      // Timed out — cancel, then read FINAL fills (a partial fill may exist).
      try { await coinbaseCancelOrder(cbCreds, orderId); } catch { /* best effort */ }
      try { return await coinbaseOrderDetails(cbCreds, orderId); }
      catch { return { status: "UNKNOWN", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 }; }
    };
    // Failure ledger row — persisted whenever ANY order was accepted, so
    // manual reconciliation always has the order ids and actual volume.
    let buyOrderId = "", sellOrderId = "";
    let anyAccepted = false;
    const recordFailure = async (volume: number, note: string) => {
      try {
        await db.insert(tradesTable).values({
          pair: `${route.description} [FAILED: ${note.slice(0, 120)}]`,
          buyExchange: buyHop.exchange,
          sellExchange: sellHop.exchange,
          volume: volume.toFixed(8),
          estimatedProfitUsd: "0",
          netEdgePct: "0",
          isDryRun: false,
          krakenPrice: "0",
          coinbasePrice: "0",
          buyOrderId: buyOrderId || null,
          sellOrderId: sellOrderId || null,
          status: "failed",
          // No accepted buy order → nothing filled → realized exactly $0.
          realizedProfitUsd: buyOrderId ? null : "0",
        });
      } catch (e) { log.error(`Failed to write failure ledger row: ${(e as Error).message}`); }
    };

    // Probe attempts (fill-rate/risk-block recovery) get the tighter 2s maker
    // window on cross routes too — same contract as Kraken triangle probes.
    const crossMakerWindowMs = probeAttempt ? PROBE_MAKER_TIMEOUT_MS : MAKER_CROSS_FILL_WINDOW_MS;
    if (probeAttempt && executionStyle === "maker") {
      req.log.info({ route: route.description, crossMakerWindowMs }, "cross probe attempt — maker fill window tightened to the probe timer");
    }

    // ── Maker-first machinery (executionStyle === "maker") ───────────────────
    // The maker leg is placed FIRST as a post-only limit at the scan's join
    // price. It gets a bounded fill window; on expiry we cancel and then poll
    // to a TERMINAL status — a cancel ACK is NOT terminal, the order can still
    // fill in the race. If the exchange can't confirm a terminal state, we
    // fail CLOSED with the resting order id (never silent success, never a
    // hedge sized on an assumed fill). The taker hedge is sized from the
    // ACTUAL maker fill only — full or partial — so the two legs can never
    // mismatch.

    /** Kraken maker leg: post-only limit, confirmed-cancel state machine.
     *  Returns the TERMINAL order info (actual fills). Throws
     *  IndeterminateOrderError when no terminal status could be confirmed. */
    const runKrakenMakerLeg = async (txid: string) => {
      const safe = async () => {
        try { return await krakenOrderInfo(kCreds, txid); }
        catch { return { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 }; }
      };
      const terminal = (s: string) => s === "closed" || s === "canceled" || s === "expired";
      const deadline = Date.now() + crossMakerWindowMs;
      let info = await safe();
      while (!terminal(info.status) && Date.now() < deadline) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, MAKER_POLL_MS));
        info = await safe();
      }
      if (terminal(info.status)) return info;
      // Fill window expired — cancel, then CONFIRM a terminal status.
      try { await krakenCancelOrder(kCreds, txid); }
      catch (e) { log.error(`Maker leg cancel request failed (${txid}) — order may still be live: ${(e as Error).message}`); }
      const confirmDeadline = Date.now() + CANCEL_CONFIRM_MS;
      info = await safe();
      while (!terminal(info.status) && Date.now() < confirmDeadline) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, MAKER_POLL_MS));
        info = await safe();
      }
      if (!terminal(info.status)) {
        // Persist the reconciliation gate BEFORE surfacing the error: all live
        // execution stays blocked until this order is verified terminal.
        setPendingIndeterminate({ exchange: "kraken", orderId: txid, route: route.description, sinceMs: Date.now() });
        throw new IndeterminateOrderError(txid, "maker buy leg (graph cross)");
      }
      return info; // terminal — volExec reflects any late fill in the cancel race
    };

    /** Coinbase maker leg: post-only GTC limit, confirmed-cancel state machine. */
    const runCoinbaseMakerLeg = async (orderId: string) => {
      const terminal = (s: string) => CB_TERMINAL.has(s);
      const safe = async () => {
        try { return await coinbaseOrderDetails(cbCreds, orderId); }
        catch { return { status: "UNKNOWN", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 }; }
      };
      const deadline = Date.now() + crossMakerWindowMs;
      let d = await safe();
      while (!terminal(d.status) && Date.now() < deadline) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, MAKER_POLL_MS));
        d = await safe();
      }
      if (terminal(d.status)) return d;
      try { await coinbaseCancelOrder(cbCreds, orderId); }
      catch (e) { log.error(`Maker leg cancel request failed (${orderId}) — order may still be live: ${(e as Error).message}`); }
      const confirmDeadline = Date.now() + CANCEL_CONFIRM_MS;
      d = await safe();
      while (!terminal(d.status) && Date.now() < confirmDeadline) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, MAKER_POLL_MS));
        d = await safe();
      }
      if (!terminal(d.status)) {
        setPendingIndeterminate({ exchange: "coinbase", orderId, route: route.description, sinceMs: Date.now() });
        throw new IndeterminateOrderError(orderId, "maker buy leg (graph cross, Coinbase)");
      }
      return d;
    };

    let filledVolume = 0;
    // Realized USD accounting from ACTUAL fills (cost/fee), for the feedback loop.
    let buySpendUsd = 0, sellProceedsUsd = 0;
    try {
      // ── Buy leg ─────────────────────────────────────────────────────────────
      // maker style: post-only limit at the join price, confirmed-cancel on
      //              timeout; a PARTIAL fill is acceptable — the hedge is sized
      //              from it, keeping per-unit economics identical.
      // taker style: market order; must FULLY fill or the run aborts.
      if (executionStyle === "maker" && buyHop.exchange === "kraken") {
        // CONTRACT: hop.limitPrice is the marketable TAKER side (best ASK for a
        // buy) — resting a post-only order there would be rejected as crossing.
        // Derive the join price (best BID) from a FRESH book instead, capped at
        // the scan's approved price so we never rest above what was priced.
        const freshBid = await freshJoinPrice(buyHop.pair, "buy");
        if (freshBid == null || !(freshBid > 0)) {
          throw new Error(`Cannot derive a fresh post-only join price for ${buyHop.pair} — order book unavailable. Nothing executed.`);
        }
        const joinPx = Math.min(freshBid, buyHop.limitPrice);
        const r = await krakenRawLimitOrder(kCreds, "buy", plannedVolume, joinPx, buyHop.pair);
        buyOrderId = r.txid[0] ?? "";
        if (!buyOrderId) throw new Error("Kraken maker buy order was not accepted (no txid returned) — nothing executed.");
        anyAccepted = true;
        const fill = await runKrakenMakerLeg(buyOrderId); // terminal or throws
        filledVolume = fill.volExec;
        buySpendUsd = fill.cost + fill.fee;
        if (filledVolume <= 0) {
          throw new Error(`Maker buy leg ${buyOrderId} confirmed ${fill.status} with zero fill inside the ${crossMakerWindowMs / 1000}s window — nothing hedged, no exposure.`);
        }
        log.info(`Maker buy leg ${buyOrderId} terminal ${fill.status}: ${filledVolume.toFixed(8)}/${plannedVolume.toFixed(8)} filled — hedging ACTUAL fill only`);
      } else if (executionStyle === "maker") {
        // Join price for a BUY is the best BID — the scan's limitPrice is the
        // marketable taker side (the ask), which post-only would reject. Rest at
        // the live bid, never above the approved price. Price AND size are
        // quantized DOWN to the product's REAL increments (fetched live from
        // Coinbase — never guessed) in the SAFE direction, and the price is
        // clamped strictly BELOW the live ask so rounding can never produce a
        // crossing (taker) submission (e.g. tick $0.01, bid 150.009 →
        // 150.00, never 150.01 when the ask is 150.01).
        const [cbQuote, cbInc] = await Promise.all([
          getCoinbaseBidAsk(buyHop.pair as Pair),
          getCoinbaseProductIncrements(buyHop.pair as Pair),
        ]);
        const quoteIncNum = parseFloat(cbInc.quoteIncrement);
        let pxQ = quantizeDown(Math.min(buyHop.limitPrice, cbQuote.bid), cbInc.quoteIncrement);
        const belowAsk = quantizeDown(cbQuote.ask - quoteIncNum * 0.5, cbInc.quoteIncrement); // highest tick strictly below the ask
        if (pxQ.value > belowAsk.value) pxQ = belowAsk;
        if (!(pxQ.value > 0)) throw new Error(`Cannot place a post-only Coinbase maker buy: no valid price tick below the ask (bid ${cbQuote.bid}, ask ${cbQuote.ask}, tick ${cbInc.quoteIncrement}). Nothing executed.`);
        const volQ = quantizeDown(plannedVolume, cbInc.baseIncrement);
        if (!(volQ.value > 0)) throw new Error(`Coinbase maker buy volume ${plannedVolume} is below the product's base increment ${cbInc.baseIncrement}. Nothing executed.`);
        const submittedVolume = volQ.value;
        const r = await coinbaseLimitOrder(cbCreds, "BUY", submittedVolume, pxQ.value, buyHop.pair as Pair, cbInc);
        buyOrderId = r.orderId ?? "";
        if (!buyOrderId || r.success === false) throw new Error("Coinbase maker buy order was rejected (no order id) — nothing executed.");
        anyAccepted = true;
        const d = await runCoinbaseMakerLeg(buyOrderId); // terminal or throws
        filledVolume = d.filledSize;
        buySpendUsd = d.filledValue + d.totalFees;
        if (filledVolume <= 0) {
          throw new Error(`Maker buy order ${buyOrderId} confirmed ${d.status} with zero fill inside the ${crossMakerWindowMs / 1000}s window — nothing hedged, no exposure.`);
        }
        // Reconcile reported fill against the SUBMITTED amount: the hedge is
        // sized from the actual fill either way, but a fill above what we
        // submitted means our accounting can't be trusted — refuse to hedge
        // blind.
        if (filledVolume > submittedVolume + parseFloat(cbInc.baseIncrement) * 0.5) {
          throw new Error(`Coinbase maker buy ${buyOrderId} reports ${filledVolume.toFixed(8)} filled — MORE than the submitted ${submittedVolume.toFixed(8)}; refusing to hedge on inconsistent fill data. Verify on Coinbase.`);
        }
        if (filledVolume < submittedVolume) {
          log.info(`Maker buy leg ${buyOrderId} PARTIAL: ${filledVolume.toFixed(8)}/${submittedVolume.toFixed(8)} submitted`);
        }
        log.info(`Maker buy leg ${buyOrderId} terminal ${d.status}: ${filledVolume.toFixed(8)}/${submittedVolume.toFixed(8)} filled — hedging ACTUAL fill only`);
      } else if (buyHop.exchange === "kraken") {
        const r = await krakenRawMarketOrder(kCreds, "buy", plannedVolume, buyHop.pair);
        buyOrderId = r.txid[0] ?? "";
        if (!buyOrderId) throw new Error("Kraken buy order was not accepted (no txid returned) — nothing executed.");
        anyAccepted = true;
        const fill = await waitKrakenFill(buyOrderId);
        filledVolume = fill.volExec;
        buySpendUsd = fill.cost + fill.fee;
        if (fill.status !== "closed" || filledVolume <= 0) {
          if (filledVolume > 0) await tryUnwindMarket(kCreds, "sell", filledVolume, buyHop.pair, "sell partial buy-leg fill (graph cross)", log);
          throw new Error(`Kraken buy leg did not fully fill (status ${fill.status}, ${filledVolume.toFixed(8)}/${plannedVolume.toFixed(8)}); partial fill unwound. Nothing sold.`);
        }
      } else {
        const r = await coinbaseMarketOrder(cbCreds, "BUY", plannedVolume, buyHop.limitPrice, buyHop.pair as Pair);
        buyOrderId = r.orderId ?? "";
        if (!buyOrderId || r.success === false) throw new Error("Coinbase buy order was rejected (no order id) — nothing executed.");
        anyAccepted = true;
        const d = await waitCoinbaseFill(buyOrderId);
        filledVolume = d.filledSize; // ACTUAL base units acquired (never assumed)
        buySpendUsd = d.filledValue + d.totalFees;
        if (d.status !== "FILLED") {
          if (filledVolume > 0) {
            // Partial fill exists — neutralize it on Coinbase.
            try { await coinbaseMarketOrder(cbCreds, "SELL", filledVolume, buyHop.limitPrice, buyHop.pair as Pair); }
            catch (e) { log.error(`Coinbase partial-buy unwind failed — MANUAL REBALANCE NEEDED (${filledVolume.toFixed(8)} ${buyHop.pair}): ${(e as Error).message}`); }
          }
          throw new Error(`Coinbase buy order ${buyOrderId} ended ${d.status} with ${filledVolume.toFixed(8)}/${plannedVolume.toFixed(8)} filled; partial fill unwound. Nothing sold.`);
        }
      }

      // ── Sell leg: sell the ACTUAL filled volume on the other venue ─────────
      try {
        if (sellHop.exchange === "kraken") {
          const r = await krakenRawMarketOrder(kCreds, "sell", filledVolume, sellHop.pair);
          sellOrderId = r.txid[0] ?? "";
          if (!sellOrderId) throw new Error("Kraken sell order was not accepted (no txid returned).");
          const fill = await waitKrakenFill(sellOrderId);
          sellProceedsUsd = fill.cost - fill.fee;
          // Full coverage required: the only permitted shortfall is 8-decimal
          // volume rounding dust (orders are submitted with toFixed(8)). Any
          // material unsold residual fails the route and is unwound — never
          // reported as success with unhedged maker-fill inventory.
          if (fill.status !== "closed" || filledVolume - fill.volExec > 1e-7) {
            // Only the UNSOLD remainder is residual exposure.
            const residual = Math.max(0, filledVolume - fill.volExec);
            throw new ResidualError(`Kraken sell leg did not fully fill (status ${fill.status}, ${fill.volExec.toFixed(8)}/${filledVolume.toFixed(8)}).`, residual);
          }
        } else {
          const r = await coinbaseMarketOrder(cbCreds, "SELL", filledVolume, sellHop.limitPrice, sellHop.pair as Pair);
          sellOrderId = r.orderId ?? "";
          if (!sellOrderId || r.success === false) throw new Error("Coinbase sell order was rejected (no order id).");
          const d = await waitCoinbaseFill(sellOrderId);
          sellProceedsUsd = d.filledValue - d.totalFees;
          if (d.status !== "FILLED") {
            const residual = Math.max(0, filledVolume - d.filledSize);
            throw new ResidualError(`Coinbase sell order ${sellOrderId} ended ${d.status} with ${d.filledSize.toFixed(8)}/${filledVolume.toFixed(8)} sold.`, residual);
          }
        }
      } catch (sellErr) {
        // Neutralize ONLY the unsold residual on the BUY venue (the sold part
        // already left the sell venue's inventory as intended).
        const residual = sellErr instanceof ResidualError ? sellErr.residual : filledVolume;
        if (residual > 0) {
          if (buyHop.exchange === "kraken") {
            await tryUnwindMarket(kCreds, "sell", residual, buyHop.pair, "unwind residual after sell-leg failure (graph cross)", log);
          } else {
            try { await coinbaseMarketOrder(cbCreds, "SELL", residual, buyHop.limitPrice, buyHop.pair as Pair); }
            catch (e) { log.error(`Coinbase unwind failed — MANUAL REBALANCE NEEDED (${residual.toFixed(8)}): ${(e as Error).message}`); }
          }
        }
        throw new Error(`Sell leg failed: ${(sellErr as Error).message} Residual ${residual.toFixed(8)} unwound on ${buyHop.exchange} — verify balances on both venues.`);
      }
    } catch (execErr) {
      const msg = (execErr as Error).message;
      if (anyAccepted) {
        await recordFailure(filledVolume, msg);
        await recordQuality({
          accountId: accountScope(parsed.data.krakenKey, parsed.data.coinbaseKey, parsed.data.coinbaseSecret),
          route: route.description, style: executionStyle, isDryRun: false, filled: false,
          tradeSizeUsd, expectedProfitUsd: route.netProfitUsd, realizedProfitUsd: null, slippagePct: route.slippagePct, note: msg.slice(0, 300),
        }, req.log);
        await snapshotAccountValue({ krakenKey: parsed.data.krakenKey, krakenSecret: parsed.data.krakenSecret, coinbaseKey: parsed.data.coinbaseKey, coinbaseSecret: parsed.data.coinbaseSecret }, "post_trade", req.log);
      }
      req.log.error({ route: route.description, buyOrderId, sellOrderId, filledVolume, err: msg }, "Graph execute LIVE — failed");
      res.json({ success: false, isDryRun: false, executed: anyAccepted, route: route.description, preflightProfitUsd: route.netProfitUsd, orderIds: [buyOrderId, sellOrderId].filter(Boolean), error: msg });
      return;
    }

    const realizedProfitUsd = buySpendUsd > 0 && sellProceedsUsd > 0 ? sellProceedsUsd - buySpendUsd : null;
    const crossVerified = !!buyOrderId && !!sellOrderId && realizedProfitUsd != null;
    await db.insert(tradesTable).values({
      pair: route.description,
      buyExchange: buyHop.exchange,
      sellExchange: sellHop.exchange,
      volume: filledVolume.toFixed(8),
      estimatedProfitUsd: route.netProfitUsd.toFixed(6),
      netEdgePct: route.profitPct.toFixed(4),
      isDryRun: false,
      krakenPrice: "0",
      coinbasePrice: "0",
      buyOrderId: buyOrderId || null,
      sellOrderId: sellOrderId || null,
      status: crossVerified ? "verified" : "estimated",
      realizedProfitUsd: crossVerified ? realizedProfitUsd!.toFixed(6) : null,
      legFills: [
        { leg: 1, label: "buy", pair: buyHop.pair, side: "buy", volume: filledVolume, costUsd: buySpendUsd, txid: buyOrderId || null },
        { leg: 2, label: "sell", pair: sellHop.pair, side: "sell", volume: filledVolume, costUsd: sellProceedsUsd, txid: sellOrderId || null },
      ],
    });
    await recordQuality({
      accountId: accountScope(parsed.data.krakenKey, parsed.data.coinbaseKey, parsed.data.coinbaseSecret),
      route: route.description, style: executionStyle, isDryRun: false, filled: true,
      tradeSizeUsd, expectedProfitUsd: route.netProfitUsd, realizedProfitUsd, slippagePct: route.slippagePct,
    }, req.log);
    await snapshotAccountValue({ krakenKey: parsed.data.krakenKey, krakenSecret: parsed.data.krakenSecret, coinbaseKey: parsed.data.coinbaseKey, coinbaseSecret: parsed.data.coinbaseSecret }, "post_trade", req.log);
    req.log.info({ route: route.description, tradeSizeUsd, filledVolume, buyOrderId, sellOrderId, realizedProfitUsd }, "Graph execute LIVE — both legs confirmed filled");
    res.json({ success: true, isDryRun: false, executed: true, route: route.description, preflightProfitUsd: route.netProfitUsd, realizedProfitUsd, orderIds: [buyOrderId, sellOrderId] });
  } catch (err) {
    req.log.error({ err }, "graph-execute error");
    res.json({ success: false, isDryRun, executed: false, route: routeDescription ?? "(top route)", preflightProfitUsd: null, error: (err as Error).message });
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
  }
});

// ── GET /arb/triangular ────────────────────────────────────────────────────────
router.get("/arb/triangular", async (req, res): Promise<void> => {
  try {
    const tri = getTriPrices();
    const opportunities: TriOpp[] = [];
    const prices: Record<string, unknown> = {};
    const priceSource: Record<string, "direct" | "synthetic"> = {};

    if (tri.kraken) {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk, ethSolSource } = tri.kraken;
      prices.kraken = { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk };
      priceSource.kraken = ethSolSource;
      opportunities.push(...computeTriLoops("Kraken", solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk));
    }

    if (tri.coinbase) {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk, ethSolSource } = tri.coinbase;
      prices.coinbase = { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk };
      priceSource.coinbase = ethSolSource;
      opportunities.push(...computeTriLoops("Coinbase", solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk));
    }

    // BTC triangular loops (v13 Python port — Kraken SOLXBT market)
    const btcPrices = getBtcTriPrices();
    let btcTriStatus: { available: boolean; reason: string | null } = { available: true, reason: null };
    if (btcPrices) {
      const { solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk } = btcPrices;
      prices.krakenBtc = { solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk };
      opportunities.push(...computeBtcTriLoops(solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk));
      recordSolBtcListing(true); // live WS prices imply the market is listed
    } else {
      // WS cache empty/stale — probe whether SOL/BTC is actually unlisted so
      // the dashboard can show a persistent "BTC loops paused" banner. An
      // inconclusive probe never flags unavailability.
      const listed = await checkSolBtcListed();
      if (listed === false) {
        btcTriStatus = { available: false, reason: SOL_BTC_UNAVAILABLE_MSG };
      }
    }

    // Sort all opportunities by profitPct descending
    opportunities.sort((a, b) => b.profitPct - a.profitPct);

    // Opportunistic retention pass — throttled, fire-and-forget so a slow
    // prune can never delay a scan response.
    void pruneScanHistory(req.log);

    // Persist detected opportunities to DB (fire-and-forget — never fail the scan response)
    if (opportunities.length > 0) {
      db.insert(triScanTable)
        .values(
          opportunities.map((opp) => ({
            exchange: opp.exchange,
            loop: opp.loop,
            profitPct: String(opp.profitPct.toFixed(6)),
            solUsd: String(opp.solUsd.toFixed(6)),
            ethUsd: String(opp.ethUsd.toFixed(6)),
            ethSol: String(opp.ethSol.toFixed(8)),
            variant: opp.variant ?? null,
            scannedAt: opp.timestamp,
          })),
        )
        .catch(() => {});
    }

    res.json({ opportunities, prices, priceSource, btcTriStatus, ethSolCrossCheck: tri.ethSolCrossCheck, scannedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Scan-history retention (tri_scans + execution_quality) ───────────────────
// tri_scans policy (summary-exact by construction):
//   • rows younger than 7 days: kept in full (the dashboard chart reads the
//     most recent scans only, so it is untouched).
//   • rows older than 7 days: deleted, but their count/sum/best are folded
//     into tri_scan_rollups (daily buckets) IN THE SAME SQL STATEMENT, so the
//     history summary (total, avg, best, counterfactual P&L) reports the same
//     numbers before and after pruning.
// execution_quality policy:
//   • real (non-dry-run) rows: NEVER deleted — they are the audit trail and
//     feed fill-rate ranking and the route gates.
//   • dry-run rows older than 30 days: deleted (gates/ranking read only the
//     most recent non-dry-run rows, so nothing they need is touched).
const SCAN_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // at most every 6h
let lastScanPruneMs = 0;

async function pruneScanHistory(log: { error: (o: object, m: string) => void }): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastScanPruneMs < SCAN_PRUNE_INTERVAL_MS) return;
  lastScanPruneMs = nowMs; // set first — a failing prune must not retry every request
  try {
    // Atomic delete+rollup: the deleted rows' aggregates land in
    // tri_scan_rollups in the same statement, so no scan is ever dropped
    // from the summary totals even if the process dies mid-prune.
    await db.execute(sql`
      WITH pruned AS (
        DELETE FROM tri_scans
        WHERE created_at < now() - interval '7 days'
        RETURNING created_at, profit_pct
      ), agg AS (
        SELECT date_trunc('day', created_at) AS bucket_day,
               count(*)                      AS scan_count,
               sum(profit_pct)               AS sum_profit_pct,
               max(profit_pct)               AS best_profit_pct
        FROM pruned
        GROUP BY 1
      )
      INSERT INTO tri_scan_rollups (bucket_day, scan_count, sum_profit_pct, best_profit_pct)
      SELECT bucket_day, scan_count, sum_profit_pct, best_profit_pct FROM agg
      ON CONFLICT (bucket_day) DO UPDATE SET
        scan_count      = tri_scan_rollups.scan_count + EXCLUDED.scan_count,
        sum_profit_pct  = tri_scan_rollups.sum_profit_pct + EXCLUDED.sum_profit_pct,
        best_profit_pct = GREATEST(tri_scan_rollups.best_profit_pct, EXCLUDED.best_profit_pct)
    `);
  } catch (err) {
    log.error({ err }, "tri_scans prune failed");
  }
  try {
    // Dry-run attempts only — real rows are the audit trail and feed the
    // fill-rate ranking/gates, so they are never deleted here.
    await db.execute(sql`
      DELETE FROM execution_quality
      WHERE is_dry_run = true
        AND created_at < now() - interval '30 days'
    `);
  } catch (err) {
    log.error({ err }, "execution_quality prune failed");
  }
}

// ── GET /arb/triangular/history ───────────────────────────────────────────────
router.get("/arb/triangular/history", async (req, res): Promise<void> => {
  try {
    const limit  = Math.min(200, Math.max(1, parseInt(String(req.query["limit"]  ?? "50"))  || 50));
    const offset = Math.max(0,               parseInt(String(req.query["offset"] ?? "0"))   || 0);

    const [items, [totalRow]] = await Promise.all([
      db.select().from(triScanTable).orderBy(desc(triScanTable.createdAt)).limit(limit).offset(offset),
      db.select({ total: count() }).from(triScanTable),
    ]);

    res.json({
      items: items.map((r) => ({
        ...r,
        profitPct: parseFloat(r.profitPct),
        solUsd:    parseFloat(r.solUsd),
        ethUsd:    parseFloat(r.ethUsd),
        ethSol:    parseFloat(r.ethSol),
        createdAt: r.createdAt.toISOString(),
      })),
      total: Number(totalRow?.total ?? 0),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /arb/triangular/history/summary ───────────────────────────────────────
// Returns aggregate stats across all recorded triangular scan rows.
// Query param: tradeSizeUsd (default 1000) — used for counterfactual P&L.
router.get("/arb/triangular/history/summary", async (req, res): Promise<void> => {
  const tradeSizeUsd = Math.max(1, parseFloat(String(req.query["tradeSizeUsd"] ?? "1000")) || 1000);
  try {
    // Live rows + pruned-row rollups: retention folds deleted rows' aggregates
    // into tri_scan_rollups, so these totals are exact across all history.
    const [[row], [rollup]] = await Promise.all([
      db.select({
        total:        count(),
        bestProfitPct: sql<number>`MAX(CAST(${triScanTable.profitPct} AS NUMERIC))`,
        sumProfitPct: sql<number>`SUM(CAST(${triScanTable.profitPct} AS NUMERIC))`,
      }).from(triScanTable),
      db.select({
        total:        sql<number>`COALESCE(SUM(${triScanRollupTable.scanCount}), 0)`,
        bestProfitPct: sql<number>`MAX(CAST(${triScanRollupTable.bestProfitPct} AS NUMERIC))`,
        sumProfitPct: sql<number>`SUM(CAST(${triScanRollupTable.sumProfitPct} AS NUMERIC))`,
      }).from(triScanRollupTable),
    ]);

    const liveTotal   = Number(row?.total ?? 0);
    const rolledTotal = Number(rollup?.total ?? 0);
    const total       = liveTotal + rolledTotal;
    const liveSum     = parseFloat(String(row?.sumProfitPct    ?? "0")) || 0;
    const rolledSum   = parseFloat(String(rollup?.sumProfitPct ?? "0")) || 0;
    const sumProfitPct = liveSum + rolledSum;
    const liveBest    = row?.bestProfitPct    != null ? parseFloat(String(row.bestProfitPct))    : null;
    const rolledBest  = rollup?.bestProfitPct != null ? parseFloat(String(rollup.bestProfitPct)) : null;
    const bestProfitPct = (liveBest == null && rolledBest == null)
      ? 0
      : Math.max(liveBest ?? -Infinity, rolledBest ?? -Infinity);
    const avgProfitPct  = total > 0 ? sumProfitPct / total : 0;
    // Counterfactual P&L: if every detected opportunity had been traded at tradeSizeUsd
    const counterfactualPnlUsd = (sumProfitPct / 100) * tradeSizeUsd;

    res.json({ total, avgProfitPct, bestProfitPct, counterfactualPnlUsd, tradeSizeUsd });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Triangular execution helpers ───────────────────────────────────────────────

/** Attempt to cancel a limit order to unwind a partial triangular trade. */
async function tryCancel(
  creds: { krakenKey: string; krakenSecret: string },
  txid: string,
  label: string,
  log: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  if (!txid) return;
  try {
    await krakenCancelOrder(creds, txid);
    log.info(`[TRI·UNWIND] Cancelled ${label} (${txid})`);
  } catch (e) {
    log.error(`[TRI·UNWIND] Cancel ${label} (${txid}) failed — may be filled: ${(e as Error).message}`);
  }
}

// waitForTriLimitFill and TriFillResult live in lib/tri-fill.ts for testability.
export { waitForTriLimitFill, TriIndeterminateOrderError, type TriFillResult } from "../lib/tri-fill.js";

/** Place a market counter-order to unwind an already-filled leg. */
async function tryUnwindMarket(
  creds: { krakenKey: string; krakenSecret: string },
  side: "buy" | "sell",
  volume: number,
  pair: string,
  label: string,
  log: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<boolean> {
  if (volume <= 0) return true;
  try {
    const r = await krakenRawMarketOrder(creds, side, volume, pair);
    log.info(`[TRI·UNWIND] Market ${side} ${volume.toFixed(6)} ${pair} — ${label} (${r.txid[0] ?? "?"})`);
    return true;
  } catch (e) {
    // NEVER silently claim recovery: a failed unwind means live inventory is
    // still held. Most likely cause: residual below the pair's Kraken minimum
    // (KrakenPrecisionError) — needs manual reconciliation.
    log.error(`[TRI·UNWIND] ⚠️ UNRESOLVED EXPOSURE — could not unwind ${side} ${volume.toFixed(8)} ${pair} (${label}): ${(e as Error).message}. Position still held; reconcile manually on Kraken.`);
    return false;
  }
}

// ── POST /arb/execute-triangular ──────────────────────────────────────────────
// Port of Python v13 FORCE TRIANGULAR + auto-loop execution.
// Supports both BTC loops (SOLXBT) and ETH loops (ETHSOL).
//
// Order types (matching Python v13 exactly):
//   orderType="market" (default) — FORCE button: market orders, $10 test size
//   orderType="limit"            — auto-loop: post-only limit orders, 20% USD / max $50
//
// Volume model (matching Python): raw division, no per-leg fee in volume.
// Profit estimate: (gross_pct − TRI_TOTAL_FEES_PCT) × tradeUsd / 100
//
// Failure handling: if any leg throws after a previous leg has been placed,
//   • limit orders — attempt cancel (may not be filled yet)
//   • market orders — attempt a reverse market order to unwind
router.post("/arb/execute-triangular", async (req, res): Promise<void> => {
  const parsed = ExecuteTriangularBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { krakenKey, krakenSecret, loop, tradeUsd: overrideUsd, isDryRun, orderType } = parsed.data;
  const useLimit = orderType === "limit"; // limit = post-only maker (auto-loop); market = force

  const BTC_LOOPS = ["USD→BTC→SOL→USD", "USD→SOL→BTC→USD"];
  const ETH_LOOPS = ["USD→SOL→ETH→USD", "USD→ETH→SOL→USD"];
  const VALID_LOOPS = [...BTC_LOOPS, ...ETH_LOOPS];
  if (!VALID_LOOPS.includes(loop)) {
    res.status(400).json({ error: `Invalid loop "${loop}". Valid: ${VALID_LOOPS.join(", ")}` });
    return;
  }

  const creds = { krakenKey, krakenSecret };
  const isBtc = BTC_LOOPS.includes(loop);

  // Simple log shim that delegates to pino request logger
  const log = {
    info:  (msg: string) => req.log.info(msg),
    error: (msg: string) => req.log.error(msg),
  };

  // 1a. BTC loops — get prices from WS cache or fresh REST fallback
  let btcPrices: { solBid: number; solAsk: number; btcBid: number; btcAsk: number; solBtcBid: number; solBtcAsk: number } | null = null;

  // 1b. ETH loops — get prices from WS tri cache or fresh REST fallback
  let ethPrices: { solBid: number; solAsk: number; ethBid: number; ethAsk: number; ethSolBid: number; ethSolAsk: number } | null = null;
  // Tracks whether the ETH/SOL leg used a direct market or a synthetic cross rate.
  // Carried to the response so the dashboard can warn the user.
  let ethSolSource: "direct" | "synthetic" = "synthetic";

  if (isBtc) {
    btcPrices = getBtcTriPrices();
    if (!btcPrices) {
      // Request XXBTZUSD + SOLUSD + SOLXBT together. A partial error (e.g.
      // SOLXBT temporarily unknown/delisted) still returns the other pairs in
      // `result`, so only a missing result is a hard network/API failure.
      // Unlike the ETH loop there is no synthetic fallback for SOL/BTC — if
      // the direct market is absent we return a clear, descriptive error
      // instead of a generic "Missing pairs" / "Kraken REST error" crash.
      try {
        const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD,SOLUSD,SOLXBT", {
          signal: AbortSignal.timeout(5_000),
        });
        const data = await r.json() as { error?: string[]; result?: Record<string, { b: string[]; a: string[] }> };
        if (!data.result) throw new Error(`Kraken REST error: ${(data.error ?? []).join(", ") || "no result returned"}`);
        const res_ = data.result;
        const btcKey    = Object.keys(res_).find(k => k.includes("XBT") && k.includes("USD"));
        const solKey    = Object.keys(res_).find(k => k.startsWith("SOL") && k.endsWith("USD"));
        // SOLXBT may appear under a key variant; search by content.
        const solBtcKey = Object.keys(res_).find(k => k.startsWith("SOL") && k.includes("XBT"));
        if (!btcKey || !solKey) {
          const missing = [!btcKey && "BTC/USD", !solKey && "SOL/USD"].filter(Boolean).join(" and ");
          throw new Error(`Missing ${missing} in Kraken response`);
        }
        if (!solBtcKey) {
          req.log.warn({ btcKey, solKey }, "SOL/BTC (SOLXBT) market absent from Kraken REST response — BTC triangular loop cannot price its cross leg");
          recordSolBtcListing(false); // surface on the next scan's status banner immediately
          res.status(503).json({ error: SOL_BTC_UNAVAILABLE_MSG });
          return;
        }
        recordSolBtcListing(true);
        btcPrices = {
          btcBid:    parseFloat(res_[btcKey].b[0]),    btcAsk:    parseFloat(res_[btcKey].a[0]),
          solBid:    parseFloat(res_[solKey].b[0]),     solAsk:    parseFloat(res_[solKey].a[0]),
          solBtcBid: parseFloat(res_[solBtcKey].b[0]), solBtcAsk: parseFloat(res_[solBtcKey].a[0]),
        };
      } catch (e) {
        res.status(500).json({ error: `BTC tri prices unavailable: ${(e as Error).message}` });
        return;
      }
    }
  } else {
    // ETH loops — try WS cache first, fall back to REST
    const cached = getTriPrices();
    const krakenTri = cached.kraken;
    if (krakenTri) {
      ethSolSource = krakenTri.ethSolSource;
      ethPrices = {
        solBid: krakenTri.solBid, solAsk: krakenTri.solAsk,
        ethBid: krakenTri.ethBid, ethAsk: krakenTri.ethAsk,
        ethSolBid: krakenTri.ethSolBid, ethSolAsk: krakenTri.ethSolAsk,
      };
    } else {
      // WS cache miss — fetch fresh prices from Kraken REST.
      // Request XETHZUSD + SOLUSD + ETHSOL together; ETHSOL may not exist
      // under that exact key (Kraken sometimes uses "XETHZSOL"), so we
      // search the result by content rather than by a hardcoded key.
      // If the direct ETH/SOL market is absent entirely, we compute a
      // synthetic cross rate from the two USD legs instead of erroring out.
      try {
        const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XETHZUSD,SOLUSD,ETHSOL", {
          signal: AbortSignal.timeout(5_000),
        });
        const data = await r.json() as { error?: string[]; result?: Record<string, { b: string[]; a: string[] }> };
        // A partial error (e.g. ETHSOL unknown) is fine — we fall back to synthetic.
        // A total failure (no result at all) is a hard error.
        if (!data.result) throw new Error(`Kraken REST error: ${(data.error ?? []).join(", ")}`);
        const res_ = data.result;
        const ethKey    = Object.keys(res_).find(k => k.includes("ETH") && k.includes("USD"));
        const solKey    = Object.keys(res_).find(k => k.startsWith("SOL") && k.endsWith("USD"));
        if (!ethKey || !solKey) throw new Error("Missing ETH/USD or SOL/USD in Kraken response");
        const ethBid = parseFloat(res_[ethKey].b[0]);
        const ethAsk = parseFloat(res_[ethKey].a[0]);
        const solBid = parseFloat(res_[solKey].b[0]);
        const solAsk = parseFloat(res_[solKey].a[0]);
        // Try to find the direct ETH/SOL pair under any key variant (ETHSOL, XETHZSOL, etc.)
        const ethSolKey = Object.keys(res_).find(k => k.includes("ETH") && k.includes("SOL"));
        let ethSolBid: number;
        let ethSolAsk: number;
        if (ethSolKey) {
          ethSolBid   = parseFloat(res_[ethSolKey].b[0]);
          ethSolAsk   = parseFloat(res_[ethSolKey].a[0]);
          ethSolSource = "direct";
        } else {
          // Direct market unavailable — synthesise from USD legs.
          // synthetic bid = ethBid / solAsk  (worst case: sell ETH cheap, pay high SOL)
          // synthetic ask = ethAsk / solBid  (worst case: buy ETH dear, receive low SOL)
          ethSolBid   = solAsk > 0 ? ethBid / solAsk : 0;
          ethSolAsk   = solBid > 0 ? ethAsk / solBid : 0;
          ethSolSource = "synthetic";
          req.log.warn({ ethKey, solKey }, "ETH/SOL direct market absent in REST response — using synthetic cross rate");
        }
        ethPrices = { ethBid, ethAsk, solBid, solAsk, ethSolBid, ethSolAsk };
      } catch (e) {
        res.status(500).json({ error: `ETH tri prices unavailable: ${(e as Error).message}` });
        return;
      }
    }

    // Guard: reject if the ETH/SOL rate (direct or synthetic) resolved to zero/NaN,
    // which would produce nonsense volumes and a silent profit miscalculation.
    if (!ethPrices || !(ethPrices.ethSolBid > 0) || !(ethPrices.ethSolAsk > 0)) {
      res.status(500).json({
        error: "ETH/SOL rate is zero or invalid — cannot compute triangular volumes safely. " +
               "The direct market may be unavailable and the synthetic cross rate produced unusable prices.",
      });
      return;
    }

    // Guard: synthetic cross rates are NOT executable order-book prices.
    // Leg 2 of every ETH loop places an order on the ETHSOL pair; if that market
    // is absent, the leg will be rejected by Kraken, leaving leg 1 open and
    // requiring an unwind. Block live execution proactively instead of gambling
    // on leg 2 succeeding with a price that does not reflect a real bid/ask.
    if (!isDryRun && ethSolSource === "synthetic") {
      req.log.warn({ loop, ethSolSource }, "Live ETH triangular execution blocked — ETHSOL market unavailable");
      res.json({
        success: false, isDryRun: false, estimatedProfitUsd: null,
        leg1OrderId: null, leg2OrderId: null, leg3OrderId: null,
        error: "ETH/SOL direct market is currently unavailable on Kraken. " +
               "Live triangular execution requires a real ETHSOL order book — a synthetic cross rate cannot be submitted as a limit or market order. " +
               "Use dry-run mode to estimate profit, or wait for the direct market to come online.",
        priceSource: "synthetic",
        synthetic: true,
      });
      return;
    }
  }

  // 2. Determine trade size (USD)
  // Python: force = min(usd, 10); auto-loop = min(usd * 0.2, 50)
  let tradeUsd = overrideUsd;
  if (tradeUsd == null) {
    if (isDryRun || !useLimit) {
      tradeUsd = 10; // force / dry-run: $10 test
    } else {
      // auto-loop: 20% of USD balance, max $50
      const balances = await getKrakenBalances(creds);
      const usdBal = balances.find(b => ["ZUSD", "USD"].includes(b.currency))?.amount ?? 0;
      tradeUsd = Math.min(usdBal * 0.2, 50);
      if (tradeUsd < 1) {
        res.json({ success: false, isDryRun: false, estimatedProfitUsd: 0, error: "Insufficient USD balance (< $5)" });
        return;
      }
    }
  }

  // 3. Compute raw volumes (no per-leg fee in amounts — Python does the same).
  //    Profit estimate uses flat fee deduction: gross − TRI_TOTAL_FEES_PCT.
  let grossPct: number;
  let leg1Vol: number; // primary asset volume for leg1/leg3
  let leg2Vol: number; // intermediate asset volume for leg2

  if (isBtc) {
    const { solBid, solAsk, btcBid, btcAsk, solBtcBid, solBtcAsk } = btcPrices!;
    if (loop === "USD→BTC→SOL→USD") {
      // USD → buy BTC → buy SOL with BTC → sell SOL for USD
      leg1Vol  = tradeUsd / btcAsk;           // BTC amount
      leg2Vol  = leg1Vol / solBtcAsk;          // SOL amount
      grossPct = (leg2Vol * solBid / tradeUsd - 1) * 100;
    } else {
      // USD → buy SOL → sell SOL for BTC → sell BTC for USD
      leg1Vol  = tradeUsd / solAsk;            // SOL amount
      leg2Vol  = leg1Vol * solBtcBid;          // BTC amount
      grossPct = (leg2Vol * btcBid / tradeUsd - 1) * 100;
    }
  } else {
    const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk } = ethPrices!;
    // ethSolBid/Ask = SOL per ETH on ETHSOL pair (ETH=base, SOL=quote)
    if (loop === "USD→SOL→ETH→USD") {
      // USD → buy SOL → buy ETH (pay SOL) → sell ETH for USD
      leg1Vol  = tradeUsd / solAsk;            // SOL amount purchased
      leg2Vol  = leg1Vol / ethSolAsk;          // ETH amount (solAmt / (SOL per ETH) = ETH)
      grossPct = (leg2Vol * ethBid / tradeUsd - 1) * 100;
    } else {
      // USD → buy ETH → sell ETH for SOL → sell SOL for USD
      leg1Vol  = tradeUsd / ethAsk;            // ETH amount purchased
      leg2Vol  = leg1Vol * ethSolBid;          // SOL amount (ethAmt × SOL/ETH at bid = SOL)
      grossPct = (leg2Vol * solBid / tradeUsd - 1) * 100;
    }
  }

  const estimatedProfitUsd = (grossPct - TRI_TOTAL_FEES_PCT) / 100 * tradeUsd;

  if (isDryRun) {
    const triPriceSource = isBtc ? "direct" : ethSolSource;
    req.log.info({ loop, tradeUsd, grossPct, estimatedProfitUsd, orderType, triPriceSource }, "Triangular dry run");
    res.json({
      success: true, isDryRun: true, estimatedProfitUsd,
      priceSource: triPriceSource, synthetic: triPriceSource === "synthetic",
      leg1OrderId: null, leg2OrderId: null, leg3OrderId: null,
    });
    return;
  }

  // PROFITABILITY SAFEGUARD: legacy post-only (maker) triangular path must clear
  // the same raised maker floor as the safeguarded executor — thin maker edges
  // are proven realized losers. Market (force) path keeps its own gates.
  if (useLimit) {
    const floor = makerFloorUsd(tradeUsd, 0);
    if (estimatedProfitUsd <= floor) {
      req.log.info({ loop, tradeUsd, estimatedProfitUsd, makerFloorUsd: floor }, "Triangular REJECTED — maker floor (audit-based safeguard)");
      res.json({ success: false, isDryRun: false, estimatedProfitUsd, leg1OrderId: null, leg2OrderId: null, leg3OrderId: null,
        error: `Maker safeguard: expected net $${estimatedProfitUsd.toFixed(4)} ≤ maker floor $${floor.toFixed(4)} (historical completion/unwind cost — thin maker trades averaged −$0.19 realized). Route skipped.` });
      return;
    }
  }

  // 4. Execute 3 sequential orders.
  //    On failure: cancel unfilled limit orders or place reverse market orders to unwind.
  let leg1Id = "";
  let leg2Id = "";
  let leg3Id = "";

  try {
    // ── BTC loops ────────────────────────────────────────────────────────────
    if (isBtc) {
      const { solBid, solAsk, btcAsk, solBtcAsk, solBtcBid, btcBid } = btcPrices!;
      const plannedBtcAmt = leg1Vol;
      const plannedSolAmt = leg2Vol;

      if (loop === "USD→BTC→SOL→USD") {
        // USD → buy BTC → buy SOL with BTC → sell SOL for USD
        //
        // For limit orders we track actual filled amounts from krakenOrderInfo
        // and use them to size subsequent legs and any unwind orders.
        //
        // SOLXBT: SOL=base, BTC=quote
        //   buy: vol_exec=SOL acquired, cost=BTC spent, fee=BTC
        // SOLUSD: SOL=base, USD=quote
        //   sell: vol_exec=SOL sold, cost=USD received, fee=USD

        // Leg 1: buy BTC with USD (XXBTZUSD buy: vol_exec=BTC, cost=USD)
        let actualBtcAmt = plannedBtcAmt;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedBtcAmt, btcAsk, "XXBTZUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedBtcAmt,         "XXBTZUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 BTC buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "XXBTZUSD", `sell ${f1.volExec.toFixed(8)} BTC partial leg1`, log);
            throw new Error(`Leg 1 BTC buy timed out — cancelled. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} BTC unwound.` : "No fill."}`);
          }
          actualBtcAmt = f1.volExec; // actual BTC acquired; use for leg 2 sizing
        }

        // Leg 2: buy SOL with BTC (SOLXBT buy)
        // Scale plan to actual leg-1 fill; for market orders use planned vol.
        const leg2SolAmt = useLimit ? actualBtcAmt / solBtcAsk : plannedSolAmt;
        let actualSolAmt = leg2SolAmt;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", leg2SolAmt, solBtcAsk, "SOLXBT")
            : await krakenRawMarketOrder(creds, "buy", leg2SolAmt,            "SOLXBT");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualBtcAmt, "XXBTZUSD", "sell BTC (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 SOL buy", log);
          if (!f2.filled) {
            // SOLXBT buy: vol_exec=SOL acquired, cost+fee=BTC consumed
            const btcConsumed = f2.cost + f2.fee;
            const btcRemaining = Math.max(0, actualBtcAmt - btcConsumed);
            if (f2.volExec > 0) await tryUnwindMarket(creds, "sell", f2.volExec, "SOLUSD",    `sell ${f2.volExec.toFixed(8)} SOL partial leg2`, log);
            if (btcRemaining > 0) await tryUnwindMarket(creds, "sell", btcRemaining, "XXBTZUSD", `sell ${btcRemaining.toFixed(8)} BTC remaining leg1`, log);
            throw new Error(`Leg 2 SOL buy timed out. SOL ${f2.volExec.toFixed(8)} + BTC ${btcRemaining.toFixed(8)} unwound.`);
          }
          actualSolAmt = f2.volExec; // actual SOL acquired; use for leg 3
        }

        // Leg 3: sell SOL for USD (SOLUSD sell)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualSolAmt, solBid, "SOLUSD")
            : await krakenRawMarketOrder(creds, "sell", actualSolAmt,         "SOLUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt, "SOLUSD", "sell SOL (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (SOL unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 SOL sell", log);
          if (!f3.filled) {
            const solRemaining = Math.max(0, actualSolAmt - f3.volExec);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD", `sell ${solRemaining.toFixed(8)} SOL remaining leg3`, log);
            throw new Error(`Leg 3 SOL sell timed out. ${solRemaining.toFixed(8)} SOL remaining unwound.`);
          }
        }

      } else {
        // USD→SOL→BTC→USD
        // USD → buy SOL → sell SOL for BTC → sell BTC for USD
        //
        // SOLXBT: SOL=base, BTC=quote
        //   sell: vol_exec=SOL sold, cost=BTC received, fee=BTC → btcAcquired = cost - fee
        // XXBTZUSD: BTC=base, USD=quote
        //   sell: vol_exec=BTC sold, cost=USD received, fee=USD
        const plannedSolAmt2 = leg1Vol;
        const plannedBtcAmt2 = leg2Vol;

        // Leg 1: buy SOL with USD (SOLUSD buy: vol_exec=SOL, cost=USD)
        let actualSolAmt2 = plannedSolAmt2;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedSolAmt2, solAsk, "SOLUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedSolAmt2,         "SOLUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 SOL buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "SOLUSD", `sell ${f1.volExec.toFixed(8)} SOL partial leg1`, log);
            throw new Error(`Leg 1 SOL buy timed out. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} SOL unwound.` : "No fill."}`);
          }
          actualSolAmt2 = f1.volExec;
        }

        // Leg 2: sell SOL for BTC (SOLXBT sell)
        let actualBtcAmt2 = useLimit ? actualSolAmt2 * solBtcBid : plannedBtcAmt2;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualSolAmt2, solBtcBid, "SOLXBT")
            : await krakenRawMarketOrder(creds, "sell", actualSolAmt2,            "SOLXBT");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt2, "SOLUSD", "sell SOL (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 SOL sell", log);
          if (!f2.filled) {
            // SOLXBT sell: vol_exec=SOL sold, cost-fee=BTC acquired
            const btcAcquired = Math.max(0, f2.cost - f2.fee);
            const solRemaining = Math.max(0, actualSolAmt2 - f2.volExec);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD",    `sell ${solRemaining.toFixed(8)} SOL remaining leg2`, log);
            if (btcAcquired > 0) await tryUnwindMarket(creds, "sell", btcAcquired,  "XXBTZUSD", `sell ${btcAcquired.toFixed(8)} BTC partial leg2`, log);
            throw new Error(`Leg 2 SOL sell timed out. SOL ${solRemaining.toFixed(8)} + BTC ${btcAcquired.toFixed(8)} unwound.`);
          }
          actualBtcAmt2 = Math.max(0, f2.cost - f2.fee); // actual BTC received
        }

        // Leg 3: sell BTC for USD (XXBTZUSD sell)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualBtcAmt2, btcBid, "XXBTZUSD")
            : await krakenRawMarketOrder(creds, "sell", actualBtcAmt2,         "XXBTZUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualBtcAmt2, "XXBTZUSD", "sell BTC (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (BTC unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 BTC sell", log);
          if (!f3.filled) {
            const btcRemaining = Math.max(0, actualBtcAmt2 - f3.volExec);
            if (btcRemaining > 0) await tryUnwindMarket(creds, "sell", btcRemaining, "XXBTZUSD", `sell ${btcRemaining.toFixed(8)} BTC remaining leg3`, log);
            throw new Error(`Leg 3 BTC sell timed out. ${btcRemaining.toFixed(8)} BTC remaining unwound.`);
          }
        }
      }

    // ── ETH loops ────────────────────────────────────────────────────────────
    } else {
      const { solBid, solAsk, ethBid, ethAsk, ethSolBid, ethSolAsk } = ethPrices!;

      // ETHSOL on Kraken: ETH=base, SOL=quote.
      //   "buy"  ETHSOL → buy ETH, pay SOL  — vol_exec=ETH acquired, cost+fee=SOL spent
      //   "sell" ETHSOL → sell ETH, get SOL — vol_exec=ETH sold, cost-fee=SOL received

      if (loop === "USD→SOL→ETH→USD") {
        // USD → buy SOL → buy ETH (pay SOL) → sell ETH for USD
        const plannedSolAmt = leg1Vol;
        const plannedEthAmt = leg2Vol;

        // Leg 1: buy SOL with USD (SOLUSD buy: vol_exec=SOL, cost=USD)
        let actualSolAmt = plannedSolAmt;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedSolAmt, solAsk, "SOLUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedSolAmt,         "SOLUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 SOL buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "SOLUSD", `sell ${f1.volExec.toFixed(8)} SOL partial leg1`, log);
            throw new Error(`Leg 1 SOL buy timed out. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} SOL unwound.` : "No fill."}`);
          }
          actualSolAmt = f1.volExec;
        }

        // Leg 2: buy ETH on ETHSOL (pay SOL, receive ETH)
        // ETHSOL buy: vol_exec=ETH acquired, cost+fee=SOL spent
        const leg2EthAmt = useLimit ? actualSolAmt / ethSolAsk : plannedEthAmt;
        let actualEthAmt = leg2EthAmt;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", leg2EthAmt, ethSolAsk, "ETHSOL")
            : await krakenRawMarketOrder(creds, "buy", leg2EthAmt,            "ETHSOL");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt, "SOLUSD", "sell SOL (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 ETH buy", log);
          if (!f2.filled) {
            // ETHSOL buy: vol_exec=ETH acquired, cost+fee=SOL consumed
            const solConsumed = f2.cost + f2.fee;
            const solRemaining = Math.max(0, actualSolAmt - solConsumed);
            if (f2.volExec > 0) await tryUnwindMarket(creds, "sell", f2.volExec, "XETHZUSD", `sell ${f2.volExec.toFixed(8)} ETH partial leg2`, log);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD",  `sell ${solRemaining.toFixed(8)} SOL remaining leg1`, log);
            throw new Error(`Leg 2 ETH buy timed out. ETH ${f2.volExec.toFixed(8)} + SOL ${solRemaining.toFixed(8)} unwound.`);
          }
          actualEthAmt = f2.volExec;
        }

        // Leg 3: sell ETH for USD (XETHZUSD sell: vol_exec=ETH sold, cost=USD received)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualEthAmt, ethBid, "XETHZUSD")
            : await krakenRawMarketOrder(creds, "sell", actualEthAmt,         "XETHZUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualEthAmt, "XETHZUSD", "sell ETH for USD (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (ETH unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 ETH sell", log);
          if (!f3.filled) {
            const ethRemaining = Math.max(0, actualEthAmt - f3.volExec);
            if (ethRemaining > 0) await tryUnwindMarket(creds, "sell", ethRemaining, "XETHZUSD", `sell ${ethRemaining.toFixed(8)} ETH remaining leg3`, log);
            throw new Error(`Leg 3 ETH sell timed out. ${ethRemaining.toFixed(8)} ETH remaining unwound.`);
          }
        }

      } else {
        // USD→ETH→SOL→USD
        // USD → buy ETH → sell ETH for SOL → sell SOL for USD
        //
        // ETHSOL sell: vol_exec=ETH sold, cost-fee=SOL received
        const plannedEthAmt2 = leg1Vol;
        const plannedSolAmt2 = leg2Vol;

        // Leg 1: buy ETH with USD (XETHZUSD buy: vol_exec=ETH, cost=USD)
        let actualEthAmt2 = plannedEthAmt2;
        try {
          const r1 = useLimit
            ? await krakenRawLimitOrder(creds, "buy", plannedEthAmt2, ethAsk, "XETHZUSD")
            : await krakenRawMarketOrder(creds, "buy", plannedEthAmt2,         "XETHZUSD");
          leg1Id = r1.txid[0] ?? "";
        } catch (e) {
          throw new Error(`Leg 1 failed: ${(e as Error).message}`);
        }
        if (useLimit) {
          const f1 = await waitForTriLimitFill(creds, leg1Id, "leg1 ETH buy", log);
          if (!f1.filled) {
            if (f1.volExec > 0) await tryUnwindMarket(creds, "sell", f1.volExec, "XETHZUSD", `sell ${f1.volExec.toFixed(8)} ETH partial leg1`, log);
            throw new Error(`Leg 1 ETH buy timed out. ${f1.volExec > 0 ? `Partial ${f1.volExec.toFixed(8)} ETH unwound.` : "No fill."}`);
          }
          actualEthAmt2 = f1.volExec;
        }

        // Leg 2: sell ETH on ETHSOL (receive SOL)
        // ETHSOL sell: vol_exec=ETH sold, cost-fee=SOL received
        let actualSolAmt2 = useLimit ? actualEthAmt2 * ethSolBid : plannedSolAmt2;
        try {
          const r2 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualEthAmt2, ethSolBid, "ETHSOL")
            : await krakenRawMarketOrder(creds, "sell", actualEthAmt2,            "ETHSOL");
          leg2Id = r2.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualEthAmt2, "XETHZUSD", "sell ETH (unwind leg1)", log);
          throw new Error(`Leg 2 failed (leg 1 unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f2 = await waitForTriLimitFill(creds, leg2Id, "leg2 ETH sell", log);
          if (!f2.filled) {
            // ETHSOL sell: vol_exec=ETH sold, cost-fee=SOL received
            const solAcquired = Math.max(0, f2.cost - f2.fee);
            const ethRemaining = Math.max(0, actualEthAmt2 - f2.volExec);
            if (ethRemaining > 0) await tryUnwindMarket(creds, "sell", ethRemaining, "XETHZUSD", `sell ${ethRemaining.toFixed(8)} ETH remaining leg2`, log);
            if (solAcquired > 0) await tryUnwindMarket(creds, "sell", solAcquired,   "SOLUSD",   `sell ${solAcquired.toFixed(8)} SOL partial leg2`, log);
            throw new Error(`Leg 2 ETH sell timed out. ETH ${ethRemaining.toFixed(8)} + SOL ${solAcquired.toFixed(8)} unwound.`);
          }
          actualSolAmt2 = Math.max(0, f2.cost - f2.fee); // actual SOL received
        }

        // Leg 3: sell SOL for USD (SOLUSD sell: vol_exec=SOL sold, cost=USD received)
        try {
          const r3 = useLimit
            ? await krakenRawLimitOrder(creds, "sell", actualSolAmt2, solBid, "SOLUSD")
            : await krakenRawMarketOrder(creds, "sell", actualSolAmt2,         "SOLUSD");
          leg3Id = r3.txid[0] ?? "";
        } catch (e) {
          await tryUnwindMarket(creds, "sell", actualSolAmt2, "SOLUSD", "sell SOL (unwind after leg3 rejected)", log);
          throw new Error(`Leg 3 failed (SOL unwound): ${(e as Error).message}`);
        }
        if (useLimit) {
          const f3 = await waitForTriLimitFill(creds, leg3Id, "leg3 SOL sell", log);
          if (!f3.filled) {
            const solRemaining = Math.max(0, actualSolAmt2 - f3.volExec);
            if (solRemaining > 0) await tryUnwindMarket(creds, "sell", solRemaining, "SOLUSD", `sell ${solRemaining.toFixed(8)} SOL remaining leg3`, log);
            throw new Error(`Leg 3 SOL sell timed out. ${solRemaining.toFixed(8)} SOL remaining unwound.`);
          }
        }
      }
    }

    const triPriceSource = isBtc ? "direct" : ethSolSource;
    req.log.info({ loop, tradeUsd, estimatedProfitUsd, orderType, triPriceSource, leg1Id, leg2Id, leg3Id }, "Triangular executed");
    // Legacy tri executor: no per-leg fill evidence is persisted here, so a
    // completed run is recorded as ESTIMATED — it never counts toward the
    // verified realized P&L.
    try {
      await db.insert(tradesTable).values({
        pair: loop, buyExchange: "kraken", sellExchange: "kraken",
        volume: leg1Vol.toFixed(8),
        estimatedProfitUsd: estimatedProfitUsd.toFixed(6),
        netEdgePct: (grossPct - TRI_TOTAL_FEES_PCT).toFixed(4),
        isDryRun: false, krakenPrice: "0", coinbasePrice: "0",
        buyOrderId: leg1Id || null, sellOrderId: leg3Id || null,
        status: "estimated",
      });
    } catch (e) { req.log.error({ e }, "tri ledger row failed"); }
    await snapshotAccountValue(creds, "post_trade", req.log);
    res.json({
      success: true, isDryRun: false, estimatedProfitUsd,
      priceSource: triPriceSource, synthetic: triPriceSource === "synthetic",
      leg1OrderId: leg1Id, leg2OrderId: leg2Id, leg3OrderId: leg3Id,
    });
  } catch (err) {
    req.log.error({ err, loop, orderType, leg1Id, leg2Id }, "Triangular execution error — partial state logged");
    // A leg may have been accepted before the failure — balances may have moved.
    if (leg1Id || leg2Id || leg3Id) {
      try {
        await db.insert(tradesTable).values({
          pair: `${loop} [FAILED: ${(err as Error).message.slice(0, 120)}]`,
          buyExchange: "kraken", sellExchange: "kraken",
          volume: leg1Vol.toFixed(8),
          estimatedProfitUsd: estimatedProfitUsd.toFixed(6),
          netEdgePct: "0",
          isDryRun: false, krakenPrice: "0", coinbasePrice: "0",
          buyOrderId: leg1Id || null, sellOrderId: leg3Id || null,
          status: "failed",
          realizedProfitUsd: null, // fills/unwinds not reconciled — unknown, never an estimate
        });
      } catch (e) { req.log.error({ e }, "tri FAILED ledger row failed"); }
      await snapshotAccountValue(creds, "post_trade", req.log);
    }
    res.status(500).json({ error: (err as Error).message, leg1OrderId: leg1Id || null, leg2OrderId: leg2Id || null });
  }
});

// ── GET /credentials/preloaded ────────────────────────────────────────────────
router.get("/credentials/preloaded", async (_req, res): Promise<void> => {
  const krakenKey = process.env["KRAKEN_API_KEY"] ?? "";
  const krakenSecret = process.env["KRAKEN_SECRET"] ?? "";
  const coinbaseKey = process.env["COINBASE_API_KEY"] ?? "";
  const coinbaseSecret = process.env["COINBASE_SECRET"] ?? "";
  const anyLoaded = !!(krakenKey || krakenSecret || coinbaseKey || coinbaseSecret);
  res.json({ krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, anyLoaded });
});

// ── POST /prices ──────────────────────────────────────────────────────────────
// Scans all 10 pairs and returns the best cross-exchange opportunity.
router.post("/prices", async (req, res): Promise<void> => {
  const parsed = FetchPricesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const enabledPairs = parsed.data.enabledPairs;
    const prices = await getBestPairPrices(enabledPairs);

    if (!prices) {
      res.status(500).json({ error: "Could not fetch prices from Kraken or Coinbase for any pair" });
      return;
    }

    const {
      pair,
      kraken: krakenMid, krakenBid, krakenAsk,
      coinbase: coinbaseMid, coinbaseBid, coinbaseAsk,
      binance: binancePrice, kucoin: kuCoinPrice,
      wsKraken, wsCoinbase,
    } = prices;

    const krakenPrice   = krakenMid;
    const coinbasePrice = coinbaseMid;

    if (!krakenMid || !coinbaseMid) {
      res.status(500).json({ error: `Could not fetch prices from Kraken or Coinbase for ${pair}` });
      return;
    }

    const kAsk = krakenAsk   ?? krakenMid;
    const kBid = krakenBid   ?? krakenMid;
    const cAsk = coinbaseAsk ?? coinbaseMid;
    const cBid = coinbaseBid ?? coinbaseMid;

    // Route 1: buy at Kraken ask, sell at Coinbase bid
    const kToCPct = ((cBid - kAsk) / kAsk) * 100;
    // Route 2: buy at Coinbase ask, sell at Kraken bid
    const cToKPct = ((kBid - cAsk) / cAsk) * 100;

    const useKraken = kToCPct >= cToKPct;
    const bestBuyExchange  = useKraken ? "Kraken"   : "Coinbase";
    const bestSellExchange = useKraken ? "Coinbase" : "Kraken";
    const buyPrice         = useKraken ? kAsk       : cAsk;
    const sellPrice        = useKraken ? cBid       : kBid;

    const grossSpreadPct = useKraken ? kToCPct : cToKPct;
    const route = `Buy ${bestBuyExchange} → Sell ${bestSellExchange}`;

    req.log.info({ pair, krakenPrice, coinbasePrice, grossSpreadPct, bestBuyExchange, bestSellExchange }, "Prices fetched");

    res.json({
      pair,
      krakenPrice,
      krakenBid:   kBid,
      krakenAsk:   kAsk,
      coinbasePrice,
      coinbaseBid:  cBid,
      coinbaseAsk:  cAsk,
      binancePrice: binancePrice ?? null,
      kuCoinPrice:  kuCoinPrice  ?? null,
      grossSpreadPct, // gross only — net edge is client-side: gross − (fees + slippage)
      route,
      buyExchange: bestBuyExchange,
      sellExchange: bestSellExchange,
      bestBuyExchange,
      bestSellExchange,
      buyPrice,
      sellPrice,
      executable: true,
      wsStatus: { kraken: wsKraken, coinbase: wsCoinbase },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch prices");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /balances ────────────────────────────────────────────────────────────
// Kraken uses non-standard currency codes for some assets in balance responses.
// This helper maps a canonical symbol (e.g. "BTC") to the set of codes Kraken
// may return, so we can find the right balance entry regardless of representation.
function krakenCurrencyCodes(asset: string): string[] {
  const u = asset.toUpperCase();
  const aliases: Record<string, string[]> = {
    BTC:  ["XBT", "XXBT"],
    ETH:  ["ETH", "XETH"],
    SOL:  ["SOL", "SOL.S"],
    AVAX: ["AVAX"],
    DOT:  ["DOT"],
    POL:  ["POL"],
    LINK: ["LINK"],
    UNI:  ["UNI"],
    ATOM: ["ATOM"],
    ADA:  ["ADA"],
  };
  return aliases[u] ?? [u];
}

router.post("/balances", async (req, res): Promise<void> => {
  const parsed = FetchBalancesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, pair } = parsed.data;
  try {
    const [krakenBalances, coinbaseBalances, krakenPrice] = await Promise.all([
      getKrakenBalances({ krakenKey, krakenSecret }),
      getCoinbaseBalances({ coinbaseKey, coinbaseSecret }),
      getKrakenPrice("SOL/USD"),
    ]);

    const solOnKraken = krakenBalances.find(b => b.currency === "SOL" || b.currency === "SOL.S")?.amount ?? 0;
    const solOnCoinbase = coinbaseBalances.find(b => b.currency === "SOL")?.amount ?? 0;
    const usdOnCoinbase = coinbaseBalances.find(b => b.currency === "USD" || b.currency === "USDC")?.amount ?? 0;

    const maxSol = Math.min(solOnKraken, solOnCoinbase, krakenPrice > 0 ? usdOnCoinbase / krakenPrice : 0);
    const suggestedVolume = Math.max(maxSol * 0.8, 0.01);

    // Base-asset balances for the active pair (falls back to SOL when no pair given)
    const baseAsset = pair ? (pair.split("/")[0] ?? "SOL").toUpperCase() : "SOL";
    const krakenCodes = new Set(krakenCurrencyCodes(baseAsset).map(c => c.toUpperCase()));
    const baseAssetOnKraken = krakenBalances
      .filter(b => krakenCodes.has(b.currency.toUpperCase()))
      .reduce((sum, b) => sum + b.amount, 0);
    const baseAssetOnCoinbase = coinbaseBalances
      .filter(b => b.currency.toUpperCase() === baseAsset)
      .reduce((sum, b) => sum + b.amount, 0);

    res.json({
      kraken: krakenBalances,
      coinbase: coinbaseBalances,
      solOnKraken,
      solOnCoinbase,
      usdOnCoinbase,
      suggestedVolume,
      baseAsset,
      baseAssetOnKraken,
      baseAssetOnCoinbase,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch balances");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /exec-preview ───────────────────────────────────────────────────────
// Pre-fire breakdown for a Kraken triangle: raw top-of-book edge, taker fees
// (account's real tier when keys given), depth-walked slippage for this size,
// safety buffer, final executable net edge — plus maker net + risk-adjusted
// maker EV and which path ADAPTIVE would choose right now.
router.post("/arb/exec-preview", async (req, res): Promise<void> => {
  const parsed = ExecPreviewBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { routeDescription, krakenKey, krakenSecret } = parsed.data;
  const tradeSizeUsd = Math.min(100_000, Math.max(1, parsed.data.tradeSizeUsd));
  const m = /^USD\[K\]→([A-Z0-9]+)\[K\]→([A-Z0-9]+)\[K\]→USD\[K\]$/.exec(routeDescription);
  const fail = (error: string) => { res.json({ route: routeDescription, ok: false, error }); };
  if (!m) { fail("Preview is only available for Kraken-only triangles (USD[K]→A[K]→B[K]→USD[K])."); return; }
  const [, assetA, assetB] = m;
  if (!(OB_ASSETS as readonly string[]).includes(assetA!) || !(OB_ASSETS as readonly string[]).includes(assetB!)) {
    fail(`Unknown asset(s): ${assetA}/${assetB}`); return;
  }
  try {
    const creds = krakenKey && krakenSecret ? { krakenKey, krakenSecret } : null;
    const pairs = [OB_USD_PAIRS[assetA as ObAsset], OB_USD_PAIRS[assetB as ObAsset]].filter(Boolean);
    const tiers = creds ? await krakenFeeTiers(creds, pairs) : null;
    const takerFeePct = tiers?.takerFeePct ?? 0.40; // conservative public assumption
    const makerFeePct = tiers?.makerFeePct ?? 0.25;
    const safetyBufferUsd = Math.max(0.02, tradeSizeUsd * 0.0005);
    // Stream-first: same in-memory snapshot the executor micro-check reads.
    const [cachedBd, makerPf] = await Promise.all([
      cachedTakerCycleBreakdown(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, takerFeePct, 30_000),
      preflightObCycle(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, makerFeePct, "maker"),
    ]);
    let bd = cachedBd?.ok ? cachedBd.bd : null;
    let quoteAgeMs: number | null = cachedBd?.ok ? cachedBd.quoteAgeMs : null;
    let asOf: string | null = cachedBd?.ok ? new Date(cachedBd.marketUpdateMs).toISOString() : null;
    if (!bd) {
      bd = await takerCycleBreakdown(assetA as ObAsset, assetB as ObAsset, tradeSizeUsd, takerFeePct);
      if (bd) { quoteAgeMs = null; asOf = new Date().toISOString(); } // REST fetch — fresh but not streamed
    }
    if (!bd) { fail("Could not fetch fresh order books (or depth can't absorb the size)."); return; }
    const netEdgeUsd = bd.netProfitUsd - safetyBufferUsd;
    const makerNetUsd = makerPf?.profitUsd ?? null;
    // Maker EV mirrors the adaptive decision in graph-execute: measured
    // per-leg fill history when ≥5 samples, conservative default otherwise.
    const accountId = creds ? accountIdFromKey(krakenKey!, undefined) : "anon";
    const risk = await routeLegRisk(routeDescription, "maker", accountId);
    const evM = makerNetUsd != null ? riskAdjustedEv(risk, makerNetUsd, tradeSizeUsd) : null;
    const makerFillProbability = evM ? evM.pAll : makerNetUsd != null ? 0.55 : null;
    const makerEvUsd = evM ? evM.evUsd : makerNetUsd != null ? makerNetUsd * 0.55 - 0.45 * DEFAULT_UNWIND_LOSS_FRAC * tradeSizeUsd : null;
    // Mirror the live adaptive decision (profitability-first) against the trader's floor:
    // taker net ≥ floor → taker; else maker expected realized ≥ floor → maker; else skip.
    const minFloor = Math.max(0, parsed.data.minProfitUsd ?? 0);
    const adaptiveChoice = netEdgeUsd >= minFloor ? "taker"
      : makerEvUsd != null && makerEvUsd >= makerFloorUsd(tradeSizeUsd, minFloor) ? "maker" : "skip";
    res.json({
      route: routeDescription, ok: true,
      rawEdgeUsd: bd.rawEdgeUsd, takerFeesUsd: bd.feesUsd, takerFeePct,
      slippageUsd: bd.slippageUsd, safetyBufferUsd, netEdgeUsd,
      expectedProfitUsd: bd.netProfitUsd, makerNetUsd, makerEvUsd, makerFillProbability, adaptiveChoice,
      quoteAgeMs, asOf,
      error: null,
    });
  } catch (e) {
    fail((e as Error).message);
  }
});

// ── GET /stream-stats (diagnostics: WS book stream health) ───────────────────
router.get("/arb/stream-stats", (_req, res) => {
  const es = getEventScan();
  res.json({
    kraken: krakenStreamStats(),
    coinbase: coinbaseStreamStats(),
    eventScan: es ? { ...es, topRoutes: es.topRoutes.slice(0, 3) } : null,
    sampleEthAgeMs: getStreamBook(OB_USD_PAIRS.ETH)?.ageMs ?? null,
    sampleCbEthAgeMs: getCoinbaseStreamBook("ETH-USD")?.ageMs ?? null,
  });
});

// ── GET /arb/inventory-imbalance ─────────────────────────────────────────────
// Per-asset inventory imbalance from LIVE cross-exchange trades: buying on one
// venue and selling pre-positioned inventory on the other shifts holdings
// (+base on the buy venue, −base on the sell venue). This ledger view tells
// the trader what needs rebalancing later — it is bookkeeping, not P&L.
router.get("/arb/inventory-imbalance", async (_req, res): Promise<void> => {
  try {
    const rows = await db.select({
      pair: tradesTable.pair, volume: tradesTable.volume, status: tradesTable.status,
      buyExchange: tradesTable.buyExchange, sellExchange: tradesTable.sellExchange,
      createdAt: tradesTable.createdAt,
    }).from(tradesTable)
      .where(dbAnd(dbEq(tradesTable.isDryRun, false), sql`${tradesTable.buyExchange} != ${tradesTable.sellExchange}`));
    const byAsset = new Map<string, { kraken: number; coinbase: number; trades: number; lastAt: string | null }>();
    for (const r of rows) {
      // Completed cross trades only — failed rows with zero fills don't move inventory.
      if (r.status !== "verified" && r.status !== "completed") continue;
      const m = /→([A-Z0-9]+)\[/.exec(r.pair ?? "") ?? /USD→([A-Z0-9]+)/.exec(r.pair ?? "");
      const assetName = m?.[1];
      const vol = parseFloat(r.volume ?? "0");
      if (!assetName || assetName === "USD" || !isFinite(vol) || vol <= 0) continue;
      const e = byAsset.get(assetName) ?? { kraken: 0, coinbase: 0, trades: 0, lastAt: null };
      if (r.buyExchange === "kraken") e.kraken += vol; else if (r.buyExchange === "coinbase") e.coinbase += vol;
      if (r.sellExchange === "kraken") e.kraken -= vol; else if (r.sellExchange === "coinbase") e.coinbase -= vol;
      e.trades += 1;
      e.lastAt = r.createdAt ? new Date(r.createdAt as unknown as string | number | Date).toISOString() : e.lastAt;
      byAsset.set(assetName, e);
    }
    res.json({
      assets: [...byAsset.entries()].map(([assetName, e]) => ({ asset: assetName, krakenDelta: e.kraken, coinbaseDelta: e.coinbase, trades: e.trades, lastTradeAt: e.lastAt })),
      note: "Deltas are base units moved by live cross-exchange inventory trades since ledger start. Positive = accumulated on that venue; negative = drawn down. Rebalance by transferring or trading back when deltas grow.",
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /arb/cross-mm-execute ───────────────────────────────────────────────
// MAKER-POST + TAKER-HEDGE cross-exchange strategy (one cycle per call).
// Rest a post-only limit on Kraken; hedge on Coinbase ONLY after a confirmed
// fill, sized from the ACTUAL fill. No fill → cancel, nothing spent. Tracked
// under execution_quality style "cross-mm" and trades pair prefix "MM:" —
// fully separate from the triangle strategy's scoreboard.
const CROSS_MM_POLL_MS = 700;
const CROSS_MM_CANCEL_CONFIRM_MS = 20_000;
router.post("/arb/cross-mm-execute", async (req, res): Promise<void> => {
  const parsed = ExecuteCrossMmBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const b = parsed.data;
  const isDryRun = b.isDryRun ?? true;
  const assetName = (b.asset || "").toUpperCase() as ObAsset;
  const mmPair = `${assetName}/USD`;
  if (!(assetName in OB_USD_PAIRS) || !(PAIRS as readonly string[]).includes(mmPair) || !getStreamBook(OB_USD_PAIRS[assetName]) || !getCoinbaseStreamBook(`${assetName}-USD`)) {
    res.json({ success: false, isDryRun, executed: false, outcome: "gate_blocked", asset: assetName, projection: null, realizedProfitUsd: null, error: `No live depth books on both venues for ${assetName} — pick an asset streaming on Kraken AND Coinbase.` });
    return;
  }
  // VALIDATION-PHASE EXPOSURE CAP: hard $10 until realized P&L proves out.
  const tradeSizeUsd = Math.min(10, Math.max(1, b.tradeSizeUsd ?? 10));
  const minProfitUsd = isDryRun ? (b.minProfitUsd ?? 0.01) : Math.max(0, b.minProfitUsd ?? 0.01);
  const maxQuoteAgeMs = Math.min(5_000, Math.max(50, Math.round(b.maxQuoteAgeMs ?? 200)));
  const restWindowMs = Math.min(120_000, Math.max(3_000, Math.round(b.restWindowMs ?? 30_000)));
  const coinbaseFeesPct = Math.max(0, b.coinbaseFeesPct ?? 0.4);
  const kCreds = { krakenKey: b.krakenKey, krakenSecret: b.krakenSecret };
  const cbCreds = { coinbaseKey: b.coinbaseKey, coinbaseSecret: b.coinbaseSecret };
  const kPair = OB_USD_PAIRS[assetName];
  const cbKey = coinbaseBookKey(`${assetName}-USD`);
  const accountId = accountIdFromKey(b.krakenKey);
  const routeTag = (d: MmDirection) => `MM:${assetName} K-${d}→CB-hedge`;

  const projOut = (p: MmProjection | null) => p && ({
    direction: p.direction, makerPrice: p.makerPrice, makerQty: p.makerQty,
    projectedNetUsd: p.projectedNetUsd, makerFeeUsd: p.makerFeeUsd, hedgeFeeUsd: p.hedgeFeeUsd,
    hedgeVwapPx: p.hedgeVwapPx, hedgeTopPx: p.hedgeTopPx, hedgeSlippageUsd: p.hedgeSlippageUsd,
    quoteAgeMs: p.quoteAgeMs, legAges: formatLegAges(p.legAges),
  });

  // Same buffer scale as every other live executor — NOT loosened.
  const bufferUsd = Math.min(tradeSizeUsd * 0.05, Math.max(0.02, tradeSizeUsd * 0.0005));

  let lockGen: number | null = null;
  if (!isDryRun) {
    if (pendingIndeterminate) {
      const out = await resolvePendingIndeterminate(kCreds, cbCreds, req.log);
      if (!out.cleared || out.message) {
        res.json({ success: false, isDryRun, executed: false, outcome: "gate_blocked", asset: assetName, projection: null, realizedProfitUsd: null, error: out.message ?? pendingIndeterminateMsg() });
        return;
      }
    }
    if (liveLockBusy()) {
      res.json({ success: false, isDryRun, executed: false, outcome: "gate_blocked", asset: assetName, projection: null, realizedProfitUsd: null, error: "Another LIVE execution is already in progress — refused to run concurrently." });
      return;
    }
    lockGen = acquireLiveLock();
    bindLockHeartbeat(liveLockHeartbeat(lockGen));
  }
  try {
    // 1. REAL Kraken maker fee tier for this pair (never assume).
    const tiers = await krakenFeeTiers(kCreds, [kPair]);
    const makerFeePct = tiers?.makerFeePct;
    if (makerFeePct == null) {
      res.json({ success: false, isDryRun, executed: false, outcome: "gate_blocked", asset: assetName, projection: null, realizedProfitUsd: null, error: "Could not fetch your real Kraken maker fee tier — refusing to project with a guess." });
      return;
    }

    // 2. Fresh projection (wait-a-tick when stale — same rule as triangles).
    const project = (): MmProjection | null => b.direction === "buy" || b.direction === "sell"
      ? projectMakerHedge(assetName, b.direction, tradeSizeUsd, makerFeePct, coinbaseFeesPct)
      : bestMakerHedgeProjection(assetName, tradeSizeUsd, makerFeePct, coinbaseFeesPct);
    let proj = project();
    if (!proj || proj.quoteAgeMs > maxQuoteAgeMs) {
      const deadline = Date.now() + Math.min(2_000, 4 * maxQuoteAgeMs);
      while (Date.now() < deadline) {
        if (!(await waitForBookTouch([kPair, cbKey], deadline - Date.now()))) break;
        proj = project();
        if (proj && proj.quoteAgeMs <= maxQuoteAgeMs) break;
      }
    }
    if (!proj || proj.quoteAgeMs > maxQuoteAgeMs) {
      res.json({ success: false, isDryRun, executed: false, outcome: "gate_blocked", asset: assetName, projection: projOut(proj), realizedProfitUsd: null, error: proj ? `Books still ${proj.quoteAgeMs}ms old (max ${maxQuoteAgeMs}ms) after waiting for fresh updates.` : "Hedge depth insufficient or books unavailable." });
      return;
    }

    // 3. Profit gate at placement: projected hedged net − buffer must clear the floor.
    req.log.info({ asset: assetName }, `[MM·DECISION] ${formatLegAges(proj.legAges)} | dir=${proj.direction} maker@${proj.makerPrice} qty=${proj.makerQty.toFixed(8)} | projected_net=$${proj.projectedNetUsd.toFixed(4)} ${proj.projectedNetUsd - bufferUsd > minProfitUsd ? ">" : "≤"} floor=$${minProfitUsd.toFixed(4)}+buffer=$${bufferUsd.toFixed(4)} | ${proj.projectedNetUsd - bufferUsd > minProfitUsd ? (isDryRun ? "WOULD POST" : "POST") : "NO POST"}`);
    if (proj.projectedNetUsd - bufferUsd <= minProfitUsd) {
      await recordQuality({ route: routeTag(proj.direction), style: "cross-mm", isDryRun, filled: false, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: isDryRun ? null : 0, note: "gate_blocked: projected net below floor at placement", accountId }, req.log);
      res.json({ success: false, isDryRun, executed: false, outcome: "gate_blocked", asset: assetName, projection: projOut(proj), realizedProfitUsd: null, error: `Projected hedged net $${proj.projectedNetUsd.toFixed(4)} − buffer $${bufferUsd.toFixed(4)} ≤ floor $${minProfitUsd.toFixed(4)} — not posting.` });
      return;
    }
    if (isDryRun) {
      res.json({ success: true, isDryRun, executed: false, outcome: "projection_only", asset: assetName, projection: projOut(proj), realizedProfitUsd: null, error: null });
      return;
    }

    // 4. Inventory check on BOTH venues before posting (pre-positioned only —
    //    a maker fill must never create an unhedgeable position).
    const [kBals, cBals] = await Promise.all([getKrakenBalances(kCreds, true), getCoinbaseBalances(cbCreds)]);
    const kVariants: Record<string, string[]> = { BTC: ["XXBT", "XBT", "BTC"], DOGE: ["XXDG", "XDG", "DOGE"], ETH: ["XETH", "ETH"], LTC: ["XLTC", "LTC"], XRP: ["XXRP", "XRP"] };
    const kAmt = (names: string[]) => kBals.filter(x => names.includes(x.currency)).reduce((a, x) => a + x.amount, 0);
    const cAmt = (name: string) => cBals.filter(x => x.currency === name).reduce((a, x) => a + x.amount, 0);
    const needQty = proj.makerQty * 1.001;
    const invErr = proj.direction === "buy"
      ? (kAmt(["ZUSD", "USD"]) < tradeSizeUsd ? `need $${tradeSizeUsd.toFixed(2)} USD on Kraken (have $${kAmt(["ZUSD", "USD"]).toFixed(2)})` : cAmt(assetName) < needQty ? `need ${needQty.toFixed(6)} ${assetName} on Coinbase to hedge (have ${cAmt(assetName).toFixed(6)})` : null)
      : (kAmt(kVariants[assetName] ?? [assetName]) < needQty ? `need ${needQty.toFixed(6)} ${assetName} on Kraken (have ${kAmt(kVariants[assetName] ?? [assetName]).toFixed(6)})` : cAmt("USD") < tradeSizeUsd * 1.02 ? `need $${(tradeSizeUsd * 1.02).toFixed(2)} USD on Coinbase to hedge incl. price-collar + fees (have $${cAmt("USD").toFixed(2)})` : null);
    if (invErr) {
      await recordQuality({ route: routeTag(proj.direction), style: "cross-mm", isDryRun: false, filled: false, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: 0, note: `inventory_blocked: ${invErr}`, accountId }, req.log);
      res.json({ success: false, isDryRun, executed: false, outcome: "inventory_blocked", asset: assetName, projection: projOut(proj), realizedProfitUsd: null, error: `Inventory check failed — ${invErr}. Pre-position inventory first.` });
      return;
    }

    // 5. Place the POST-ONLY maker order. Post-only means Kraken rejects it if
    //    it would cross — we can never accidentally pay taker here.
    const decideAtMs = Date.now();
    const direction = proj.direction;
    const placedPrice = proj.makerPrice;
    const placedQty = proj.makerQty;
    let txid: string;
    try {
      const r = await krakenRawLimitOrder(kCreds, direction, placedQty, placedPrice, kPair);
      txid = r.txid?.[0] ?? "";
      if (!txid) throw new Error("Kraken accepted the order but returned no txid");
    } catch (e) {
      const msg = (e as Error).message;
      await recordQuality({ route: routeTag(direction), style: "cross-mm", isDryRun: false, filled: false, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: 0, note: `post_rejected: ${msg.slice(0, 140)}`, accountId }, req.log);
      res.json({ success: false, isDryRun, executed: false, outcome: "post_rejected", asset: assetName, projection: projOut(proj), realizedProfitUsd: null, error: `Post-only order rejected: ${msg}` });
      return;
    }
    const placedAtMs = Date.now();
    req.log.info({ txid, asset: assetName, direction, price: placedPrice, qty: placedQty }, "[MM] post-only maker order resting on Kraken");

    // 6. Watch loop: poll the order; on every book move re-project the hedge
    //    AT OUR RESTING PRICE for the remaining qty. Projection below floor →
    //    cancel-on-move. Terminal fill → hedge.
    const safeInfo = async () => { try { return await krakenOrderInfo(kCreds, txid); } catch { return { status: "unknown", volExec: 0, price: 0, cost: 0, fee: 0 }; } };
    const terminal = (st: string) => st === "closed" || st === "canceled" || st === "expired";
    const restDeadline = Date.now() + restWindowMs;
    let info = await safeInfo();
    let cancelReason: "no_fill_cancel" | "gate_cancel" | null = null;
    while (!terminal(info.status) && Date.now() < restDeadline) {
      touchLiveLock();
      await waitForBookTouch([kPair, cbKey], CROSS_MM_POLL_MS); // wake on move OR after poll interval
      info = await safeInfo();
      if (terminal(info.status)) break;
      const remainingQty = Math.max(0, placedQty - (info.volExec || 0));
      if (remainingQty > 1e-12) {
        const live = projectMakerHedge(assetName, direction, tradeSizeUsd, makerFeePct, coinbaseFeesPct, placedPrice, remainingQty);
        // Scale floor+buffer to the remaining notional so partials aren't over-gated.
        const frac = remainingQty / placedQty;
        if (!live || live.projectedNetUsd <= (minProfitUsd + bufferUsd) * frac * 0.999) {
          cancelReason = "gate_cancel";
          req.log.info({ txid, projectedNetUsd: live?.projectedNetUsd ?? null }, "[MM] market moved — projected hedged net below floor, cancelling resting maker order");
          break;
        }
      }
    }
    if (!terminal(info.status)) {
      if (!cancelReason) cancelReason = "no_fill_cancel";
      try { await krakenCancelOrder(kCreds, txid); }
      catch (e) { req.log.error({ txid, err: e }, "[MM] cancel request failed — order may still be live"); }
      const confirmDeadline = Date.now() + CROSS_MM_CANCEL_CONFIRM_MS;
      info = await safeInfo();
      while (!terminal(info.status) && Date.now() < confirmDeadline) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, CROSS_MM_POLL_MS));
        info = await safeInfo();
      }
      if (!terminal(info.status)) {
        // Cancel ACK is NOT terminal — fail CLOSED and block all live execution
        // until this order is verified terminal (same rule as maker triangles).
        setPendingIndeterminate({ exchange: "kraken", orderId: txid, route: routeTag(direction), sinceMs: Date.now() });
        await recordQuality({ route: routeTag(direction), style: "cross-mm", isDryRun: false, filled: (info.volExec || 0) > 0, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: null, note: "indeterminate: cancel unconfirmed, live execution blocked", accountId }, req.log);
        res.json({ success: false, isDryRun, executed: (info.volExec || 0) > 0, outcome: "indeterminate", asset: assetName, projection: projOut(proj), makerOrderId: txid, realizedProfitUsd: null, error: `Could not confirm a terminal state for maker order ${txid} — live execution is blocked until it is verified. Check Kraken open orders.` });
        return;
      }
    }

    // 7. Terminal maker state — volExec is the truth (late fills in the cancel
    //    race included). Nothing filled → clean exit, $0 moved.
    const filledQty = info.volExec || 0;
    const filledAtMs = Date.now();
    if (filledQty <= 1e-12) {
      const reason = cancelReason ?? "no_fill_cancel";
      await recordQuality({ route: routeTag(direction), style: "cross-mm", isDryRun: false, filled: false, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: 0, note: reason, accountId }, req.log);
      res.json({ success: true, isDryRun, executed: false, outcome: reason, asset: assetName, projection: projOut(proj), makerOrderId: txid, makerFilledQty: 0, realizedProfitUsd: 0, latency: { decideToPlaceMs: placedAtMs - decideAtMs, restedMs: filledAtMs - placedAtMs }, error: null });
      return;
    }

    // 8. CONFIRMED FILL → hedge the ACTUAL filled qty at market on Coinbase,
    //    but only on a fresh book (wait-a-tick up to 2s). If freshness cannot
    //    be established, do NOT fire blind — record the unhedged position
    //    honestly so the trader can act.
    req.log.info({ txid, filledQty, avgPrice: info.price, cost: info.cost, fee: info.fee }, "[MM] maker fill CONFIRMED — hedging on Coinbase");
    let cbBookFresh = (getCoinbaseStreamBook(`${assetName}-USD`)?.ageMs ?? Infinity) <= maxQuoteAgeMs;
    if (!cbBookFresh) {
      const hd = Date.now() + 2_000;
      while (Date.now() < hd) {
        if (!(await waitForBookTouch([cbKey], hd - Date.now()))) break;
        if ((getCoinbaseStreamBook(`${assetName}-USD`)?.ageMs ?? Infinity) <= maxQuoteAgeMs) { cbBookFresh = true; break; }
      }
    }
    const makerNotional = info.cost || filledQty * (info.price || placedPrice);
    const makerFeeUsd = info.fee || 0;
    const ledgerRow = async (status: string, realized: number | null, hedgeOrderId: string | null, note: string) => {
      try {
        await db.insert(tradesTable).values({
          pair: `${routeTag(direction)}${note ? ` [${note.slice(0, 100)}]` : ""}`,
          buyExchange: direction === "buy" ? "kraken" : "coinbase",
          sellExchange: direction === "buy" ? "coinbase" : "kraken",
          volume: filledQty.toFixed(8), estimatedProfitUsd: proj.projectedNetUsd.toFixed(6), netEdgePct: "0",
          isDryRun: false, krakenPrice: (info.price || placedPrice).toFixed(8), coinbasePrice: "0",
          buyOrderId: direction === "buy" ? txid : hedgeOrderId, sellOrderId: direction === "buy" ? hedgeOrderId : txid,
          status, realizedProfitUsd: realized != null ? realized.toFixed(6) : null,
        });
      } catch (e) { req.log.error({ err: e }, "[MM] failed to write trades ledger row"); }
    };
    if (!cbBookFresh) {
      await ledgerRow("unhedged", null, null, "UNHEDGED: Coinbase book stale at hedge time");
      await recordQuality({ route: routeTag(direction), style: "cross-mm", isDryRun: false, filled: true, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: null, note: "unhedged: coinbase book stale — position open", accountId }, req.log);
      res.json({ success: false, isDryRun, executed: true, outcome: "unhedged", asset: assetName, projection: projOut(proj), makerOrderId: txid, makerFilledQty: filledQty, makerAvgPrice: info.price || placedPrice, realizedProfitUsd: null, error: `MAKER FILLED ${filledQty.toFixed(8)} ${assetName} but the Coinbase book went stale — hedge NOT fired. You hold an open ${direction === "buy" ? "long" : "short"} position; hedge manually or re-run when the stream recovers.` });
      return;
    }
    let hedgeOrderId: string | null = null;
    let hedge: { status: string; filledSize: number; filledValue: number; avgPrice: number; totalFees: number } | null = null;
    try {
      const hedgeSide = direction === "buy" ? "SELL" as const : "BUY" as const;
      // Bounded IOC hedge: EXACT base size, worst-case price from a FRESH
      // depth-walked projection of the actual filled qty — never Kraken's
      // price, never unbounded quote spend. 0.5% price collar caps slippage.
      const hedgeProj = projectMakerHedge(assetName, direction, tradeSizeUsd, makerFeePct, coinbaseFeesPct, placedPrice, filledQty);
      if (!hedgeProj) throw new Error("Coinbase depth insufficient for the hedge quantity on a fresh book");
      const hedgeLimitPx = direction === "buy" ? hedgeProj.hedgeVwapPx * 0.995 : hedgeProj.hedgeVwapPx * 1.005;
      const incs = await getCoinbaseProductIncrements(mmPair as Pair).catch(() => undefined);
      const r = await coinbaseIocLimitOrder(cbCreds, hedgeSide, filledQty, hedgeLimitPx, mmPair as Pair, incs);
      hedgeOrderId = r.orderId ?? null;
      if (!hedgeOrderId) throw new Error("Coinbase accepted the hedge but returned no order id");
      for (let i = 0; i < 30; i++) {
        touchLiveLock();
        await new Promise(rr => setTimeout(rr, 500));
        try { const d = await coinbaseOrderDetails(cbCreds, hedgeOrderId); if (["FILLED", "CANCELLED", "EXPIRED", "FAILED"].includes(d.status)) { hedge = d; break; } } catch { /* keep polling */ }
      }
      if (!hedge) { try { hedge = await coinbaseOrderDetails(cbCreds, hedgeOrderId); } catch { /* fall through */ } }
    } catch (e) {
      req.log.error({ err: e }, "[MM] hedge order failed");
    }
    const hedgedAtMs = Date.now();
    if (!hedge || hedge.filledSize <= 1e-12) {
      await ledgerRow("unhedged", null, hedgeOrderId, "UNHEDGED: Coinbase hedge did not fill");
      await recordQuality({ route: routeTag(direction), style: "cross-mm", isDryRun: false, filled: true, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: null, note: "unhedged: hedge order failed or zero fill — position open", accountId }, req.log);
      res.json({ success: false, isDryRun, executed: true, outcome: "unhedged", asset: assetName, projection: projOut(proj), makerOrderId: txid, makerFilledQty: filledQty, makerAvgPrice: info.price || placedPrice, hedgeOrderId, realizedProfitUsd: null, error: `MAKER FILLED ${filledQty.toFixed(8)} ${assetName} but the Coinbase hedge did not fill — you hold an open position. Hedge manually.` });
      return;
    }
    // 9. PARTIAL HEDGE = NOT closed. A residual position is open, so the
    //    cycle's P&L is NOT realized — record it as unhedged with the exact
    //    residual, never as a verified win. (Scoreboard integrity > optics.)
    if (hedge.filledSize < filledQty * 0.999) {
      const residual = filledQty - hedge.filledSize;
      const partialTag = `partial hedge ${hedge.filledSize.toFixed(8)}/${filledQty.toFixed(8)} — residual ${residual.toFixed(8)} ${assetName} open`;
      await ledgerRow("unhedged", null, hedgeOrderId, `UNHEDGED: ${partialTag}`);
      await recordQuality({ route: routeTag(direction), style: "cross-mm", isDryRun: false, filled: true, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: null, note: `unhedged: ${partialTag}`, accountId }, req.log);
      res.json({ success: false, isDryRun, executed: true, outcome: "unhedged", asset: assetName, projection: projOut(proj), makerOrderId: txid, makerFilledQty: filledQty, makerAvgPrice: info.price || placedPrice, hedgeOrderId, hedgeFilledUsd: hedge.filledValue, realizedProfitUsd: null, error: `Hedge filled PARTIALLY (${partialTag}) — you hold an open ${direction === "buy" ? "long" : "short"} residual. Close it manually; P&L is not realized until then.` });
      return;
    }
    // 10. FULLY hedged — fee-inclusive realized P&L from ACTUAL fills on both legs.
    //     buy-maker: bought base on Kraken (cost+fee out), sold on CB (value−fee in)
    //     sell-maker: sold base on Kraken (cost−fee in), bought back on CB (value+fee out)
    const realized = direction === "buy"
      ? (hedge.filledValue - hedge.totalFees) - (makerNotional + makerFeeUsd)
      : (makerNotional - makerFeeUsd) - (hedge.filledValue + hedge.totalFees);
    await ledgerRow("verified", realized, hedgeOrderId, "");
    await recordQuality({ route: routeTag(direction), style: "cross-mm", isDryRun: false, filled: true, tradeSizeUsd, expectedProfitUsd: proj.projectedNetUsd, realizedProfitUsd: realized, note: "hedged", accountId }, req.log);
    req.log.info({ txid, hedgeOrderId, realized: realized.toFixed(6), expected: proj.projectedNetUsd.toFixed(6) }, "[MM] cycle complete — hedged");
    res.json({ success: true, isDryRun, executed: true, outcome: "hedged", asset: assetName, projection: projOut(proj), makerOrderId: txid, makerFilledQty: filledQty, makerAvgPrice: info.price || placedPrice, hedgeOrderId, hedgeFilledUsd: hedge.filledValue, realizedProfitUsd: realized, latency: { decideToPlaceMs: placedAtMs - decideAtMs, restedMs: filledAtMs - placedAtMs, fillToHedgeMs: hedgedAtMs - filledAtMs }, error: null });
  } catch (err) {
    res.json({ success: false, isDryRun, executed: false, outcome: "gate_blocked", asset: assetName, projection: null, realizedProfitUsd: null, error: (err as Error).message });
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
  }
});

// ── GET /arb/cross-mm-stats ──────────────────────────────────────────────────
// Scoreboard for the maker-post/taker-hedge strategy ONLY (style "cross-mm"),
// so its realized P&L is judged separately from the triangle strategy.
router.get("/arb/cross-mm-stats", async (_req, res): Promise<void> => {
  try {
    const rows = await db.select({
      route: executionQualityTable.route, filled: executionQualityTable.filled,
      expected: executionQualityTable.expectedProfitUsd, realized: executionQualityTable.realizedProfitUsd,
      note: executionQualityTable.note, createdAt: executionQualityTable.createdAt, isDryRun: executionQualityTable.isDryRun,
    }).from(executionQualityTable)
      .where(dbAnd(dbEq(executionQualityTable.style, "cross-mm"), dbEq(executionQualityTable.isDryRun, false)))
      .orderBy(dbDesc(executionQualityTable.createdAt)).limit(500);
    const n = (v: string | null) => { const x = parseFloat(v ?? ""); return isFinite(x) ? x : null; };
    const noteHas = (r: { note: string | null }, tag: string) => (r.note ?? "").startsWith(tag);
    const attempts = rows.length;
    const makerFills = rows.filter(r => r.filled).length;
    const hedgedRows = rows.filter(r => noteHas(r, "hedged"));
    const realizedVals = hedgedRows.map(r => n(r.realized)).filter((x): x is number => x != null);
    const realizedTotalUsd = realizedVals.reduce((a, x) => a + x, 0);
    res.json({
      attempts,
      postRejected: rows.filter(r => noteHas(r, "post_rejected")).length,
      gateCancels: rows.filter(r => noteHas(r, "gate_cancel")).length,
      noFillCancels: rows.filter(r => noteHas(r, "no_fill_cancel")).length,
      makerFills,
      hedged: hedgedRows.length,
      unhedged: rows.filter(r => noteHas(r, "unhedged")).length,
      realizedTotalUsd,
      avgRealizedUsd: realizedVals.length > 0 ? realizedTotalUsd / realizedVals.length : null,
      fillRatePct: attempts > 0 ? (makerFills / attempts) * 100 : null,
      recent: rows.slice(0, 25).map(r => ({ route: r.route, filled: r.filled, expectedProfitUsd: n(r.expected), realizedProfitUsd: n(r.realized), note: r.note, createdAt: r.createdAt ? new Date(r.createdAt as unknown as string | number | Date).toISOString() : null })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /fee-tier ────────────────────────────────────────────────────────────
// Actual Kraken taker fee tier for the account (max across major pairs).
router.post("/arb/fee-tier", async (req, res): Promise<void> => {
  const parsed = GetFeeTierBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tiers = await krakenFeeTiers(parsed.data, ["XXBTZUSD", "ETHUSD", "SOLUSD"]);
  res.json({
    takerFeePct: tiers?.takerFeePct ?? null,
    makerFeePct: tiers?.makerFeePct ?? null,
    source: tiers ? "account" : "unavailable",
  });
});

// ── POST /test-kraken ─────────────────────────────────────────────────────────
router.post("/test-kraken", async (req, res): Promise<void> => {
  const parsed = TestKrakenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const balances = await getKrakenBalances(parsed.data);
    res.json({ ok: true, message: "Kraken connection successful", balances });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message, balances: [] });
  }
});

// ── POST /test-coinbase ───────────────────────────────────────────────────────
router.post("/test-coinbase", async (req, res): Promise<void> => {
  const parsed = TestCoinbaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const balances = await getCoinbaseBalances(parsed.data);
    res.json({ ok: true, message: "Coinbase connection successful", balances });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message, balances: [] });
  }
});

// ── POST /execute-trade ───────────────────────────────────────────────────────
router.post("/execute-trade", async (req, res): Promise<void> => {
  const parsed = ExecuteTradeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    krakenKey, krakenSecret, coinbaseKey, coinbaseSecret,
    buyExchange, sellExchange, volume, krakenPrice, coinbasePrice, liveMode, netEdgePct,
    orderType, pair: rawPair,
  } = parsed.data;

  // Validate pair strictly — reject unrecognised symbols before any order path
  if (rawPair !== undefined && !(PAIRS as readonly string[]).includes(rawPair)) {
    res.status(400).json({ error: `Unsupported pair "${rawPair}". Supported: ${PAIRS.join(", ")}` });
    return;
  }
  const pair: Pair = (rawPair as Pair | undefined) ?? "SOL/USD";
  const useLimit = orderType === "limit";

  const buyPrice = Math.min(krakenPrice, coinbasePrice);
  const estimatedProfitUsd = Math.max(0, ((netEdgePct ?? 0) / 100) * buyPrice * volume);

  const [countRow] = await db.select({ n: count() }).from(tradesTable);
  const tradeNumber = Number(countRow?.n ?? 0) + 1;

  if (!liveMode) {
    await db.insert(tradesTable).values({
      pair,
      buyExchange,
      sellExchange,
      volume: String(volume),
      estimatedProfitUsd: String(estimatedProfitUsd.toFixed(6)),
      netEdgePct: String((netEdgePct ?? 0).toFixed(4)),
      isDryRun: true,
      krakenPrice: String(krakenPrice),
      coinbasePrice: String(coinbasePrice),
      status: "simulated",
    });
    req.log.info({ tradeNumber, volume, estimatedProfitUsd, orderType: orderType ?? "market", pair }, "Dry run trade logged");
    res.json({ success: true, isDryRun: true, estimatedProfitUsd, tradeNumber, buyOrderId: null, sellOrderId: null, error: null });
    return;
  }

  // Live trade — pre-check balances before placing any orders
  // Use the correct base asset for the active pair (e.g. BTC for BTC/USD, not always SOL).
  try {
    const [krakenBalances, coinbaseBalances] = await Promise.all([
      getKrakenBalances({ krakenKey, krakenSecret }),
      getCoinbaseBalances({ coinbaseKey, coinbaseSecret }),
    ]);

    // Derive base asset from the pair (e.g. "BTC" from "BTC/USD")
    const baseAsset = pair.split("/")[0] ?? "SOL";

    // Kraken uses non-standard currency codes for some assets
    const krakenBaseVariants = (asset: string): string[] => {
      if (asset === "BTC") return ["XXBT", "XBT"];
      if (asset === "ETH") return ["XETH", "ETH"];
      if (asset === "SOL") return ["SOL", "SOL.S"];
      return [asset];
    };

    const baseOnKraken   = krakenBalances.find(b => krakenBaseVariants(baseAsset).includes(b.currency))?.amount ?? 0;
    const baseOnCoinbase = coinbaseBalances.find(b => b.currency === baseAsset)?.amount ?? 0;
    const usdOnKraken    = krakenBalances.find(b => ["ZUSD", "USD"].includes(b.currency))?.amount ?? 0;
    const usdOnCoinbase  = coinbaseBalances.find(b => ["USD", "USDC"].includes(b.currency))?.amount ?? 0;

    // Sell exchange must hold the base asset; buy exchange must hold USD
    const baseOnSellExchange = sellExchange === "Kraken" ? baseOnKraken   : baseOnCoinbase;
    const usdOnBuyExchange   = buyExchange  === "Kraken" ? usdOnKraken    : usdOnCoinbase;
    const buyPriceForPair    = Math.min(krakenPrice, coinbasePrice);

    // Require at least $5 notional worth of base asset on the sell side
    const minNotionalUsd = 5;
    const minBaseVolume  = buyPriceForPair > 0 ? minNotionalUsd / buyPriceForPair : 0;

    if (baseOnSellExchange < minBaseVolume || usdOnBuyExchange < minNotionalUsd) {
      const reason = `Trade skipped: insufficient ${baseAsset} balance on ${sellExchange} or USD on ${buyExchange}.`;
      req.log.warn({ baseAsset, baseOnSellExchange, usdOnBuyExchange, minBaseVolume, minNotionalUsd }, reason);
      res.json({ success: false, skipped: true, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: reason });
      return;
    }
  } catch (balErr) {
    req.log.warn({ err: balErr }, "Balance pre-check failed — proceeding with requested volume");
  }

  const ORDER_TIMEOUT_MS = 10_000;
  const withOrderTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Order timed out after ${ORDER_TIMEOUT_MS / 1000}s: ${label}`)), ORDER_TIMEOUT_MS)
    );
    return Promise.race([promise, timeout]);
  };

  let buyOrderId: string | null = null;
  let sellOrderId: string | null = null;

  const waitForFill = async (checkFilled: () => Promise<boolean>): Promise<boolean> => {
    const deadline = Date.now() + ORDER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await checkFilled()) return true;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  };

  try {
    const orderTime = Date.now();

    if (useLimit) {
      // ── Limit orders ─────────────────────────────────────────────────────
      if (buyExchange === "Kraken") {
        const r = await withOrderTimeout(krakenLimitOrder({ krakenKey, krakenSecret }, "buy", volume, krakenPrice, pair), "Kraken buy");
        buyOrderId = r.txid?.[0] ?? null;
      } else {
        const r = await withOrderTimeout(coinbaseLimitOrder({ coinbaseKey, coinbaseSecret }, "BUY", volume, coinbasePrice, pair), "Coinbase BUY");
        buyOrderId = r.orderId ?? null;
      }

      if (buyOrderId) {
        const checkFilled = buyExchange === "Kraken"
          ? () => krakenOrderFilled({ krakenKey, krakenSecret }, buyOrderId!)
          : () => coinbaseOrderFilled({ coinbaseKey, coinbaseSecret }, buyOrderId!);

        const filled = await waitForFill(checkFilled);

        if (!filled) {
          if (buyExchange === "Kraken")   await krakenCancelOrder({ krakenKey, krakenSecret }, buyOrderId).catch(() => {});
          else                             await coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, buyOrderId).catch(() => {});
          req.log.warn({ tradeNumber, buyOrderId }, "Buy limit not filled in time — cancelled, skipping sell");
          res.json({ success: false, skipped: true, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: "Buy limit order not filled — cancelled." });
          return;
        }
      }

      if (sellExchange === "Kraken") {
        const r = await withOrderTimeout(krakenLimitOrder({ krakenKey, krakenSecret }, "sell", volume, krakenPrice, pair), "Kraken sell");
        sellOrderId = r.txid?.[0] ?? null;
      } else {
        const r = await withOrderTimeout(coinbaseLimitOrder({ coinbaseKey, coinbaseSecret }, "SELL", volume, coinbasePrice, pair), "Coinbase SELL");
        sellOrderId = r.orderId ?? null;
      }
    } else {
      // ── Market orders ─────────────────────────────────────────────────────
      if (sellExchange === "Coinbase") {
        const sellResult = await withOrderTimeout(coinbaseMarketOrder({ coinbaseKey, coinbaseSecret }, "SELL", volume, coinbasePrice, pair), "Coinbase SELL");
        sellOrderId = sellResult.orderId ?? null;
        const buyResult = await withOrderTimeout(krakenMarketOrder({ krakenKey, krakenSecret }, "buy", volume, pair), "Kraken buy");
        buyOrderId = buyResult.txid?.[0] ?? null;
      } else {
        const sellResult = await withOrderTimeout(krakenMarketOrder({ krakenKey, krakenSecret }, "sell", volume, pair), "Kraken sell");
        sellOrderId = sellResult.txid?.[0] ?? null;
        const buyResult = await withOrderTimeout(coinbaseMarketOrder({ coinbaseKey, coinbaseSecret }, "BUY", volume, coinbasePrice, pair), "Coinbase BUY");
        buyOrderId = buyResult.orderId ?? null;
      }
    }

    // ── Record real profit for limit orders ─────────────────────────────────
    let recordedProfitUsd = estimatedProfitUsd;
    if (useLimit && sellOrderId) {
      const sellCheckFilled = sellExchange === "Kraken"
        ? () => krakenOrderFilled({ krakenKey, krakenSecret }, sellOrderId!)
        : () => coinbaseOrderFilled({ coinbaseKey, coinbaseSecret }, sellOrderId!);

      const sellFilled = await waitForFill(sellCheckFilled);

      if (sellFilled) {
        const [actualBuyPrice, actualSellPrice] = await Promise.all([
          buyExchange === "Kraken" && buyOrderId
            ? krakenFillPrice({ krakenKey, krakenSecret }, buyOrderId)
            : buyOrderId
              ? coinbaseFillPrice({ coinbaseKey, coinbaseSecret }, buyOrderId)
              : Promise.resolve(0),
          sellExchange === "Kraken" && sellOrderId
            ? krakenFillPrice({ krakenKey, krakenSecret }, sellOrderId)
            : sellOrderId
              ? coinbaseFillPrice({ coinbaseKey, coinbaseSecret }, sellOrderId)
              : Promise.resolve(0),
        ]);

        if (actualBuyPrice > 0 && actualSellPrice > 0) {
          recordedProfitUsd = (actualSellPrice - actualBuyPrice) * volume;
          req.log.info({ actualBuyPrice, actualSellPrice, recordedProfitUsd }, "Real profit recorded");
        }
      } else {
        if (sellExchange === "Kraken"  && sellOrderId) await krakenCancelOrder({ krakenKey, krakenSecret }, sellOrderId).catch(() => {});
        if (sellExchange === "Coinbase" && sellOrderId) await coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, sellOrderId).catch(() => {});
        req.log.warn({ tradeNumber, sellOrderId }, "Sell limit not filled in time — cancelled");
      }
    }

    await db.insert(tradesTable).values({
      pair,
      buyExchange,
      sellExchange,
      volume: String(volume),
      estimatedProfitUsd: String(recordedProfitUsd.toFixed(6)),
      netEdgePct: String((netEdgePct ?? 0).toFixed(4)),
      isDryRun: false,
      krakenPrice: String(krakenPrice),
      coinbasePrice: String(coinbasePrice),
      buyOrderId,
      sellOrderId,
      // Legacy 2-exchange path: profit may fall back to the estimate when a
      // fill price is missing — no per-leg fill proof, so never "verified".
      status: "estimated",
    });

    const orderElapsedMs = Date.now() - orderTime;
    req.log.info({ tradeNumber, pair, buyOrderId, sellOrderId, recordedProfitUsd, orderType: orderType ?? "market", orderElapsedMs }, "Live trade executed");
    res.json({ success: true, isDryRun: false, estimatedProfitUsd: recordedProfitUsd, tradeNumber, buyOrderId, sellOrderId, error: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const isTimeout = msg.startsWith("Order timed out after");
    if (isTimeout) {
      const timedOutExchange = msg.includes("Kraken") ? "Kraken" : msg.includes("Coinbase") ? "Coinbase" : "Exchange";
      req.log.warn({ err, tradeNumber, buyOrderId, sellOrderId }, `${timedOutExchange} timeout — cancelling any placed legs`);
      const cancelOps: Promise<void>[] = [];
      if (buyExchange === "Kraken"   && buyOrderId)  cancelOps.push(krakenCancelOrder({ krakenKey, krakenSecret }, buyOrderId).catch((e) => req.log.error({ e }, "Kraken cancel failed")));
      if (buyExchange === "Coinbase" && buyOrderId)  cancelOps.push(coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, buyOrderId).catch((e) => req.log.error({ e }, "Coinbase cancel failed")));
      if (sellExchange === "Kraken"  && sellOrderId) cancelOps.push(krakenCancelOrder({ krakenKey, krakenSecret }, sellOrderId).catch((e) => req.log.error({ e }, "Kraken cancel failed")));
      if (sellExchange === "Coinbase" && sellOrderId) cancelOps.push(coinbaseCancelOrder({ coinbaseKey, coinbaseSecret }, sellOrderId).catch((e) => req.log.error({ e }, "Coinbase cancel failed")));
      await Promise.allSettled(cancelOps);
      const timedOutExchange2 = msg.includes("Kraken") ? "Kraken" : msg.includes("Coinbase") ? "Coinbase" : "Exchange";
      res.status(500).json({ success: false, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: `${timedOutExchange2} timeout.` });
    } else {
      req.log.error({ err }, "Trade execution failed");
      res.status(500).json({ success: false, isDryRun: false, estimatedProfitUsd: 0, tradeNumber, buyOrderId: null, sellOrderId: null, error: msg });
    }
  }
});

// ── GET /trades ───────────────────────────────────────────────────────────────
router.get("/trades", async (req, res): Promise<void> => {
  const parsed = ListTradesQueryParams.safeParse(req.query);
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const offset = parsed.success ? (parsed.data.offset ?? 0) : 0;

  // Single-statement page + total (one PostgreSQL snapshot) — the total can
  // never drift from the page rows even when a trade lands mid-request.
  res.json(await listTradesPage(limit, offset));
});

// ── GET /trades/summary ───────────────────────────────────────────────────────
router.get("/trades/summary", async (req, res): Promise<void> => {
  const [statsRow] = await db
    .select({
      totalTrades: count(),
      liveTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.isDryRun} = false)`,
      dryRunTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.isDryRun} = true)`,
      totalProfitUsd: sum(tradesTable.estimatedProfitUsd),
      avgNetEdgePct: avg(tradesTable.netEdgePct),
      bestTradeProfitUsd: max(tradesTable.estimatedProfitUsd),
      // VERIFIED = confirmed fill on every required leg AND a real,
      // non-null realized P&L. A row can carry status='verified' yet a null
      // realizedProfitUsd (e.g. a fully-sold XV leg whose sell notional could
      // not be priced — cross-venue.ts) — such an indeterminate row must NOT
      // count as a verified trade nor leak a phantom $0 into the P&L. The
      // `realized_profit_usd IS NOT NULL` clause is the hard gate.
      verifiedTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL)`,
      failedTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'failed')`,
      simulatedTrades: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'simulated' OR ${tradesTable.status} = 'estimated' OR ${tradesTable.status} IS NULL)`,
      // Realized P&L: SUM over VERIFIED rows' realizedProfitUsd ONLY — never
      // scanner estimates, never dry runs, never legacy/indeterminate rows
      // without a proven realized figure.
      realizedPnlUsd: sql<string | null>`SUM(${tradesTable.realizedProfitUsd}) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL)`,
      bestVerifiedProfitUsd: sql<string | null>`MAX(${tradesTable.realizedProfitUsd}) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL)`,
      // Live, fully-completed, verified-fill cycles across ALL strategies
      // (triangles, graph-cross, INV, MM2, XV, 2X/2XTEST) — the same hard gate
      // plus isDryRun = false. Dry runs never reach a verified ledger write, so
      // this is defensive belt-and-braces against any legacy/simulated row.
      liveCompletedCycles: sql<number>`COUNT(*) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL AND ${tradesTable.isDryRun} = false)`,
      liveRealizedPnlUsd: sql<string | null>`SUM(${tradesTable.realizedProfitUsd}) FILTER (WHERE ${tradesTable.status} = 'verified' AND ${tradesTable.realizedProfitUsd} IS NOT NULL AND ${tradesTable.isDryRun} = false)`,
    })
    .from(tradesTable);

  const recentTrades = await db
    .select()
    .from(tradesTable)
    .orderBy(desc(tradesTable.createdAt))
    .limit(5);

  res.json({
    totalTrades: Number(statsRow?.totalTrades ?? 0),
    liveTrades: Number(statsRow?.liveTrades ?? 0),
    dryRunTrades: Number(statsRow?.dryRunTrades ?? 0),
    totalProfitUsd: parseFloat(String(statsRow?.totalProfitUsd ?? 0)),
    avgNetEdgePct: parseFloat(String(statsRow?.avgNetEdgePct ?? 0)),
    bestTradeProfitUsd: parseFloat(String(statsRow?.bestTradeProfitUsd ?? 0)),
    verifiedTrades: Number(statsRow?.verifiedTrades ?? 0),
    failedTrades: Number(statsRow?.failedTrades ?? 0),
    simulatedTrades: Number(statsRow?.simulatedTrades ?? 0),
    realizedPnlUsd: statsRow?.realizedPnlUsd != null ? parseFloat(String(statsRow.realizedPnlUsd)) : 0,
    liveCompletedCycles: Number(statsRow?.liveCompletedCycles ?? 0),
    liveRealizedPnlUsd: statsRow?.liveRealizedPnlUsd != null ? parseFloat(String(statsRow.liveRealizedPnlUsd)) : 0,
    bestVerifiedProfitUsd: statsRow?.bestVerifiedProfitUsd != null ? parseFloat(String(statsRow.bestVerifiedProfitUsd)) : null,
    recentTrades: recentTrades.map(t => ({
      ...t,
      pair: t.pair ?? "SOL/USD",
      volume: parseFloat(t.volume),
      estimatedProfitUsd: parseFloat(t.estimatedProfitUsd),
      netEdgePct: parseFloat(t.netEdgePct),
      krakenPrice: parseFloat(t.krakenPrice),
      coinbasePrice: parseFloat(t.coinbasePrice),
      realizedProfitUsd: t.realizedProfitUsd != null ? parseFloat(t.realizedProfitUsd) : null,
      createdAt: t.createdAt.toISOString(),
    })),
  });
});

// ── GET /arb/inventory-scan ───────────────────────────────────────────────────
// Cross-exchange inventory arb scanner: checks live bid/ask for BTC, ETH, SOL
// (and any other requested asset) on both Kraken and Coinbase, surfaces
// opportunities where gross spread > 2× fees, and emits rebalance alerts when
// one side of the inventory drops below 20% of the target split.
//
// Query params:
//   assets          comma-separated (default "BTC,ETH,SOL")
//   krakenFeesPct   default 0.16
//   coinbaseFeesPct default 0.40
//   tradeSizeUsd    default 10
//   targetPct       target % to hold on each exchange (default 50)
//   krakenKey / krakenSecret / coinbaseKey / coinbaseSecret (optional — for balance check)
router.get("/arb/inventory-scan", async (req, res): Promise<void> => {
  const rawAssets = String(req.query["assets"] ?? "BTC,ETH,SOL");
  const requestedAssets = rawAssets.split(",").map(a => a.trim().toUpperCase()).filter(Boolean);
  const krakenFeesPct   = Math.max(0, parseFloat(String(req.query["krakenFeesPct"]   ?? "0.16")) || 0.16);
  const coinbaseFeesPct = Math.max(0, parseFloat(String(req.query["coinbaseFeesPct"] ?? "0.40")) || 0.40);
  const tradeSizeUsd    = Math.max(1, parseFloat(String(req.query["tradeSizeUsd"]    ?? "10"))   || 10);
  const targetPct       = Math.max(1, Math.min(99, parseFloat(String(req.query["targetPct"] ?? "50")) || 50));
  const krakenKey     = String(req.query["krakenKey"]     ?? "");
  const krakenSecret  = String(req.query["krakenSecret"]  ?? "");
  const coinbaseKey   = String(req.query["coinbaseKey"]   ?? "");
  const coinbaseSecret = String(req.query["coinbaseSecret"] ?? "");

  // Asset → canonical pair (must exist in PAIRS list)
  const ASSET_PAIRS: Record<string, Pair> = {
    BTC: "BTC/USD", ETH: "ETH/USD", SOL: "SOL/USD",
    AVAX: "AVAX/USD", DOT: "DOT/USD", LINK: "LINK/USD",
    ADA: "ADA/USD", ATOM: "ATOM/USD", UNI: "UNI/USD", POL: "POL/USD",
  };

  const validAssets = requestedAssets.filter(a => ASSET_PAIRS[a]);
  if (validAssets.length === 0) {
    res.status(400).json({ error: `No valid assets in: ${rawAssets}. Use BTC, ETH, SOL (etc.)` });
    return;
  }

  try {
    const scannedAt = new Date().toISOString();
    const totalFees = krakenFeesPct + coinbaseFeesPct;
    const threshold = 2 * totalFees; // gross spread must be > 2× fees to surface

    // Fetch bid/ask in parallel — public endpoints, no creds needed
    const bidAskResults = await Promise.allSettled(
      validAssets.map(asset => Promise.all([
        getKrakenBidAsk(ASSET_PAIRS[asset]!),
        getCoinbaseBidAsk(ASSET_PAIRS[asset]!),
      ]))
    );

    // Optionally fetch balances for rebalance alerts (fire-and-forget; skip on missing creds)
    let krakenBalances: Array<{ currency: string; amount: number }> = [];
    let coinbaseBalances: Array<{ currency: string; amount: number }> = [];
    const hasCreds = krakenKey && krakenSecret && coinbaseKey && coinbaseSecret;
    if (hasCreds) {
      try {
        [krakenBalances, coinbaseBalances] = await Promise.all([
          getKrakenBalances({ krakenKey, krakenSecret }),
          getCoinbaseBalances({ coinbaseKey: coinbaseKey ?? "", coinbaseSecret: coinbaseSecret ?? "" }),
        ]);
      } catch { /* balance fetch is optional — skip rebalance alerts on error */ }
    }

    // Helper: normalize Kraken asset codes (XXBT → BTC, XETH → ETH, etc.)
    const normalizeKrakenAsset = (c: string) => {
      const stripped = c.length >= 4 && (c.startsWith("X") || c.startsWith("Z")) ? c.slice(1) : c;
      return stripped.replace(/\.[SF]$/, "").replace(/^XBT$/, "BTC");
    };

    // Build asset → amount maps for rebalance check
    const krakenAmts = new Map<string, number>();
    for (const b of krakenBalances) {
      const sym = normalizeKrakenAsset(b.currency).toUpperCase();
      krakenAmts.set(sym, (krakenAmts.get(sym) ?? 0) + b.amount);
    }
    const coinbaseAmts = new Map<string, number>();
    for (const b of coinbaseBalances) {
      coinbaseAmts.set(b.currency.toUpperCase(), (coinbaseAmts.get(b.currency.toUpperCase()) ?? 0) + b.amount);
    }

    const opportunities: Array<{
      asset: string; pair: string;
      krakenBid: number; krakenAsk: number;
      coinbaseBid: number; coinbaseAsk: number;
      grossSpreadPct: number; netSpreadPct: number;
      buyExchange: string; sellExchange: string;
      buyPrice: number; sellPrice: number;
      tradeSizeUsd: number; estimatedNetProfitUsd: number;
      meetsThreshold: boolean; scannedAt: string;
    }> = [];

    const rebalanceAlerts: Array<{
      asset: string; exchange: string;
      krakenPct: number; coinbasePct: number;
      targetPct: number; alertLevel: "info" | "warning" | "critical";
      message: string;
    }> = [];

    for (let i = 0; i < validAssets.length; i++) {
      const asset = validAssets[i]!;
      const pair = ASSET_PAIRS[asset]!;
      const result = bidAskResults[i];
      if (result?.status !== "fulfilled") continue;

      const [kba, cba] = result.value;

      // Depth-walked, buffer-inclusive projection on the live stream snapshot —
      // IDENTICAL math to the executor (projectTakerTaker), so the preview can
      // never show a net the executor wouldn't compute. Falls back to marking
      // the row unavailable when depth/books are missing (never top-of-book).
      const bufUsd = 0.02 * (tradeSizeUsd / 10);
      const pKtoC = projectTakerTaker(asset as ObAsset, "kraken", tradeSizeUsd, krakenFeesPct, coinbaseFeesPct);
      const pCtoK = projectTakerTaker(asset as ObAsset, "coinbase", tradeSizeUsd, coinbaseFeesPct, krakenFeesPct);
      const best = [pKtoC, pCtoK].filter(Boolean).sort((a, b) => b!.projectedNetUsd - a!.projectedNetUsd)[0] ?? null;
      if (!best) continue; // no live depth — do not fabricate a preview from REST top-of-book
      const useKraken = best === pKtoC;
      const grossSpreadPct = (best.grossEdgeUsd / tradeSizeUsd) * 100;
      const estimatedNetProfitUsd = best.projectedNetUsd - bufUsd; // buffer-inclusive, like every other card
      const netSpreadPct = (estimatedNetProfitUsd / tradeSizeUsd) * 100;
      const buyPrice  = useKraken ? kba.ask : cba.ask;
      const sellPrice = useKraken ? cba.bid : kba.bid;
      const volume = best.qty;

      opportunities.push({
        asset, pair,
        krakenBid: kba.bid, krakenAsk: kba.ask,
        coinbaseBid: cba.bid, coinbaseAsk: cba.ask,
        grossSpreadPct, netSpreadPct,
        buyExchange: useKraken ? "Kraken" : "Coinbase",
        sellExchange: useKraken ? "Coinbase" : "Kraken",
        buyPrice, sellPrice,
        tradeSizeUsd,
        estimatedNetProfitUsd,
        meetsThreshold: estimatedNetProfitUsd > 0,
        scannedAt,
      });
      void volume; // used for display only; actual fill volume is determined at execution

      // Rebalance check
      if (hasCreds) {
        const kAmt = krakenAmts.get(asset) ?? 0;
        const cAmt = coinbaseAmts.get(asset) ?? 0;
        const total = kAmt + cAmt;
        if (total > 0) {
          const kPct = (kAmt / total) * 100;
          const cPct = (cAmt / total) * 100;
          const minAllowed = targetPct * 0.20; // alert below 20% of target
          for (const [exchange, pct, otherPct] of [["Kraken", kPct, cPct], ["Coinbase", cPct, kPct]] as [string, number, number][]) {
            void otherPct;
            if (pct < minAllowed) {
              const alertLevel: "critical" | "warning" = pct < minAllowed / 2 ? "critical" : "warning";
              rebalanceAlerts.push({
                asset, exchange, krakenPct: kPct, coinbasePct: cPct, targetPct,
                alertLevel,
                message: `${asset} on ${exchange} is ${pct.toFixed(1)}% of total holdings (target ${targetPct}%) — rebalance needed`,
              });
            }
          }
        }
      }
    }

    // Sort: threshold-met first, then by gross spread descending
    opportunities.sort((a, b) => {
      if (a.meetsThreshold !== b.meetsThreshold) return a.meetsThreshold ? -1 : 1;
      return b.grossSpreadPct - a.grossSpreadPct;
    });

    res.json({ opportunities, rebalanceAlerts, scannedAt });
  } catch (err) {
    req.log.error({ err }, "inventory-scan error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /arb/inventory-execute ───────────────────────────────────────────────
// Execute a cross-exchange inventory arb: buy on the cheap venue, sell on the
// expensive venue. Fetches a fresh live quote immediately before placing orders
// and gates on net profit > minProfitUsd. Sequential execution: buy → confirm
// fill → sell ACTUAL filled volume. Unwinds on sell failure.
router.post("/arb/inventory-execute", async (req, res): Promise<void> => {
  const {
    krakenKey, krakenSecret, coinbaseKey, coinbaseSecret,
    asset, tradeSizeUsd: rawSize, minProfitUsd: rawMin, isDryRun,
    krakenFeesPct: rawKFee, coinbaseFeesPct: rawCFee,
  } = req.body as {
    krakenKey?: string; krakenSecret?: string;
    coinbaseKey?: string; coinbaseSecret?: string;
    asset?: string; tradeSizeUsd?: number; minProfitUsd?: number;
    isDryRun?: boolean; krakenFeesPct?: number; coinbaseFeesPct?: number;
  };

  if (!krakenKey || !krakenSecret || !coinbaseKey || !coinbaseSecret) {
    res.status(400).json({ error: "krakenKey, krakenSecret, coinbaseKey, and coinbaseSecret are required." });
    return;
  }
  const ASSET_PAIRS: Record<string, Pair> = {
    BTC: "BTC/USD", ETH: "ETH/USD", SOL: "SOL/USD",
    AVAX: "AVAX/USD", DOT: "DOT/USD",
  };
  const sym = String(asset ?? "BTC").toUpperCase();
  const pair = ASSET_PAIRS[sym];
  if (!pair) {
    res.status(400).json({ error: `Unknown asset: ${sym}. Valid: ${Object.keys(ASSET_PAIRS).join(", ")}` });
    return;
  }
  const tradeSizeUsd    = Math.min(100_000, Math.max(1, Number.isFinite(rawSize) ? rawSize! : 10));
  const minProfitUsd    = isDryRun ? (rawMin ?? 0) : Math.max(0, rawMin ?? 0.01);
  const krakenFeesPct   = Math.max(0, rawKFee ?? 0.16);
  const coinbaseFeesPct = Math.max(0, rawCFee ?? 0.40);
  const totalFees       = krakenFeesPct + coinbaseFeesPct;

  const kCreds  = { krakenKey, krakenSecret };
  const cbCreds = { coinbaseKey, coinbaseSecret };
  let lockGen: number | null = null;

  try {
    // 1. DETECTED fees for live runs — never trade on user-typed assumptions.
    let realKFee = krakenFeesPct, realCFee = coinbaseFeesPct;
    if (!isDryRun) {
      try {
        const f = await detectRealFees({ krakenKey, krakenSecret, coinbaseKey, coinbaseSecret });
        realKFee = f.kTakerPct; realCFee = f.cbTakerPct;
      } catch (e) {
        res.status(502).json({ error: `could not detect REAL fee tiers (refusing to trade on assumed fees): ${(e as Error).message}` });
        return;
      }
    }
    // 2. Depth-walked projection on the live stream snapshot — the SAME math
    //    and snapshot source the rest of the app executes on. Top-of-book
    //    REST quotes are display-only below.
    const [kba, cba] = await Promise.all([getKrakenBidAsk(pair), getCoinbaseBidAsk(pair)]);
    const bufUsd = isDryRun ? 0 : 0.02 * (tradeSizeUsd / 10);
    const MAX_ROUTE_AGE_MS = 200; // strict rule: any leg older than 200ms → route stale
    const pKtoC = projectTakerTaker(sym as ObAsset, "kraken", tradeSizeUsd, realKFee, realCFee);
    const pCtoK = projectTakerTaker(sym as ObAsset, "coinbase", tradeSizeUsd, realCFee, realKFee);
    const best = [pKtoC, pCtoK].filter(Boolean).sort((a, b) => b!.projectedNetUsd - a!.projectedNetUsd)[0] ?? null;
    if (!best) {
      res.status(409).json({ error: "no live depth books on one/both venues — refusing to price from top-of-book" });
      return;
    }
    const useKraken = best === pKtoC;
    const grossSpreadPct = (best.grossEdgeUsd / tradeSizeUsd) * 100;
    const estimatedNetProfitUsd = best.projectedNetUsd - bufUsd;
    const netSpreadPct   = (estimatedNetProfitUsd / tradeSizeUsd) * 100;
    const buyExchange    = useKraken ? "Kraken" : "Coinbase";
    const sellExchange   = useKraken ? "Coinbase" : "Kraken";
    const buyPrice       = useKraken ? kba.ask : cba.ask;
    const sellPrice      = useKraken ? cba.bid : kba.bid;
    const plannedVolume  = best.qty;

    // DECISION LOG — market ages, route age, scanner vs executable net, floor.
    req.log.info({
      sym, decision: "inventory-pre-fire",
      legAges: best.legAges.map(l => ({ market: l.pair, ageMs: l.ageMs, recvAgeMs: l.recvAgeMs })),
      routeAgeMs: best.quoteAgeMs,
      scannerNetUsd: best.projectedNetUsd,
      executableNetUsd: estimatedNetProfitUsd,
      profitFloorUsd: minProfitUsd, bufferUsd: bufUsd,
      feesDetected: !isDryRun, kFeePct: realKFee, cbFeePct: realCFee,
    }, "[INV] decision");

    if (!isDryRun && best.quoteAgeMs > MAX_ROUTE_AGE_MS) {
      res.json({
        success: false, isDryRun: false, executed: false, asset: sym, pair,
        buyExchange, sellExchange, volume: null, buyPrice, sellPrice,
        grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
        buyOrderId: null, sellOrderId: null,
        error: `route stale: oldest leg ${best.quoteAgeMs}ms > ${MAX_ROUTE_AGE_MS}ms — entire route treated as stale, not executing`,
      });
      return;
    }
    // PRE-FIRE CONSISTENCY — an immediate second re-projection with the
    // identical function against the live stream books. Not an immutable
    // snapshot: it blocks execution when the two consecutive reads diverge.
    if (!isDryRun) {
      const recheck = projectTakerTaker(sym as ObAsset, useKraken ? "kraken" : "coinbase", tradeSizeUsd, useKraken ? realKFee : realCFee, useKraken ? realCFee : realKFee);
      if (recheck) req.log.info({ sym, recheckLegAges: recheck.legAges.map(l => ({ market: l.pair, ageMs: l.ageMs })), recheckRouteAgeMs: recheck.quoteAgeMs }, "[INV] recheck");
      if (recheck && recheck.quoteAgeMs > MAX_ROUTE_AGE_MS) {
        res.json({
          success: false, isDryRun: false, executed: false, asset: sym, pair,
          buyExchange, sellExchange, volume: null, buyPrice, sellPrice,
          grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
          buyOrderId: null, sellOrderId: null,
          error: `route went stale during consistency check: oldest leg ${recheck.quoteAgeMs}ms > ${MAX_ROUTE_AGE_MS}ms — not executing`,
        });
        return;
      }
      if (!recheck || Math.abs(recheck.projectedNetUsd - best.projectedNetUsd) > 0.005) {
        req.log.error({ sym, scannerNetUsd: best.projectedNetUsd, preFireNetUsd: recheck?.projectedNetUsd ?? null }, "[INV] PRICING CONSISTENCY ERROR");
        res.json({
          success: false, isDryRun: false, executed: false, asset: sym, pair,
          buyExchange, sellExchange, volume: null, buyPrice, sellPrice,
          grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
          buyOrderId: null, sellOrderId: null,
          error: `PRICING CONSISTENCY ERROR: scanner net $${best.projectedNetUsd.toFixed(4)} vs pre-fire net $${recheck ? recheck.projectedNetUsd.toFixed(4) : "n/a"} diverged beyond $0.005 between consecutive re-projections — not executing`,
        });
        return;
      }
    }

    // Gate
    if (netSpreadPct <= 0 || estimatedNetProfitUsd <= minProfitUsd) {
      res.json({
        success: false, isDryRun: !!isDryRun, executed: false,
        asset: sym, pair, buyExchange, sellExchange,
        volume: null, buyPrice, sellPrice,
        grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
        buyOrderId: null, sellOrderId: null,
        error: `Pre-flight failed — net profit $${estimatedNetProfitUsd.toFixed(4)} ≤ minimum $${minProfitUsd.toFixed(4)} (spread ${grossSpreadPct.toFixed(3)}% − fees ${totalFees.toFixed(2)}% = ${netSpreadPct.toFixed(3)}%)`,
      });
      return;
    }

    // 2. Dry run — log, no orders
    if (isDryRun) {
      await db.insert(tradesTable).values({
        pair: `INV:${sym} ${buyExchange}→${sellExchange}`,
        buyExchange: buyExchange.toLowerCase(),
        sellExchange: sellExchange.toLowerCase(),
        volume: plannedVolume.toFixed(8),
        estimatedProfitUsd: estimatedNetProfitUsd.toFixed(6),
        netEdgePct: netSpreadPct.toFixed(4),
        isDryRun: true,
        krakenPrice: useKraken ? kba.ask.toFixed(4) : kba.bid.toFixed(4),
        coinbasePrice: useKraken ? cba.bid.toFixed(4) : cba.ask.toFixed(4),
        status: "simulated",
      });
      req.log.info({ sym, pair, buyExchange, tradeSizeUsd, estimatedNetProfitUsd }, "Inventory execute (dry run)");
      res.json({
        success: true, isDryRun: true, executed: true,
        asset: sym, pair, buyExchange, sellExchange,
        volume: plannedVolume, buyPrice, sellPrice,
        grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
        buyOrderId: null, sellOrderId: null, error: null,
      });
      return;
    }

    // 3. Live execution: acquire lock first to prevent concurrent executions
    //    (graph-execute, OB-execute, or another inventory request) from
    //    double-spending the same balance.
    if (liveLockBusy()) {
      res.status(409).json({
        success: false, isDryRun: false, executed: false, asset: sym, pair,
        buyExchange, sellExchange, volume: null, buyPrice, sellPrice,
        grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
        buyOrderId: null, sellOrderId: null,
        error: "Another live execution is already in progress — try again in a moment.",
      });
      return;
    }
    lockGen = acquireLiveLock();
    bindLockHeartbeat(liveLockHeartbeat(lockGen));

    const KRAKEN_RAW_PAIRS: Record<string, string> = {
      "BTC/USD": "XXBTZUSD", "ETH/USD": "ETHUSD", "SOL/USD": "SOLUSD",
      "AVAX/USD": "AVAXUSD", "DOT/USD": "DOTUSD",
    };
    const krakenRaw = KRAKEN_RAW_PAIRS[pair] ?? pair.replace("/", "").replace("BTC", "XBT");
    const log = { info: (m: string) => req.log.info(m), error: (m: string) => req.log.error(m) };

    let buyOrderId = "", sellOrderId = "";
    let filledVolume = 0;
    let buySpendUsd = 0, sellProceedsUsd = 0;
    let anyAccepted = false;

    const CB_TERMINAL = new Set(["FILLED", "CANCELLED", "EXPIRED", "FAILED"]);
    const waitCoinbaseFill = async (orderId: string) => {
      for (let i = 0; i < 30; i++) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, 500));
        try {
          const d = await coinbaseOrderDetails(cbCreds, orderId);
          if (CB_TERMINAL.has(d.status)) return d;
        } catch { /* keep polling */ }
      }
      try { await coinbaseCancelOrder(cbCreds, orderId); } catch { /* best effort */ }
      try { return await coinbaseOrderDetails(cbCreds, orderId); }
      catch { return { status: "UNKNOWN", filledSize: 0, filledValue: 0, avgPrice: 0, totalFees: 0 }; }
    };
    const waitKrakenFill = async (txid: string) => {
      // Phase 1: poll up to 20 s for a terminal status.
      const TERMINAL = new Set(["closed", "canceled", "expired"]);
      for (let i = 0; i < 20; i++) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, 1_000));
        try {
          const info = await krakenOrderInfo(kCreds, txid);
          if (TERMINAL.has(info.status)) return info;
        } catch { /* transient API error — keep polling */ }
      }
      // Phase 2: cancel the resting order (best-effort) to prevent a late fill
      // from going unhedged, then poll up to 15 more seconds for a terminal
      // status to be confirmed. We never act on a non-terminal response because
      // Kraken can still fill a "canceling" order in the race.
      try { await krakenCancelOrder(kCreds, txid); } catch { /* ignore cancel ack errors */ }
      for (let i = 0; i < 15; i++) {
        touchLiveLock();
        await new Promise(r => setTimeout(r, 1_000));
        try {
          const info = await krakenOrderInfo(kCreds, txid);
          if (TERMINAL.has(info.status)) return info;
        } catch { /* transient — keep polling */ }
      }
      // Phase 3: order state is still indeterminate after cancel + 15 s polling.
      // Throw so the caller records a failure and halts; never assume a fill
      // volume or auto-unwind based on an unknown state.
      throw new Error(`Kraken order ${txid} status indeterminate after cancel attempt — manual reconciliation required. Do NOT retry automatically.`);
    };

    try {
      // ── Buy leg ────────────────────────────────────────────────────────────
      if (buyExchange === "Kraken") {
        const r = await krakenRawMarketOrder(kCreds, "buy", plannedVolume, krakenRaw);
        buyOrderId = r.txid[0] ?? "";
        if (!buyOrderId) throw new Error("Kraken buy not accepted (no txid).");
        anyAccepted = true;
        const fill = await waitKrakenFill(buyOrderId);
        filledVolume = fill.volExec;
        buySpendUsd  = fill.cost + fill.fee;
        if (fill.status !== "closed" || filledVolume <= 0) {
          if (filledVolume > 0) await tryUnwindMarket(kCreds, "sell", filledVolume, krakenRaw, `unwind partial inv-buy ${sym}`, log);
          throw new Error(`Kraken buy did not fill (${fill.status}, ${filledVolume.toFixed(8)}/${plannedVolume.toFixed(8)}); unwound.`);
        }
      } else {
        const r = await coinbaseMarketOrder(cbCreds, "BUY", plannedVolume, buyPrice, pair);
        buyOrderId = r.orderId ?? "";
        if (!buyOrderId || r.success === false) throw new Error("Coinbase buy rejected.");
        anyAccepted = true;
        const d = await waitCoinbaseFill(buyOrderId);
        filledVolume = d.filledSize;
        buySpendUsd  = d.filledValue + d.totalFees;
        if (d.status !== "FILLED") {
          if (filledVolume > 0) {
            try { await coinbaseMarketOrder(cbCreds, "SELL", filledVolume, buyPrice, pair); } catch (e) {
              log.error(`Coinbase partial-buy unwind failed (${filledVolume.toFixed(8)} ${sym}): ${(e as Error).message}`);
            }
          }
          throw new Error(`Coinbase buy ended ${d.status} with ${filledVolume.toFixed(8)} filled; unwound.`);
        }
      }

      // ── Sell leg (sell ACTUAL filled volume) ───────────────────────────────
      try {
        if (sellExchange === "Kraken") {
          const r = await krakenRawMarketOrder(kCreds, "sell", filledVolume, krakenRaw);
          sellOrderId = r.txid[0] ?? "";
          if (!sellOrderId) throw new Error("Kraken sell not accepted.");
          const fill = await waitKrakenFill(sellOrderId);
          sellProceedsUsd = fill.cost - fill.fee;
          if (fill.status !== "closed" || fill.volExec < filledVolume * 0.999) {
            const residual = Math.max(0, filledVolume - fill.volExec);
            throw new ResidualError(`Kraken sell did not fully fill (${fill.volExec.toFixed(8)}/${filledVolume.toFixed(8)}).`, residual);
          }
        } else {
          const r = await coinbaseMarketOrder(cbCreds, "SELL", filledVolume, sellPrice, pair);
          sellOrderId = r.orderId ?? "";
          if (!sellOrderId || r.success === false) throw new Error("Coinbase sell rejected.");
          const d = await waitCoinbaseFill(sellOrderId);
          sellProceedsUsd = d.filledValue - d.totalFees;
          if (d.status !== "FILLED") {
            const residual = Math.max(0, filledVolume - d.filledSize);
            throw new ResidualError(`Coinbase sell ended ${d.status} (${d.filledSize.toFixed(8)} sold).`, residual);
          }
        }
      } catch (sellErr) {
        const residual = sellErr instanceof ResidualError ? sellErr.residual : filledVolume;
        if (residual > 0) {
          if (buyExchange === "Kraken") {
            await tryUnwindMarket(kCreds, "sell", residual, krakenRaw, `inv sell-fail unwind ${sym}`, log);
          } else {
            try { await coinbaseMarketOrder(cbCreds, "SELL", residual, buyPrice, pair); }
            catch (e) { log.error(`Coinbase sell-fail unwind failed (${residual.toFixed(8)} ${sym}): ${(e as Error).message}`); }
          }
        }
        throw new Error(`Sell leg failed: ${(sellErr as Error).message} Residual ${residual.toFixed(8)} unwound.`);
      }
    } catch (execErr) {
      const msg = (execErr as Error).message;
      if (anyAccepted) {
        try {
          await db.insert(tradesTable).values({
            pair: `INV:${sym} ${buyExchange}→${sellExchange} [FAILED]`,
            buyExchange: buyExchange.toLowerCase(), sellExchange: sellExchange.toLowerCase(),
            volume: filledVolume.toFixed(8), estimatedProfitUsd: "0", netEdgePct: "0",
            isDryRun: false, krakenPrice: "0", coinbasePrice: "0",
            buyOrderId: buyOrderId || null, sellOrderId: sellOrderId || null,
            status: "failed",
            realizedProfitUsd: filledVolume > 0 ? null : "0",
          });
        } catch { /* best effort */ }
      }
      req.log.error({ sym, pair, buyOrderId, sellOrderId, filledVolume, err: msg }, "Inventory execute LIVE — failed");
      res.json({
        success: false, isDryRun: false, executed: anyAccepted,
        asset: sym, pair, buyExchange, sellExchange,
        volume: filledVolume || null, buyPrice, sellPrice,
        grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
        buyOrderId: buyOrderId || null, sellOrderId: sellOrderId || null,
        error: msg,
      });
      return;
    }

    const invVerified = buySpendUsd > 0 && sellProceedsUsd > 0 && !!buyOrderId && !!sellOrderId;
    const realizedProfitUsd = invVerified ? sellProceedsUsd - buySpendUsd : null;
    await db.insert(tradesTable).values({
      pair: `INV:${sym} ${buyExchange}→${sellExchange}`,
      buyExchange: buyExchange.toLowerCase(), sellExchange: sellExchange.toLowerCase(),
      volume: filledVolume.toFixed(8),
      estimatedProfitUsd: estimatedNetProfitUsd.toFixed(6), // expectation, never realized
      netEdgePct: (filledVolume > 0 && buySpendUsd > 0 && realizedProfitUsd != null ? (realizedProfitUsd / buySpendUsd) * 100 : netSpreadPct).toFixed(4),
      isDryRun: false, krakenPrice: "0", coinbasePrice: "0",
      buyOrderId: buyOrderId || null, sellOrderId: sellOrderId || null,
      status: invVerified ? "verified" : "estimated",
      realizedProfitUsd: realizedProfitUsd != null ? realizedProfitUsd.toFixed(6) : null,
      legFills: [
        { leg: 1, label: "buy", pair, side: "buy", volume: filledVolume, costUsd: buySpendUsd, txid: buyOrderId || null },
        { leg: 2, label: "sell", pair, side: "sell", volume: filledVolume, costUsd: sellProceedsUsd, txid: sellOrderId || null },
      ],
    });
    await snapshotAccountValue({ krakenKey, krakenSecret, coinbaseKey, coinbaseSecret }, "post_trade", req.log);
    req.log.info({ sym, pair, tradeSizeUsd, filledVolume, buyOrderId, sellOrderId, realizedProfitUsd }, "Inventory execute LIVE — both legs confirmed");
    res.json({
      success: true, isDryRun: false, executed: true,
      asset: sym, pair, buyExchange, sellExchange,
      volume: filledVolume, buyPrice, sellPrice,
      grossSpreadPct, netSpreadPct, estimatedNetProfitUsd,
      realizedProfitUsd, buyOrderId, sellOrderId, error: null,
    });
  } catch (err) {
    req.log.error({ err }, "inventory-execute error");
    res.status(500).json({ error: (err as Error).message });
  } finally {
    if (lockGen != null) releaseLiveLock(lockGen);
  }
});

// ── GET /arb/cointegration ─────────────────────────────────────────────────────
router.get("/arb/cointegration", async (_req, res): Promise<void> => {
  try {
    const now = new Date().toISOString();

    // Fetch prices for all relevant assets from the multi-pair cache in parallel
    const assetKeys = ["SOL/USD", "ETH/USD", "BTC/USD", "AVAX/USD", "DOT/USD"] as Pair[];
    const priceResults = await Promise.all(assetKeys.map(p => getPairPrices(p)));
    const priceMap = new Map<string, { mid: number | null }>();
    for (const pr of priceResults) {
      const mid = pr.kraken ?? pr.coinbase ?? pr.binance ?? pr.kucoin ?? null;
      priceMap.set(pr.pair, { mid });
    }

    const signals: Array<{
      pair: string; asset1: string; asset2: string;
      price1: number; price2: number;
      hedgeRatio: number; spread: number; zScore: number;
      direction: "long_asset1" | "short_asset1";
      edgePct: number; observations: number; timestamp: string;
    }> = [];

    for (const cfg of COINT_PAIRS) {
      const p1 = priceMap.get(cfg.asset1)?.mid;
      const p2 = priceMap.get(cfg.asset2)?.mid;
      if (!p1 || !p2 || p1 <= 0 || p2 <= 0) continue;

      // Get or create in-memory Kalman history for this pair
      if (!cointHistories.has(cfg.label)) {
        cointHistories.set(cfg.label, createPairHistory(p1, p2));
      }
      const history = cointHistories.get(cfg.label)!;

      const zScore = updatePairHistory(history, p1, p2);
      if (isNaN(zScore)) continue;  // not enough observations yet

      const absZ = Math.abs(zScore);
      if (absZ < COINT_Z_THRESHOLD) continue;

      // Edge estimate: use z-score magnitude scaled conservatively
      const edgePct = Math.min((absZ - COINT_Z_THRESHOLD) * 0.05 + 0.05, 0.50);

      // Direction: if spread is above mean (z > 0), asset1 is expensive → short it
      const direction: "long_asset1" | "short_asset1" = zScore < 0 ? "long_asset1" : "short_asset1";

      signals.push({
        pair: cfg.label,
        asset1: cfg.sym1,
        asset2: cfg.sym2,
        price1: p1,
        price2: p2,
        hedgeRatio: history.kalman.beta,
        spread: history.spreads[history.spreads.length - 1] ?? 0,
        zScore,
        direction,
        edgePct,
        observations: history.spreads.length,
        timestamp: now,
      });
    }

    res.json({ signals, scannedAt: now });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
