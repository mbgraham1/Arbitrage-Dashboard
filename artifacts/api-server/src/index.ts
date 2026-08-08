import app from "./app";
import { logger } from "./lib/logger";
import { initPriceFeeds } from "./lib/price-cache";
import { startCrossPairsAutoRefresh, OB_USD_PAIRS, CROSS_LOOKUP } from "./lib/order-book";
import { validateKrakenPrecision } from "./lib/exchange";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Nuclear Keep-Alive (v11.0) ────────────────────────────────────────────────
// Self-pings /api/healthz every 2 minutes so the Replit container never idles.
// Mirrors the Python self_ping() thread from BUTTER PROTOCOL v11.0.
function startKeepAlive(serverPort: number): void {
  const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

  // Prefer the public domain so the ping exercises the full proxy stack;
  // fall back to loopback if no domain is set (local dev).
  const domain = process.env["REPLIT_DEV_DOMAIN"];
  const pingUrl = domain
    ? `https://${domain}/api/healthz`
    : `http://localhost:${serverPort}/api/healthz`;

  setInterval(() => {
    fetch(pingUrl, { signal: AbortSignal.timeout(5000) })
      .then(() => logger.debug({ pingUrl }, "Keep-alive ping OK"))
      .catch((err: unknown) => logger.warn({ err, pingUrl }, "Keep-alive ping failed"));
  }, INTERVAL_MS);

  logger.info({ pingUrl, intervalMs: INTERVAL_MS }, "🔥 Nuclear Keep-Alive activated");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  initPriceFeeds();
  startKeepAlive(port);
  startCrossPairsAutoRefresh();

  // Startup validation: confirm Kraken price/volume precision metadata loads
  // for every pair the engine can trade. Orders for a pair without metadata
  // are REFUSED at submission time — surface any gaps immediately.
  const tradablePairs = [
    ...Object.values(OB_USD_PAIRS),
    ...[...CROSS_LOOKUP.values()].map(c => c.pair),
  ];
  validateKrakenPrecision([...new Set(tradablePairs)])
    .then(missing => {
      if (missing.length) logger.error({ missing }, "⚠️ Kraken precision metadata MISSING for pairs — live orders on these will be refused");
      else logger.info({ pairs: tradablePairs.length }, "Kraken pair precision metadata validated for all tradable pairs");
    })
    .catch(err => logger.error({ err }, "Kraken precision validation failed"));
});
