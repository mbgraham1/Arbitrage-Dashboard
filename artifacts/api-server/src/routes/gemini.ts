/**
 * gemini.ts (route) — Gemini connection test: verifies API keys, returns
 * spendable balances and the DETECTED fee tier. Read-only; Gemini live
 * trading is NOT enabled anywhere — execution stays Kraken/Coinbase only.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { geminiVerify } from "../lib/gemini";

const router: IRouter = Router();

const Body = z.object({ geminiKey: z.string().min(1), geminiSecret: z.string().min(1) });

router.post("/test-gemini", async (req, res): Promise<void> => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "geminiKey and geminiSecret are required" }); return; }
  try {
    const acct = await geminiVerify(parsed.data);
    res.json({
      ok: true,
      message: acct.scopeIssue
        ? `Auth + fee tier verified (${acct.makerPct.toFixed(3)}% maker / ${acct.takerPct.toFixed(3)}% taker) — BUT balances are NOT verified: ${acct.scopeIssue}`
        : `Connected — detected fee tier ${acct.makerPct.toFixed(3)}% maker / ${acct.takerPct.toFixed(3)}% taker; $${acct.usdBalance.toFixed(2)} USD available`,
      makerPct: acct.makerPct,
      takerPct: acct.takerPct,
      usdBalance: acct.scopeIssue ? null : acct.usdBalance, // never render an unverified $0.00 as a real zero
      balances: acct.balances,
      balancesVerified: acct.scopeIssue == null,
      scopeIssue: acct.scopeIssue,
      keyScope: acct.keyScope,
      balanceDetail: acct.balanceDetail,      // per currency: total / available / held
      accountScopes: acct.accountScopes,      // per Gemini account visible to the key
      note: "Read-only endpoint. Live Gemini execution stays blocked while balances or fees are unverified.",
    });
  } catch (e) {
    res.json({ ok: false, message: (e as Error).message.slice(0, 200), makerPct: null, takerPct: null, usdBalance: null, balances: {}, balancesVerified: false, scopeIssue: null, keyScope: null, balanceDetail: [], accountScopes: [], note: null });
  }
});

export default router;
