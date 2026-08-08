/**
 * CB-Maker / Kraken-Hedge — the inverted maker-hedge strategy.
 *
 * Posts a POST-ONLY maker limit on Coinbase (cheap maker fee, earns spread);
 * hedges taker on Kraken ONLY after a confirmed fill. If the projected hedge
 * degrades below the floor while the order rests, it is cancelled before any
 * fill — no hedge is ever opened for an unfilled order. $10 validation size,
 * real detected fees only, maker-floor safeguard enforced server-side.
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import { useExecuteCbMm, useGetCbMmStats, getGetCbMmStatsQueryKey, CbMmExecuteResult } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const ASSETS = ["ETH", "BTC", "SOL"] as const;
const fmt = (v: number | null | undefined, d = 4) => (v == null ? "—" : `$${v.toFixed(d)}`);

export function CbMmCard() {
  const { credentials, liveMode, addLog } = useBotContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [asset, setAsset] = useState<string>("ETH");
  const [restWindowSec, setRestWindowSec] = useState("30");
  const [last, setLast] = useState<CbMmExecuteResult | null>(null);
  const [running, setRunning] = useState(false);
  const exec = useExecuteCbMm();
  const stats = useGetCbMmStats({ query: { queryKey: getGetCbMmStatsQueryKey(), refetchInterval: 15_000 } });

  const hasCreds = !!credentials.krakenKey && !!credentials.krakenSecret && !!credentials.coinbaseKey && !!credentials.coinbaseSecret;

  const run = async () => {
    if (!hasCreds) { toast({ title: "Kraken AND Coinbase API keys required", variant: "destructive" }); return; }
    if (!liveMode) { toast({ title: "Enable LIVE mode to run this strategy", variant: "destructive" }); return; }
    setRunning(true);
    addLog("info", `MM2: attempting ${asset} Coinbase-maker / Kraken-hedge cycle`);
    try {
      const r = await exec.mutateAsync({ data: {
        krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret,
        coinbaseKey: credentials.coinbaseKey, coinbaseSecret: credentials.coinbaseSecret,
        asset, sizeUsd: 10, restWindowSec: Math.min(120, Math.max(5, parseFloat(restWindowSec) || 30)),
      } });
      setLast(r);
      const ok = r.outcome === "completed";
      addLog(ok ? "success" : r.outcome === "skipped" || r.outcome === "no_fill" ? "info" : "warning", `MM2 ${r.outcome}: ${r.reason}`);
      qc.invalidateQueries({ queryKey: getGetCbMmStatsQueryKey() });
      if (r.outcome === "unhedged" || r.outcome === "indeterminate") {
        toast({ title: `MM2 ${r.outcome} — attention required`, description: r.reason ?? "", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "MM2 execute failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card data-testid="card-cb-mm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          CB-Maker / Kraken-Hedge{" "}
          <span className="text-muted-foreground font-normal">
            (post-only maker on Coinbase · taker hedge on Kraken ONLY after a confirmed fill · $10 · real fees only)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="text-muted-foreground">
          Cuts the fee stack from ~1.6% (taker-taker) to ~1.0% and earns the spread on the maker side.
          The maker order is cancelled before fill if the projected hedge falls below the profit floor
          (maker-floor safeguard: at least $0.25 net on $10). No fill → nothing traded.
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={asset} onChange={e => setAsset(e.target.value)} className="bg-background border rounded px-2 py-1" data-testid="select-mm2-asset">
            {ASSETS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <label className="text-muted-foreground">rest window (s)</label>
          <input value={restWindowSec} onChange={e => setRestWindowSec(e.target.value)} className="bg-background border rounded px-2 py-1 w-16" data-testid="input-mm2-rest" />
          <Button size="sm" disabled={running || !hasCreds || !liveMode} onClick={run} data-testid="button-mm2-run">
            {running ? "resting…" : "Run $10 cycle (LIVE)"}
          </Button>
          {!liveMode && <span className="text-muted-foreground">LIVE mode off</span>}
        </div>
        {last && (
          <div className={cn("border rounded p-2 space-y-1", last.outcome === "completed" ? "border-green-500/40" : last.outcome === "unhedged" || last.outcome === "indeterminate" ? "border-red-500/40" : "border-border")} data-testid="text-mm2-last">
            <div>outcome: <span className="font-semibold">{last.outcome}</span> — {last.reason}</div>
            {last.makerLeg && <div>maker [{last.makerLeg.venue} {last.makerLeg.side}] {last.makerLeg.status} qty {last.makerLeg.filledQty} @ {last.makerLeg.avgPrice ?? "—"} fee {fmt(last.makerLeg.feeUsd)} · {last.makerLeg.latencyMs}ms · {last.makerLeg.orderId}</div>}
            {last.hedgeLeg && <div>hedge [{last.hedgeLeg.venue} {last.hedgeLeg.side}] {last.hedgeLeg.status} qty {last.hedgeLeg.filledQty} @ {last.hedgeLeg.avgPrice ?? "—"} fee {fmt(last.hedgeLeg.feeUsd)} · {last.hedgeLeg.latencyMs}ms · {last.hedgeLeg.orderId}</div>}
            {last.realizedProfitUsd != null && <div>realized: <span className={cn("font-semibold", last.realizedProfitUsd >= 0 ? "text-green-500" : "text-red-500")}>{fmt(last.realizedProfitUsd)}</span></div>}
          </div>
        )}
        <div data-testid="text-mm2-stats">
          strategy realized P&L:{" "}
          <span className={cn("font-semibold", (stats.data?.cumulativeRealizedUsd ?? 0) >= 0 ? "text-green-500" : "text-red-500")}>
            {fmt(stats.data?.cumulativeRealizedUsd ?? 0)}
          </span>{" "}
          across {stats.data?.completed ?? 0} completed / {stats.data?.trades ?? 0} total cycles
          {(stats.data?.incomplete ?? 0) > 0 && <span className="text-amber-500"> · {stats.data?.incomplete} incomplete (unhedged/indeterminate — no realized P&L)</span>}
        </div>
      </CardContent>
    </Card>
  );
}
