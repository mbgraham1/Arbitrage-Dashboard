/**
 * HERMES SPIKE WEBHOOK — POST /api/hermes/spike
 *
 * Lets the external Hermes monitor nudge the gated 2X executor. The alert
 * carries a COIN NAME ONLY — Hermes's claimed spread is never trusted, no
 * credentials are ever accepted from the caller, and nothing here bypasses
 * a single gate: the request funnels into run2xExecute(), the exact same
 * flow as POST /arb/2x-execute (real fee tiers, 200ms freshness, depth walk,
 * balance/inventory prechecks, net floor + buffer, shared live lock,
 * $10 hard cap, honest ledger).
 *
 * Auth: X-Exec-Token header, SHA-256 compared (constant time) against
 * HERMES_EXEC_TOKEN_SHA256. Separate from the read-only service token —
 * this one can trigger an execution attempt, so it is NEVER a fallback for
 * reads and grants nothing else.
 *
 * Credentials: operator's exchange keys come from server env (Replit
 * Secrets) — the caller cannot supply or override them.
 *
 * Rate limits: per-coin cooldown + global per-minute budget so a chatty
 * monitor cannot hammer the executor (each attempt costs exchange API calls
 * even when gates reject).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { crossTakerBreakdown } from "../lib/cross-pricing";
import type { ObAsset } from "../lib/order-book";
import { SCAN_ASSETS, run2xExecute } from "./two-exchange-scanner";

const COIN_COOLDOWN_MS = 15_000;   // min gap between attempts for the same coin
const GLOBAL_BUDGET_PER_MIN = 6;   // max execution attempts per minute overall
const lastCoinAttempt = new Map<string, number>();
const recentAttempts: number[] = [];

function isValidExecToken(presented: string | undefined): boolean {
  const expected = process.env.HERMES_EXEC_TOKEN_SHA256 ?? "";
  if (!presented || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  const a = Buffer.from(createHash("sha256").update(presented).digest("hex"), "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function hermesSpikeHandler(req: Request, res: Response): Promise<void> {
  if (!isValidExecToken(req.get("x-exec-token"))) {
    res.status(401).json({ error: "invalid or missing X-Exec-Token" });
    return;
  }

  const coin = typeof req.body?.coin === "string" ? req.body.coin.toUpperCase().trim() : "";
  if (!SCAN_ASSETS.includes(coin as ObAsset)) {
    res.status(400).json({ error: `coin must be one of ${SCAN_ASSETS.join(", ")}` });
    return;
  }
  const asset = coin as ObAsset;

  // Rate limits — reject loudly, never queue.
  const now = Date.now();
  while (recentAttempts.length && now - recentAttempts[0] > 60_000) recentAttempts.shift();
  if (recentAttempts.length >= GLOBAL_BUDGET_PER_MIN) {
    res.status(429).json({ executed: false, outcome: "rate_limited", reason: `global budget ${GLOBAL_BUDGET_PER_MIN}/min exhausted` });
    return;
  }
  const last = lastCoinAttempt.get(asset) ?? 0;
  if (now - last < COIN_COOLDOWN_MS) {
    res.status(429).json({ executed: false, outcome: "rate_limited", reason: `cooldown: ${asset} attempted ${((now - last) / 1000).toFixed(1)}s ago (min ${COIN_COOLDOWN_MS / 1000}s)` });
    return;
  }
  recentAttempts.push(now);
  lastCoinAttempt.set(asset, now);

  // Operator keys from server env only — callers never supply credentials.
  const krakenKey = process.env.KRAKEN_API_KEY ?? "";
  const krakenSecret = process.env.KRAKEN_SECRET ?? "";
  const coinbaseKey = process.env.COINBASE_API_KEY ?? "";
  const coinbaseSecret = process.env.COINBASE_SECRET ?? "";
  if (!krakenKey || !krakenSecret || !coinbaseKey || !coinbaseSecret) {
    res.status(503).json({ executed: false, outcome: "unavailable", reason: "operator exchange credentials are not configured on the server" });
    return;
  }

  // Pick the direction with the better CURRENT-book projection (assumed fee
  // ranking only — run2xExecute re-gates with REAL detected fee tiers and
  // refuses to trade if the route doesn't clear net floor + buffer).
  const sizeUsd = 10;
  const proj = (buyVenue: "kraken" | "coinbase") => crossTakerBreakdown(asset, buyVenue, sizeUsd, 0.4, 1.2);
  const pk = proj("kraken");
  const pc = proj("coinbase");
  if (!pk && !pc) {
    res.json({ executed: false, outcome: "skipped", reason: "no live depth books on either direction for this coin", asset });
    return;
  }
  const buyVenue: "kraken" | "coinbase" =
    (pk?.netProfitUsd ?? -Infinity) >= (pc?.netProfitUsd ?? -Infinity) ? "kraken" : "coinbase";

  const out = await run2xExecute(
    { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, asset, buyVenue, sizeUsd, isDryRun: false } as Parameters<typeof run2xExecute>[0],
    req.log,
  );
  res.status(out.status).json({ ...out.body, source: "hermes-spike" });
}
