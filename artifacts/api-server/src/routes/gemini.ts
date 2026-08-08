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
      message: `Connected — detected fee tier ${acct.makerPct.toFixed(3)}% maker / ${acct.takerPct.toFixed(3)}% taker; $${acct.usdBalance.toFixed(2)} USD spendable`,
      makerPct: acct.makerPct,
      takerPct: acct.takerPct,
      usdBalance: acct.usdBalance,
      balances: acct.balances,
      note: "Read-only: Gemini live trading is NOT enabled — keys are used for balances + detected fees in Discovery/Hunter only.",
    });
  } catch (e) {
    res.json({ ok: false, message: (e as Error).message.slice(0, 200), makerPct: null, takerPct: null, usdBalance: null, balances: {}, note: null });
  }
});

export default router;
