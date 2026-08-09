/**
 * One-shot legacy trade verification backfill.
 *
 * Runs the exact same core (`verifyLegacyTrades`) as the admin endpoint
 * POST /api/arb/trades/verify-legacy, using Kraken credentials from env.
 *
 * Usage:
 *   KRAKEN_API_KEY=... KRAKEN_SECRET=... tsx scripts/verify-legacy-trades.ts [--apply]
 *
 * Default is a DRY RUN (reports what would be verified, writes nothing).
 * Pass --apply to actually upgrade provable rows to "verified".
 */
import { verifyLegacyTrades } from "../src/routes/arb";

async function main(): Promise<void> {
  const krakenKey = (process.env.KRAKEN_API_KEY ?? "").trim();
  const krakenSecret = (process.env.KRAKEN_SECRET ?? "").trim();
  if (!krakenKey || !krakenSecret) {
    console.error("KRAKEN_API_KEY and KRAKEN_SECRET must be set.");
    process.exit(1);
  }
  const dryRun = !process.argv.includes("--apply");
  console.log(dryRun ? "DRY RUN — no rows will be written (pass --apply to write)." : "APPLY — provable rows will be upgraded to verified.");

  const result = await verifyLegacyTrades({ krakenKey, krakenSecret }, dryRun);
  console.log(JSON.stringify({ dryRun: result.dryRun, scanned: result.scanned, candidates: result.candidates, verified: result.verified, skipped: result.skipped }, null, 2));
  for (const d of result.details) {
    if (d.outcome === "verified") console.log(`  #${d.id}: VERIFIED  realizedProfitUsd=${d.realizedProfitUsd}`);
    else console.log(`  #${d.id}: skipped — ${d.reason}`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
