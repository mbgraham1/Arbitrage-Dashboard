/**
 * Two-Exchange Scanner — profitability-gated Kraken↔Coinbase inventory arb.
 *
 * Continuously shows both directions for ETH/BTC/SOL with a FIRE/SKIP
 * decision and the exact reason. Executes ONE $10-capped cycle only when the
 * server re-projects the route with REAL detected fees and it still clears
 * the floor + safety buffer. Cumulative realized P&L (the only proof of
 * profitability) is shown from the ledger.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import {
  useGet2xScan, getGet2xScanQueryKey,
  useGet2xStats, getGet2xStatsQueryKey,
  useExecute2x, useDetect2xFees, TwoXExecuteResult, TwoXRouteDecision, TwoXFeesResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const fmt = (v: number | null | undefined, d = 4) => (v == null ? "—" : `$${v.toFixed(d)}`);

export function TwoXScannerCard() {
  const { credentials, liveMode, addLog } = useBotContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<TwoXExecuteResult | null>(null);
  const [fees, setFees] = useState<TwoXFeesResult | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);
  const detectFees = useDetect2xFees();
  // Real detected account fee tiers drive the scan display, so the scanner,
  // executor, and P&L all use the SAME fee inputs. Without creds (or on
  // failure) the scan falls back to labelled assumptions — never silently.
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } = credentials;
  useEffect(() => {
    if (!krakenKey || !krakenSecret || !coinbaseKey || !coinbaseSecret) { setFees(null); setFeeError(null); return; }
    let cancelled = false;
    const detect = () => detectFees.mutateAsync({ data: { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } })
      .then(f => { if (!cancelled) { setFees(f); setFeeError(null); } })
      .catch(e => { if (!cancelled) { setFees(null); setFeeError((e as Error).message); } });
    detect();
    const iv = setInterval(detect, 10 * 60_000); // tiers can change with volume — refresh bounded
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [krakenKey, krakenSecret, coinbaseKey, coinbaseSecret]);
  const scanParams = fees ? { krakenFeePct: fees.krakenTakerPct, coinbaseFeePct: fees.coinbaseTakerPct } : undefined;
  const scan = useGet2xScan(scanParams, { query: { queryKey: [...getGet2xScanQueryKey(), scanParams ?? "assumed"], refetchInterval: 3_000 } });
  const stats = useGet2xStats({ query: { queryKey: getGet2xStatsQueryKey(), refetchInterval: 15_000 } });
  const exec = useExecute2x();

  const hasCreds = !!credentials.krakenKey && !!credentials.krakenSecret && !!credentials.coinbaseKey && !!credentials.coinbaseSecret;
  const best = scan.data?.best ?? null;
  const routes = scan.data?.routes ?? [];
  const params = scan.data?.params;

  const fire = async (r: TwoXRouteDecision) => {
    if (!hasCreds || !liveMode) return;
    setRunning(true);
    addLog("info", `2X: firing ${r.asset} ${r.direction} (scan net ${fmt(r.netProfitUsd)})`);
    try {
      const out = await exec.mutateAsync({ data: {
        krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret,
        coinbaseKey: credentials.coinbaseKey, coinbaseSecret: credentials.coinbaseSecret,
        asset: r.asset!, buyVenue: r.buyVenue as "kraken" | "coinbase", sizeUsd: 10,
      } });
      setLast(out);
      addLog(out.outcome === "completed" ? "success" : "warning", `2X ${out.outcome}: ${out.reason}`);
      qc.invalidateQueries({ queryKey: getGet2xStatsQueryKey() });
      if (out.outcome !== "completed" && out.outcome !== "skipped") {
        toast({ title: `2X ${out.outcome}`, description: out.reason ?? "", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "2X execute failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card data-testid="card-2x-scanner">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Two-Exchange Scanner{" "}
          <span className="text-muted-foreground font-normal">
            (Kraken↔Coinbase both directions · ETH/BTC/SOL · $10 validation size · fires only when net &gt; floor + buffer)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {params && (
          <div className="text-muted-foreground" data-testid="text-2x-params">
            floor {fmt(params.minNetUsd, 2)} · buffer {fmt(params.bufferUsd, 2)} · max quote age {params.maxQuoteAgeMs}ms · fees {params.feesAssumed ? `ASSUMED (K ${params.krakenFeePct}% / CB ${params.coinbaseFeePct}%) — ${feeError ? `fee detection failed: ${feeError}` : "enter API keys to use your REAL tiers"}` : `YOUR REAL TIERS (K taker ${params.krakenFeePct}% / CB taker ${params.coinbaseFeePct}%${fees?.coinbaseMakerPct != null ? ` · CB maker ${fees.coinbaseMakerPct}%` : ""}, detected ${fees?.detectedAt ? new Date(fees.detectedAt).toLocaleTimeString() : "now"})`}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left" data-testid="table-2x-routes">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pr-2">Route</th>
                <th className="pr-2 text-right">Gross</th>
                <th className="pr-2 text-right">Fees</th>
                <th className="pr-2 text-right">Slip</th>
                <th className="pr-2 text-right">Net</th>
                <th className="pr-2">Decision</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r, i) => {
                const isBest = best && r.asset === best.asset && r.buyVenue === best.buyVenue;
                return (
                  <tr key={i} className={cn(isBest && "bg-muted/50 font-medium")} data-testid={`row-2x-${r.asset}-${r.buyVenue}`}>
                    <td className="pr-2 whitespace-nowrap">{r.asset} · {r.direction}{isBest ? " ★" : ""}</td>
                    <td className="pr-2 text-right">{fmt(r.grossSpreadUsd)}</td>
                    <td className="pr-2 text-right">{fmt(r.feesUsd)}</td>
                    <td className="pr-2 text-right">{fmt(r.slippageUsd)}</td>
                    <td className={cn("pr-2 text-right", (r.netProfitUsd ?? -1) > 0 ? "text-green-500" : "text-red-500")}>{fmt(r.netProfitUsd)}</td>
                    <td className="pr-2">
                      <span className={cn("font-semibold", r.decision === "FIRE" ? "text-green-500" : "text-muted-foreground")} title={r.reason ?? ""}>{r.decision}</span>
                    </td>
                    <td>
                      {r.decision === "FIRE" && (
                        <Button size="sm" className="h-6 px-2" disabled={running || !hasCreds || !liveMode} onClick={() => fire(r)} data-testid={`button-2x-fire-${r.asset}-${r.buyVenue}`}>
                          {running ? "…" : "Fire $10"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {routes.length === 0 && <tr><td colSpan={7} className="text-muted-foreground py-2">waiting for live books…</td></tr>}
            </tbody>
          </table>
        </div>
        {best && best.decision === "SKIP" && (
          <div className="text-muted-foreground" data-testid="text-2x-best-reason">
            Best route ({best.asset} {best.direction}, net {fmt(best.netProfitUsd)}) skipped: {best.reason}
          </div>
        )}
        {!liveMode && <div className="text-muted-foreground">LIVE mode is off — scanner shows decisions but cannot fire.</div>}
        {last && (
          <div className={cn("border rounded p-2 space-y-1", last.outcome === "completed" ? "border-green-500/40" : "border-red-500/40")} data-testid="text-2x-last">
            <div>last execution: <span className="font-semibold">{last.outcome}</span> — {last.reason}</div>
            {last.buyLeg && <div>buy [{last.buyLeg.venue}] {last.buyLeg.status} qty {last.buyLeg.filledQty ?? "?"} @ {last.buyLeg.avgPrice ?? "?"} fee {fmt(last.buyLeg.feeUsd)} · {last.buyLeg.latencyMs}ms · {last.buyLeg.orderId}</div>}
            {last.sellLeg && <div>sell [{last.sellLeg.venue}] {last.sellLeg.status} qty {last.sellLeg.filledQty ?? "?"} @ {last.sellLeg.avgPrice ?? "?"} fee {fmt(last.sellLeg.feeUsd)} · {last.sellLeg.latencyMs}ms · {last.sellLeg.orderId}</div>}
            {last.realizedProfitUsd != null && <div>realized: <span className={cn("font-semibold", last.realizedProfitUsd >= 0 ? "text-green-500" : "text-red-500")}>{fmt(last.realizedProfitUsd)}</span></div>}
          </div>
        )}
        <div data-testid="text-2x-stats">
          strategy realized P&L:{" "}
          <span className={cn("font-semibold", (stats.data?.cumulativeRealizedUsd ?? 0) >= 0 ? "text-green-500" : "text-red-500")}>
            {fmt(stats.data?.cumulativeRealizedUsd ?? 0, 4)}
          </span>{" "}
          across {stats.data?.completed ?? 0} completed / {stats.data?.trades ?? 0} total live cycles
          {(stats.data?.incomplete ?? 0) > 0 && <span className="text-amber-500"> · {stats.data?.incomplete} incomplete (no realized P&L)</span>}
        </div>
      </CardContent>
    </Card>
  );
}
