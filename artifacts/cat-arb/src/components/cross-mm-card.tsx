/**
 * Maker-Hedge Lab — the maker-post + taker-hedge cross-exchange strategy.
 *
 * Rests a POST-ONLY limit on Kraken, hedges at market on Coinbase ONLY after
 * a confirmed fill. Tracked entirely separately from the triangle strategy
 * (its own scoreboard) so realized P&L can be judged before scaling. Size is
 * hard-capped at $10 server-side during validation.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import { useExecuteCrossMm, useGetCrossMmStats, getGetCrossMmStatsQueryKey, CrossMmExecuteResult } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const MM_ASSETS = ["BTC", "ETH", "SOL", "XRP", "LTC", "LINK", "AVAX", "ADA", "DOGE", "BCH"] as const;

export function CrossMmCard() {
  const { credentials, liveMode, addLog } = useBotContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [asset, setAsset] = useState<string>("ETH");
  const [minProfit, setMinProfit] = useState("0.01");
  const [restWindowSec, setRestWindowSec] = useState("30");
  const [last, setLast] = useState<CrossMmExecuteResult | null>(null);
  const [running, setRunning] = useState(false);
  const exec = useExecuteCrossMm();
  const stats = useGetCrossMmStats({ query: { queryKey: getGetCrossMmStatsQueryKey(), refetchInterval: 15_000 } });

  const hasCreds = !!credentials.krakenKey && !!credentials.krakenSecret && !!credentials.coinbaseKey && !!credentials.coinbaseSecret;

  const run = async (isDryRun: boolean) => {
    if (!hasCreds) { toast({ title: "Kraken AND Coinbase API keys required", variant: "destructive" }); return; }
    setRunning(true);
    try {
      const r = await exec.mutateAsync({ data: {
        krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret,
        coinbaseKey: credentials.coinbaseKey, coinbaseSecret: credentials.coinbaseSecret,
        asset, tradeSizeUsd: 10,
        minProfitUsd: Math.max(0, parseFloat(minProfit) || 0.01),
        restWindowMs: Math.min(120, Math.max(3, parseFloat(restWindowSec) || 30)) * 1000,
        direction: "auto", isDryRun,
      } });
      setLast(r);
      addLog(r.outcome === "hedged" ? "success" : r.error ? "error" : "info", `[MM] ${asset} ${isDryRun ? "DRY" : "LIVE"} → ${r.outcome}${r.realizedProfitUsd != null ? ` realized $${r.realizedProfitUsd.toFixed(4)}` : ""}${r.error ? ` — ${r.error}` : ""}`);
      if (r.outcome === "unhedged") toast({ title: "POSITION OPEN — hedge did not fire", description: r.error ?? "", variant: "destructive" });
      qc.invalidateQueries({ queryKey: getGetCrossMmStatsQueryKey() });
    } catch (e) {
      addLog("error", `[MM] ${asset} failed: ${(e as Error).message}`);
      toast({ title: "Maker-hedge cycle failed", description: (e as Error).message, variant: "destructive" });
    } finally { setRunning(false); }
  };

  const s = stats.data;
  const p = last?.projection;
  return (
    <Card data-testid="card-cross-mm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>Maker-Hedge Lab <span className="text-muted-foreground font-normal">(Kraken post-only → Coinbase hedge, $10 validation cap)</span></span>
          {s && <span className="text-xs font-normal text-muted-foreground" data-testid="text-mm-stats">
            {s.attempts} attempts · {s.makerFills} fills · {s.hedged} hedged{s.unhedged > 0 && <span className="text-red-500"> · {s.unhedged} UNHEDGED</span>} ·{" "}
            <span className={cn(s.realizedTotalUsd >= 0 ? "text-green-500" : "text-red-500")}>${s.realizedTotalUsd.toFixed(2)} realized</span>
          </span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">Asset
            <select className="border rounded bg-background px-2 py-1" value={asset} onChange={e => setAsset(e.target.value)} data-testid="select-mm-asset">
              {MM_ASSETS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">Floor $
            <input className="border rounded bg-background px-2 py-1 w-20" value={minProfit} onChange={e => setMinProfit(e.target.value)} data-testid="input-mm-floor" />
          </label>
          <label className="flex flex-col gap-1">Rest window (s)
            <input className="border rounded bg-background px-2 py-1 w-20" value={restWindowSec} onChange={e => setRestWindowSec(e.target.value)} data-testid="input-mm-window" />
          </label>
          <Button size="sm" variant="secondary" disabled={running || !hasCreds} onClick={() => run(true)} data-testid="button-mm-dry">
            {running ? "Running…" : "Project (dry)"}
          </Button>
          <Button size="sm" variant="destructive" disabled={running || !hasCreds || !liveMode} onClick={() => run(false)} data-testid="button-mm-live">
            {running ? "Running…" : "Run 1 live cycle"}
          </Button>
          {!liveMode && <span className="text-muted-foreground">enable LIVE mode for real cycles</span>}
        </div>
        {last && (
          <div className="rounded border p-2 space-y-1" data-testid="text-mm-result">
            <div>
              outcome: <span className={cn("font-semibold", last.outcome === "hedged" ? "text-green-500" : last.outcome === "unhedged" ? "text-red-500" : "")}>{last.outcome}</span>
              {last.realizedProfitUsd != null && <> · realized <span className={cn(last.realizedProfitUsd >= 0 ? "text-green-500" : "text-red-500")}>${last.realizedProfitUsd.toFixed(4)}</span></>}
            </div>
            {p && <div className="text-muted-foreground">
              {p.direction} maker @{p.makerPrice} qty {p.makerQty.toFixed(6)} → hedge VWAP {p.hedgeVwapPx.toFixed(4)} · projected net ${p.projectedNetUsd.toFixed(4)} (maker fee ${p.makerFeeUsd.toFixed(4)}, hedge fee ${p.hedgeFeeUsd.toFixed(4)}, slip ${(p.hedgeSlippageUsd ?? 0).toFixed(4)}) · books {p.quoteAgeMs}ms
            </div>}
            {last.error && <div className="text-red-500">{last.error}</div>}
          </div>
        )}
        {s && s.recent && s.recent.length > 0 && (
          <div className="text-muted-foreground">
            recent: {s.recent.slice(0, 5).map((r, i) => <span key={i} className="mr-2">{r.route?.replace("MM:", "")} {r.note?.split(":")[0]}{r.realizedProfitUsd != null ? ` $${r.realizedProfitUsd.toFixed(3)}` : ""}</span>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
