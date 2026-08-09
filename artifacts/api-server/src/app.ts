import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { hermesSpikeHandler } from "./routes/hermes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk proxy must be mounted BEFORE body parsers (it streams raw bytes).
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

/** Every trading/API route requires a signed-in user — this app arms live
 * executors and holds exchange keys in memory; it must never be reachable
 * anonymously. Only the keep-alive health check stays public. */
const PUBLIC_API_PATHS = new Set(["/healthz"]);

/** Read-only service token (for external agents like Hermes).
 * A valid `X-Service-Token` header grants GET-only access to the explicit
 * allowlist below — scan results, execution status, trade history, stats.
 * EVERYTHING else (all POSTs, execute/override/rebalance/hunter controls,
 * credential-bearing routes) returns 403. The token is verified by
 * constant-time SHA-256 comparison against HERMES_TOKEN_SHA256; the raw
 * token is never stored server-side. Do not widen this list with any route
 * that trades, mutates state, or accepts exchange credentials. */
const SERVICE_READ_PATHS = new Set([
  // NOTE: excluded despite being GETs — /arb/graph-scan accepts exchange
  // credentials as query params; /arb/triangular writes scan rows;
  // /arb/cointegration advances Kalman state; /rebalance/status can clear
  // the preflight latch. None may be reachable via a read-only identity.
  "/prices/all-pairs",
  "/arb/scan",
  "/arb/ob-scan",
  "/arb/triangular/history",
  "/arb/triangular/history/summary",
  "/arb/execution-status",
  "/arb/execution-quality",
  "/arb/stream-stats",
  "/arb/inventory-imbalance",
  "/arb/cross-mm-stats",
  "/arb/cb-mm-stats",
  "/arb/xv-stats",
  "/arb/2x-stats",
  "/arb/2x-scan",
  "/arb/mm-auto/status",
  "/arb/xv-auto/status",
  "/arb/hunter/report",
  "/trades",
  "/trades/summary",
]);

function isValidServiceToken(token: string): boolean {
  const expectedHash = process.env.HERMES_TOKEN_SHA256;
  if (!expectedHash || !token) return false;
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  const gotHash = createHash("sha256").update(token).digest("hex");
  const a = Buffer.from(gotHash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_API_PATHS.has(req.path)) { next(); return; }
  const serviceToken = req.get("x-service-token");
  if (serviceToken !== undefined) {
    if (!isValidServiceToken(serviceToken)) {
      res.status(401).json({ error: "Invalid service token" });
      return;
    }
    if (req.method === "GET" && SERVICE_READ_PATHS.has(req.path)) {
      next();
      return;
    }
    res.status(403).json({
      error: "Service token is read-only",
      detail: "This token can only GET allowlisted read endpoints. Trading, execution, overrides, rebalancing, and credential-bearing routes require an authenticated operator session.",
    });
    return;
  }
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.["userId"] || auth?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

// Hermes spike webhook: its OWN execution token (X-Exec-Token, separate from
// the read-only service token), coin-name-only body, full 2X gates inside.
// Mounted before the operator gate on purpose — auth lives in the handler.
app.post("/api/hermes/spike", hermesSpikeHandler);

app.use("/api", requireAuth, router);

export default app;
