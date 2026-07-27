import app from "./app";
import { logger } from "./lib/logger";
import { initPriceFeeds } from "./lib/price-cache";

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
});
