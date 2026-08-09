import express, { type Express, type Request, type Response, type NextFunction } from "express";
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
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_API_PATHS.has(req.path)) { next(); return; }
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.["userId"] || auth?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

app.use("/api", requireAuth, router);

export default app;
