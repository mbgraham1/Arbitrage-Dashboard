import { createHash } from "node:crypto";
import { krakenFeeTiers, getCoinbaseFeeTier } from "./exchange";
import { OB_USD_PAIRS } from "./order-book";

export type FeeCreds = { krakenKey?: string; krakenSecret?: string; coinbaseKey?: string; coinbaseSecret?: string };
export type Fees = { cbMakerPct: number; cbTakerPct: number; kTakerPct: number; kMakerPct: number | null; detectedAt: number };

const FEE_CACHE_MS = 10 * 60 * 1000;
const feeCache = new Map<string, Fees>();
// SHA-256 of the full key identifiers — collision-resistant, never persisted or logged.
const credKey = (c: FeeCreds) => createHash("sha256").update(`${c.krakenKey ?? ""}\u0000${c.coinbaseKey ?? ""}`).digest("hex");

/** Detect REAL fee tiers on both venues — cached 10 min per credential pair. Throws instead of guessing. */
export async function detectFees(creds: FeeCreds): Promise<Fees> {
  const k = credKey(creds);
  const hit = feeCache.get(k);
  if (hit && Date.now() - hit.detectedAt < FEE_CACHE_MS) return hit;
  if (!creds.krakenKey || !creds.krakenSecret || !creds.coinbaseKey || !creds.coinbaseSecret) {
    throw new Error("API credentials for both venues are required to detect real fee tiers");
  }
  const [kTier, cbTier] = await Promise.all([
    krakenFeeTiers({ krakenKey: creds.krakenKey, krakenSecret: creds.krakenSecret }, [OB_USD_PAIRS.ETH, OB_USD_PAIRS.BTC]),
    getCoinbaseFeeTier({ coinbaseKey: creds.coinbaseKey, coinbaseSecret: creds.coinbaseSecret }),
  ]);
  if (!kTier) throw new Error("Kraken fee tier unavailable");
  const f: Fees = { cbMakerPct: cbTier.makerFeePct, cbTakerPct: cbTier.takerFeePct, kTakerPct: kTier.takerFeePct, kMakerPct: kTier.makerFeePct, detectedAt: Date.now() };
  feeCache.set(k, f);
  return f;
}
