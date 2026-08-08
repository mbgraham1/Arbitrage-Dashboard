/**
 * PROFIT HUNTER — 24-hour read-only evidence collector.
 *
 * Continuously samples every strategy the app can reliably price and RECORDS
 * the results; it NEVER places trades. The point is to gather enough evidence
 * over a full day to identify which strategy × venue combination is actually
 * worth wiring to live execution next.
 *
 * Strategies sampled per tick (~30s):
 *  - spot-cross      : taker-taker across 8 public venues + Kraken/Coinbase
 *  - maker-hedge     : CB-maker/K-hedge and K-maker/CB-hedge structures
 *  - stablecoin      : USDT/USD and USDC/USD dislocations across USD venues
 *  - perp-funding    : spot-vs-perp funding carry (OKX, Gate.io) — 24h carry
 *                      net of entry+exit taker fees, informational
 *
 * Per opportunity we track: how often it appears, how long it survives,
 * best/worst/average executable net at $10 (plus latest $50/$100), what it
 * requires, and whether it was actually executable with the user's balances
 * (only when keys were provided at start — otherwise honestly "unknown").
 *
 * Ranking = realized-style expected value: avg positive net × frequency ×
 * survivability, never raw spread. State persists to disk so a server
 * restart doesn't wipe the evidence.
 */
import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import { MmScanBody } from "@workspace/api-zod";
import { z } from "zod";
import { geminiVerify, type GeminiAccount, type GeminiCreds } from "../lib/gemini";
import { VENUES, fetchAllVenueBooks, walkBuyUsd, walkSellQty } from "../lib/venues";
import { fetchStableBooks, fetchPerpBasis } from "../lib/hunter-sources";
import { getStreamBook, getCoinbaseStreamBook } from "../lib/book-stream";
import { OB_USD_PAIRS, type ObAsset } from "../lib/order-book";
import { projectCbMakerHedge, projectMakerHedge } from "../lib/cross-mm";
import { detectFees, fetchBalances, krakenCodesFor, type Creds, type Fees, type Balances } from "./cb-maker-hedge";

const router: IRouter = Router();

const ASSETS = [
  "BTC", "ETH", "SOL", "XRP", "LINK", "DOGE", "AVAX", "LTC",
  "ADA", "DOT", "UNI", "AAVE", "ATOM", "BCH", "FIL",
] as const satisfies readonly ObAsset[];
const PERP_ASSETS = ["BTC", "ETH", "SOL"] as const;
// Full sweep parity with discovery: bounded by depth, evidence-only above the
// $10 live cap. netAt() looks nets up BY SIZE — never by array index (the old
// index-vs-size coupling was a real bug class).
const SIZES = [5, 10, 25, 50, 100, 250] as const;
const netAt = (nets: ReadonlyArray<number | null>, size: number): number | null =>
  nets[(SIZES as readonly number[]).indexOf(size)] ?? null;
const TICK_MS = 30_000;
const BUFFER_PER_10 = 0.02;
const MAX_TRACKED = 600;               // bound the stats map
const RECORD_NET10_ABOVE = -0.06;      // record near-misses + positives only
const STATE_FILE = path.join(process.cwd(), ".data", "profit-hunter.json");

// Assumed fees when no keys were provided at start (labeled in the report).
const ASSUMED: Fees = { cbMakerPct: 0.60, cbTakerPct: 1.20, kTakerPct: 0.40, kMakerPct: 0.25, detectedAt: 0 };

type Category = "EXECUTABLE_NOW" | "NEEDS_ACCOUNT_OR_INVENTORY" | "NOT_PROFITABLE";
type OppStat = {
  key: string;
  strategy: "spot-cross" | "maker-hedge" | "stablecoin" | "perp-funding";
  asset: string; venues: string; description: string;
  requirement: string;
  category: Category;
  executableKnown: boolean;          // false = no keys, so "executable now" was unverifiable
  appearances: number;               // ticks with net10 > 0
  sampledTicks: number;              // ticks this opp was priceable
  streak: number;
  lastBestSizeUsd?: number; lastBestNetUsd?: number;   // best size in the LAST tick's sweep
  bestEverSizeUsd?: number; bestEverNetUsd?: number;   // best sweep point ever observed
  longestStreakTicks: number;
  best10: number; worst10: number; sum10: number;
  last10: number | null; last50: number | null; last100: number | null;
  firstSeenAt: string; lastSeenAt: string;
  executableNowTicks: number;
};

const hunter = {
  running: false,
  startedAt: null as string | null,
  endsAt: null as string | null,
  ticks: 0,
  lastTickAt: null as string | null,
  lastTickMs: 0,
  feeSource: "assumed" as "detected" | "assumed",
  stopReason: null as string | null,
  errors: [] as string[],
};
let stats = new Map<string, OppStat>();
let hunterCreds: Creds | null = null;
// Gemini keys (read-only: detected fees + balances only; never persisted, never trades).
let hunterGeminiCreds: GeminiCreds | null = null;
let timer: NodeJS.Timeout | null = null;
let tickRunning = false;

// ── persistence ──────────────────────────────────────────────────────────────
function saveState(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ hunter: { ...hunter }, stats: [...stats.values()] }));
  } catch { /* non-fatal */ }
}
function loadState(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { hunter?: typeof hunter; stats?: OppStat[] };
    if (j.stats) stats = new Map(j.stats.map(s => [s.key, s]));
    if (j.hunter) {
      const wasRunning = j.hunter.running && j.hunter.endsAt && Date.now() < Date.parse(j.hunter.endsAt);
      Object.assign(hunter, j.hunter, { running: false, stopReason: j.hunter.running && !wasRunning ? "24h window elapsed during downtime — report is ready" : j.hunter.stopReason });
      if (wasRunning) {
        // AUTO-RESUME: the 24h window is still open — continue sampling.
        // Credentials never persist, so the resumed run uses labeled assumed
        // fees until the user restarts it with keys.
        hunter.running = true;
        hunter.feeSource = "assumed";
        hunter.stopReason = null;
        hunter.errors.unshift(`${new Date().toISOString()} server restarted — hunt auto-resumed WITHOUT keys (evidence kept; restart with keys for balance-verified rows)`);
        timer = setInterval(() => { void sampleTick(); }, TICK_MS);
      }
    }
  } catch { /* start fresh */ }
}
loadState();

// ── recording ────────────────────────────────────────────────────────────────
function record(o: {
  key: string; strategy: OppStat["strategy"]; asset: string; venues: string; description: string;
  requirement: string; net10: number; net50: number | null; net100: number | null;
  executableNow: boolean | null; // null = unknown (no keys)
  sweep?: Array<{ sizeUsd: number; netUsd: number | null }>; // full feasible-size sweep (evidence)
}): void {
  // Only the huge spot-cross space gets the near-miss filter; the other
  // strategies have a small bounded key space and are ALWAYS recorded so
  // their best/worst/avg evidence is complete.
  if (o.strategy === "spot-cross" && o.net10 <= RECORD_NET10_ABOVE && !stats.has(o.key)) return;
  const now = new Date().toISOString();
  let s = stats.get(o.key);
  if (!s) {
    if (stats.size >= MAX_TRACKED) {
      // Evict the worst non-positive entry to stay bounded.
      let worst: OppStat | null = null;
      for (const x of stats.values()) if (x.best10 <= 0 && (!worst || x.sum10 / Math.max(1, x.sampledTicks) < worst.sum10 / Math.max(1, worst.sampledTicks))) worst = x;
      if (!worst) return;
      stats.delete(worst.key);
    }
    s = {
      key: o.key, strategy: o.strategy, asset: o.asset, venues: o.venues, description: o.description,
      requirement: o.requirement, category: "NOT_PROFITABLE", executableKnown: o.executableNow != null,
      appearances: 0, sampledTicks: 0, streak: 0, longestStreakTicks: 0,
      best10: -Infinity, worst10: Infinity, sum10: 0,
      last10: null, last50: null, last100: null,
      firstSeenAt: now, lastSeenAt: now, executableNowTicks: 0,
    };
    stats.set(o.key, s);
  }
  s.sampledTicks++;
  s.lastSeenAt = now;
  s.last10 = o.net10; s.last50 = o.net50; s.last100 = o.net100;
  if (o.sweep) {
    const best = o.sweep.filter(x => x.netUsd != null).sort((a, b) => b.netUsd! - a.netUsd!)[0];
    if (best) {
      s.lastBestSizeUsd = best.sizeUsd; s.lastBestNetUsd = best.netUsd!;
      if (s.bestEverNetUsd == null || best.netUsd! > s.bestEverNetUsd) { s.bestEverNetUsd = best.netUsd!; s.bestEverSizeUsd = best.sizeUsd; }
    }
  }
  s.best10 = Math.max(s.best10, o.net10);
  s.worst10 = Math.min(s.worst10, o.net10);
  s.sum10 += o.net10;
  s.requirement = o.requirement;
  s.executableKnown = o.executableNow != null;
  if (o.net10 > 0) {
    s.appearances++;
    s.streak++;
    s.longestStreakTicks = Math.max(s.longestStreakTicks, s.streak);
    if (o.executableNow === true) { s.executableNowTicks++; s.category = "EXECUTABLE_NOW"; }
    else s.category = "NEEDS_ACCOUNT_OR_INVENTORY";
  } else {
    s.streak = 0;
    s.category = "NOT_PROFITABLE";
  }
}

// ── sampling ─────────────────────────────────────────────────────────────────
type Leg = {
  regionOk?: boolean; candidate?: boolean; id: string; name: string; takerPct: number; basisPct: number; bids: [number, number][]; asks: [number, number][] };

function crossNets(buy: Leg, sell: Leg): Array<number | null> {
  return SIZES.map(sz => {
    const b = walkBuyUsd(buy.asks, sz);
    if (!b) return null;
    const s = walkSellQty(sell.bids, b.qty);
    if (!s) return null;
    const fees = sz * (buy.takerPct / 100) + s.usd * (sell.takerPct / 100);
    const basis = sz * (buy.basisPct / 100) + s.usd * (sell.basisPct / 100);
    return s.usd - sz - fees - basis - BUFFER_PER_10 * (sz / 10);
  });
}

async function sampleTick(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  const t0 = Date.now();
  try {
    hunter.ticks++;
    hunter.lastTickAt = new Date().toISOString();
    if (hunter.endsAt && Date.now() > Date.parse(hunter.endsAt)) { stopHunter("24h window complete — report is ready"); return; }

    let fees: Fees = ASSUMED;
    let bal: Balances | null = null;
    if (hunterCreds) {
      try { fees = await detectFees(hunterCreds); bal = await fetchBalances(hunterCreds); hunter.feeSource = "detected"; }
      catch { hunter.feeSource = "assumed"; }
    }
    const invCheck = (buyVenue: string, sellVenue: string, asset: string, qty10: number): boolean | null => {
      if (!bal) return null;
      const usdOk = buyVenue === "kraken" ? bal.kUsd >= 10.2 : buyVenue === "coinbase" ? bal.cbUsd >= 10.2 : false;
      const assetBal = sellVenue === "kraken"
        ? krakenCodesFor(asset).reduce((a, c) => a + (bal!.kAssets.get(c) ?? 0), 0)
        : sellVenue === "coinbase" ? (bal.cbAssets.get(asset) ?? 0) : 0;
      return usdOk && assetBal >= qty10 * 1.02;
    };

    // Gemini (read-only): detected fee tier when keys were provided at start.
    let gemAcct: GeminiAccount | null = null;
    if (hunterGeminiCreds) {
      try { gemAcct = await geminiVerify(hunterGeminiCreds); } catch { gemAcct = null; /* fall back to labeled assumptions */ }
    }

    // 1. spot-cross across all venues
    const books = await fetchAllVenueBooks(ASSETS);
    for (const asset of ASSETS) {
      const legs: Leg[] = [];
      for (const v of VENUES) {
        const b = books.get(`${v.id}:${asset}`);
        if (b) {
          const isGem = v.id === "gemini" && gemAcct != null;
          legs.push({ id: v.id, name: v.regionOk ? v.name : `${v.name} (region-unavailable)`, regionOk: v.regionOk, candidate: v.candidate, takerPct: isGem ? gemAcct!.takerPct : v.assumedTakerPct, basisPct: v.basisHaircutPct, bids: b.bids, asks: b.asks });
        }
      }
      const kB = getStreamBook(OB_USD_PAIRS[asset]);
      if (kB && kB.ageMs < 5000 && kB.bids.length) legs.push({ id: "kraken", name: "Kraken", takerPct: fees.kTakerPct, basisPct: 0, bids: kB.bids, asks: kB.asks });
      const cB = getCoinbaseStreamBook(`${asset}-USD`);
      if (cB && cB.ageMs < 5000 && cB.bids.length) legs.push({ id: "coinbase", name: "Coinbase", takerPct: fees.cbTakerPct, basisPct: 0, bids: cB.bids, asks: cB.asks });
      for (const buy of legs) for (const sell of legs) {
        if (buy.id === sell.id) continue;
        const nets = crossNets(buy, sell);
        const n10 = netAt(nets, 10), n50 = netAt(nets, 50), n100 = netAt(nets, 100);
        if (n10 == null) continue;
        const liveOnly = ["kraken", "coinbase"].includes(buy.id) && ["kraken", "coinbase"].includes(sell.id);
        const regionBlocked = buy.regionOk === false || sell.regionOk === false;
        const qty10 = 10 / (buy.asks[0]?.[0] ?? 1);
        const execNow = liveOnly && !regionBlocked ? invCheck(buy.id, sell.id, asset, qty10) : false;
        record({
          key: `x:${asset}:${buy.id}>${sell.id}`, strategy: "spot-cross", asset,
          venues: `${buy.name}→${sell.name}`,
          description: `buy ${asset} on ${buy.name}, sell on ${sell.name} (taker both)`,
          requirement: regionBlocked
            ? "venue UNAVAILABLE in your region — market context only, never actionable"
            : liveOnly
              ? `$10.20 USD on ${buy.name} + ${(qty10 * 1.02).toFixed(6)} ${asset} on ${sell.name}`
              : `funded account on ${[buy, sell].filter(l => !["kraken", "coinbase"].includes(l.id)).map(l => `${l.name}${l.candidate ? " (PR-accessible candidate — public data only until API access verified)" : ""}`).join(" + ")}`,
          net10: n10, net50: n50, net100: n100, executableNow: execNow,
          sweep: SIZES.map((sz, i) => ({ sizeUsd: sz, netUsd: nets[i] ?? null })),
        });
      }
    }

    // 2. maker-hedge structures (live venues)
    for (const asset of ASSETS) {
      for (const direction of ["buy", "sell"] as const) {
        const cb = projectCbMakerHedge(asset, direction, 10, fees.cbMakerPct, fees.kTakerPct);
        if (cb) {
          const n = (sz: number) => projectCbMakerHedge(asset, direction, sz, fees.cbMakerPct, fees.kTakerPct)?.projectedNetUsd ?? null;
          const execNow = bal ? invCheck(direction === "buy" ? "coinbase" : "kraken", direction === "buy" ? "kraken" : "coinbase", asset, cb.makerQty) : null;
          record({
            key: `m:cb:${asset}:${direction}`, strategy: "maker-hedge", asset,
            venues: "Coinbase(maker)→Kraken(hedge)",
            description: `post-only ${direction} on Coinbase, hedge on Kraken after fill`,
            requirement: direction === "buy" ? `$10.20 USD on Coinbase + ${(cb.makerQty * 1.02).toFixed(6)} ${asset} on Kraken` : `${(cb.makerQty * 1.02).toFixed(6)} tradable ${asset} on Coinbase + $10.20 on Kraken`,
            net10: cb.projectedNetUsd - BUFFER_PER_10, net50: n(50), net100: n(100), executableNow: execNow,
            sweep: SIZES.map(sz => ({ sizeUsd: sz, netUsd: sz === 10 ? cb.projectedNetUsd - BUFFER_PER_10 : n(sz) })),
          });
        }
        if (fees.kMakerPct != null) {
          const km = projectMakerHedge(asset, direction, 10, fees.kMakerPct, fees.cbTakerPct);
          if (km) {
            const n = (sz: number) => projectMakerHedge(asset, direction, sz, fees.kMakerPct!, fees.cbTakerPct)?.projectedNetUsd ?? null;
            const execNow = bal ? invCheck(direction === "buy" ? "kraken" : "coinbase", direction === "buy" ? "coinbase" : "kraken", asset, km.makerQty) : null;
            record({
              key: `m:k:${asset}:${direction}`, strategy: "maker-hedge", asset,
              venues: "Kraken(maker)→Coinbase(hedge)",
              description: `post-only ${direction} on Kraken, hedge on Coinbase after fill`,
              requirement: direction === "buy" ? `$10.20 USD on Kraken + ${(km.makerQty * 1.02).toFixed(6)} ${asset} on Coinbase` : `${(km.makerQty * 1.02).toFixed(6)} ${asset} on Kraken + $10.20 on Coinbase`,
              net10: km.projectedNetUsd - BUFFER_PER_10, net50: n(50), net100: n(100), executableNow: execNow,
              sweep: SIZES.map(sz => ({ sizeUsd: sz, netUsd: sz === 10 ? km.projectedNetUsd - BUFFER_PER_10 : n(sz) })),
            });
          }
        }
      }
    }

    // 3. stablecoin dislocations (USD-quoted venues only — no basis haircut)
    for (const stable of ["USDT", "USDC"] as const) {
      const sBooks = await fetchStableBooks(stable);
      for (const buy of sBooks) for (const sell of sBooks) {
        if (buy.venue === sell.venue) continue;
        const legs: [Leg, Leg] = [
          { id: buy.venue, name: buy.venueName, takerPct: buy.takerPct, basisPct: 0, bids: buy.bids, asks: buy.asks },
          { id: sell.venue, name: sell.venueName, takerPct: sell.takerPct, basisPct: 0, bids: sell.bids, asks: sell.asks },
        ];
        const nets = crossNets(legs[0], legs[1]);
        const n10 = netAt(nets, 10), n50 = netAt(nets, 50), n100 = netAt(nets, 100);
        if (n10 == null) continue;
        record({
          key: `s:${stable}:${buy.venue}>${sell.venue}`, strategy: "stablecoin", asset: stable,
          venues: `${buy.venueName}→${sell.venueName}`,
          description: `buy ${stable} at ${buy.venueName}, sell at ${sell.venueName} (USD both sides)${[buy, sell].some(l => l.venue === "gemini") ? " — Gemini stablecoin fee schedule assumed (~0.03% taker), dramatically below its spot tiers" : ""}`,
          requirement: buy.regionOk === false || sell.regionOk === false
            ? "venue UNAVAILABLE in your region — market context only"
            : `$10.20 USD on ${buy.venueName} + ~10.2 ${stable} on ${sell.venueName}${["kraken", "coinbase"].includes(buy.venue) && ["kraken", "coinbase"].includes(sell.venue) ? "" : " (needs account — public data only until API access verified)"}`,
          net10: n10, net50: n50, net100: n100,
          sweep: SIZES.map((sz, i) => ({ sizeUsd: sz, netUsd: nets[i] ?? null })),
          executableNow: false, // stables aren't wired to any live executor — evidence only
        });
      }
    }

    // 4. spot-vs-perp funding carry (informational — requires derivatives account)
    const basis = await fetchPerpBasis(PERP_ASSETS);
    for (const b of basis) {
      // 24h carry: 3 funding periods; entry+exit ≈ 4 taker legs ~0.05-0.10% each.
      const roundTripFeePct = 0.30;
      const carry24hPct = Math.abs(b.fundingRate8hPct) * 3 - roundTripFeePct;
      const nets = SIZES.map(sz => (carry24hPct / 100) * sz - BUFFER_PER_10 * (sz / 10));
      record({
        key: `p:${b.venue}:${b.asset}`, strategy: "perp-funding", asset: b.asset,
        venues: `${b.venue} perp+spot`,
        description: `${b.carrySide} carry: funding ${b.fundingRate8hPct.toFixed(4)}%/8h, basis ${b.basisPct.toFixed(3)}% — 24h carry net of ~${roundTripFeePct}% entry+exit fees`,
        requirement: `derivatives-enabled ${b.venue} account (USDT-margined) — NOT executable from this app`,
        net10: netAt(nets, 10) ?? 0, net50: netAt(nets, 50), net100: netAt(nets, 100),
        executableNow: false,
        sweep: SIZES.map((sz, i) => ({ sizeUsd: sz, netUsd: nets[i] ?? null })),
      });
    }

    saveState(); // every tick — a restart may never silently lose more than ~30s of evidence
  } catch (e) {
    hunter.errors.unshift(`${new Date().toISOString()} ${(e as Error).message.slice(0, 100)}`);
    if (hunter.errors.length > 10) hunter.errors.length = 10;
  } finally {
    hunter.lastTickMs = Date.now() - t0;
    tickRunning = false;
  }
}

function stopHunter(reason: string): void {
  hunter.running = false;
  hunter.stopReason = reason;
  hunterCreds = null;
  hunterGeminiCreds = null;
  if (timer) { clearInterval(timer); timer = null; }
  saveState();
}

// ── endpoints ────────────────────────────────────────────────────────────────
router.post("/arb/hunter/start", async (req, res): Promise<void> => {
  const parsed = MmScanBody.partial().safeParse(req.body ?? {});
  const c = parsed.success ? parsed.data : {};
  if (hunter.running) { res.status(409).json({ error: "Profit Hunter is already running" }); return; }
  const hasCreds = !!(c.krakenKey && c.krakenSecret && c.coinbaseKey && c.coinbaseSecret);
  hunterCreds = hasCreds ? { krakenKey: c.krakenKey!, krakenSecret: c.krakenSecret!, coinbaseKey: c.coinbaseKey!, coinbaseSecret: c.coinbaseSecret! } : null;
  const gc = z.object({ geminiKey: z.string().min(1), geminiSecret: z.string().min(1) }).safeParse(req.body ?? {});
  hunterGeminiCreds = gc.success ? gc.data : null;
  const hours = 24;
  hunter.running = true;
  hunter.startedAt = new Date().toISOString();
  hunter.endsAt = new Date(Date.now() + hours * 3600_000).toISOString();
  hunter.stopReason = null;
  hunter.feeSource = hasCreds ? "detected" : "assumed";
  timer = setInterval(() => { void sampleTick(); }, TICK_MS);
  void sampleTick();
  res.json({ ok: true, startedAt: hunter.startedAt, endsAt: hunter.endsAt, withKeys: hasCreds, note: `${hasCreds ? "sampling with YOUR detected Kraken/Coinbase fees + balance-verified executability" : "sampling with labeled assumed fees — executability unverifiable without keys"}${hunterGeminiCreds ? "; Gemini keys connected (read-only) — detected Gemini fee tier in use, Gemini never trades" : ""}` });
});

router.post("/arb/hunter/stop", (_req, res) => {
  if (!hunter.running) { res.json({ ok: true, alreadyStopped: true }); return; }
  stopHunter("stopped by user");
  res.json({ ok: true });
});

router.post("/arb/hunter/reset", (_req, res) => {
  stats = new Map();
  saveState();
  res.json({ ok: true });
});

router.get("/arb/hunter/report", (_req, res) => {
  const rows = [...stats.values()].map(s => {
    const freq = s.sampledTicks > 0 ? s.appearances / s.sampledTicks : 0;
    const avg10 = s.sampledTicks > 0 ? s.sum10 / s.sampledTicks : 0;
    const survivalSec = s.longestStreakTicks * (TICK_MS / 1000);
    // Realized-style expected value per opportunity-hour: average net when
    // positive × how often it's there × how long it survives (capped factor).
    const avgWhenPositive = s.appearances > 0 ? Math.max(0, avg10) : 0;
    const score = avgWhenPositive * freq * Math.min(1, s.longestStreakTicks / 4);
    return {
      key: s.key, strategy: s.strategy, asset: s.asset, venues: s.venues,
      description: s.description, requirement: s.requirement,
      category: s.category, executableKnown: s.executableKnown,
      appearances: s.appearances, sampledTicks: s.sampledTicks,
      frequencyPct: Math.round(freq * 1000) / 10,
      longestSurvivalSec: survivalSec,
      best10: s.best10 === -Infinity ? null : s.best10,
      worst10: s.worst10 === Infinity ? null : s.worst10,
      avg10: s.sampledTicks > 0 ? avg10 : null,
      last10: s.last10, last50: s.last50, last100: s.last100,
      executableNowTicks: s.executableNowTicks,
      firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt,
      score,
    };
  }).sort((a, b) => b.score - a.score || (b.best10 ?? -1e9) - (a.best10 ?? -1e9));

  const positives = rows.filter(r => (r.best10 ?? 0) > 0);
  const strategyBest: typeof rows = [];
  for (const strat of ["spot-cross", "maker-hedge", "stablecoin", "perp-funding"]) {
    const best = rows.filter(r => r.strategy === strat)
      .sort((a, b) => (b.best10 ?? -1e9) - (a.best10 ?? -1e9))[0];
    if (best) strategyBest.push(best);
  }
  res.json({
    running: hunter.running,
    startedAt: hunter.startedAt, endsAt: hunter.endsAt, lastTickAt: hunter.lastTickAt,
    ticks: hunter.ticks, lastTickMs: hunter.lastTickMs,
    feeSource: hunter.feeSource, stopReason: hunter.stopReason,
    tracked: stats.size,
    errors: hunter.errors.slice(0, 3),
    verdict: positives.length === 0
      ? `After ${hunter.ticks} samples, NO opportunity has shown a positive $10 net even once. That is the evidence so far — nothing is worth wiring to live execution yet.`
      : `${positives.length} opportunity(ies) have shown a positive $10 net at least once. Top candidates below — judge by frequency and survival, not the single best print.`,
    strategyBest,
    top: rows.slice(0, 25),
  });
});

export default router;
