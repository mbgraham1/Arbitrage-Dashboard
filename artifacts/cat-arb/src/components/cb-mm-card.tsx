/**
 * MAKER-HEDGE ENGINE — the primary profit-seeking strategy card.
 *
 * Scans all liquid assets on both venues (both directions, both maker/hedge
 * structures) with the account's REAL detected fee tiers and actual balances.
 * A route reads RUN only when projected net (after maker fee, hedge taker
 * fee, executable depth, slippage) clears the configurable positive floor
 * (default $0.01) + safety buffer AND the hedge inventory exists.
 *
 * AUTO mode runs the same gate server-side every few seconds and fires one
 * hardened $10 Coinbase-maker cycle at a time. It stops itself on any
 * unhedged/indeterminate outcome. Trade size is never auto-scaled.
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import {
  useExecuteCbMm, useGetCbMmStats, getGetCbMmStatsQueryKey, CbMmExecuteResult,
  useMmScan, MmScanResult, MmScanRow,
  useMmAutoStart, useMmAutoStop, useMmAutoStatus, getMmAutoStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const fmt = (v: number | null | undefined, d = 4) => (v == null ? "—" : `$${v.toFixed(d)}`);

export function CbMmCard() {
  const { credentials, liveMode, addLog } = useBotContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [floorUsd, setFloorUsd] = useState("0.01");
  const [restWindowSec, setRestWindowSec] = useState("30");
  const [scan, setScan] = useState<MmScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [last, setLast] = useState<CbMmExecuteResult | null>(null);
  const [running, setRunning] = useState(false);
  const exec = useExecuteCbMm();
  const mmScan = useMmScan();
  const autoStart = useMmAutoStart();
  const autoStop = useMmAutoStop();
  const autoStatus = useMmAutoStatus({ query: { queryKey: getMmAutoStatusQueryKey(), refetchInterval: 5_000 } });
  const stats = useGetCbMmStats({ query: { queryKey: getGetCbMmStatsQueryKey(), refetchInterval: 15_000 } });

  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } = credentials;
  const hasCreds = !!krakenKey && !!krakenSecret && !!coinbaseKey && !!coinbaseSecret;
  const floorNum = Math.max(0.01, parseFloat(floorUsd) || 0.01);
  const scanBusy = useRef(false);

  // Poll the inventory-aware scan while creds are present.
  useEffect(() => {
    if (!hasCreds) { setScan(null); setScanError(null); return; }
    let cancelled = false;
    const tick = async () => {
      if (scanBusy.current) return;
      scanBusy.current = true;
      try {
        const r = await mmScan.mutateAsync({ data: { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, minNetUsd: floorNum } });
        if (!cancelled) { setScan(r); setScanError(null); }
      } catch (e) {
        if (!cancelled) setScanError((e as Error).message);
      } finally { scanBusy.current = false; }
    };
    tick();
    const iv = setInterval(tick, 4_000);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, floorNum]);

  const best = scan?.best ?? null;
  const runnable = (scan?.rows ?? []).filter(r => r.verdict === "RUN");
  const manualCandidate = runnable.find(r => r.autoExecutable) ?? null;
  const auto = autoStatus.data;
  const autoRunning = !!auto?.running;

  const run = async () => {
    if (!hasCreds || !liveMode || !manualCandidate) return;
    setRunning(true);
    addLog("info", `MM2: firing ${manualCandidate.asset} ${manualCandidate.direction} (projected ${fmt(manualCandidate.projectedNetUsd)})`);
    try {
      const r = await exec.mutateAsync({ data: {
        krakenKey, krakenSecret, coinbaseKey, coinbaseSecret,
        asset: manualCandidate.asset!, direction: manualCandidate.direction as "buy" | "sell",
        sizeUsd: 10, minNetUsd: floorNum,
        restWindowSec: Math.min(120, Math.max(5, parseFloat(restWindowSec) || 30)),
      } });
      setLast(r);
      addLog(r.outcome === "completed" ? "success" : r.outcome === "skipped" || r.outcome === "no_fill" ? "info" : "warning", `MM2 ${r.outcome}: ${r.reason}`);
      qc.invalidateQueries({ queryKey: getGetCbMmStatsQueryKey() });
      if (r.outcome === "unhedged" || r.outcome === "indeterminate") {
        toast({ title: `MM2 ${r.outcome} — attention required`, description: r.reason ?? "", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "MM2 execute failed", description: (e as Error).message, variant: "destructive" });
    } finally { setRunning(false); }
  };

  const toggleAuto = async () => {
    try {
      if (autoRunning) {
        await autoStop.mutateAsync();
        addLog("info", "MM2 AUTO stopped");
      } else {
        await autoStart.mutateAsync({ data: {
          krakenKey, krakenSecret, coinbaseKey, coinbaseSecret,
          minNetUsd: floorNum,
          restWindowSec: Math.min(120, Math.max(5, parseFloat(restWindowSec) || 30)),
        } });
        addLog("success", `MM2 AUTO started (floor $${floorNum.toFixed(2)}, $10 size)`);
      }
      qc.invalidateQueries({ queryKey: getMmAutoStatusQueryKey() });
    } catch (e) {
      toast({ title: autoRunning ? "AUTO stop failed" : "AUTO start failed", description: (e as Error).message, variant: "destructive" });
    }
  };

  const topRows = (scan?.rows ?? []).slice(0, 8);
  const rowLabel = (r: MmScanRow) =>
    r.structure === "takerKtoC" ? `${r.asset} · taker: buy K → sell CB`
      : r.structure === "takerCtoK" ? `${r.asset} · taker: buy CB → sell K`
        : `${r.asset} · ${r.structure === "cbMaker" ? "CB-maker→K-hedge" : "K-maker→CB-hedge"} · ${r.direction}`;

  const oppRows = (scan?.rows ?? []).filter(r => r.available).slice(0, 10);
  const anyFire = oppRows.some(r => r.fire === "FIRE");
  const fireColor = (f?: string) => f === "FIRE" ? "text-green-500 font-bold" : f === "WATCH" ? "text-amber-500" : "text-muted-foreground";

  return (
    <>
    <Card data-testid="card-top-opportunities" className="border-orange-500/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          <span className="text-orange-500">TOP REAL OPPORTUNITIES NOW</span>{" "}
          <span className="text-muted-foreground font-normal">
            (all liquid assets · both directions · maker-hedge AND taker-taker · real fees · executable depth · $10 size)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {!hasCreds && <div className="text-amber-500">Enter both exchanges' API keys — opportunities are ranked with YOUR real fee tiers and balances, not raw spreads.</div>}
        {hasCreds && scanError && <div className="text-red-500">Scan unavailable: {scanError}</div>}
        {hasCreds && scan && (
          <>
            <div className={cn("font-semibold", anyFire ? "text-green-500" : "text-muted-foreground")} data-testid="text-opps-headline">
              {anyFire
                ? `${oppRows.filter(r => r.fire === "FIRE").length} route(s) clear the full profitability gate RIGHT NOW.`
                : `No route is profitable right now after real fees + slippage — the engine will NOT force a losing trade. Best net is ${fmt(oppRows[0]?.projectedNetUsd)} (needs ≥ ${fmt(scan.requiredNetUsd, 2)}). AUTO keeps watching.`}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left whitespace-nowrap">
                <thead className="text-muted-foreground">
                  <tr><th>#</th><th>route</th><th className="text-right">gross edge</th><th className="text-right">fees</th><th className="text-right">slip</th><th className="text-right">proj. net</th><th>needs</th><th>verdict · why</th></tr>
                </thead>
                <tbody>
                  {oppRows.map((r, i) => (
                    <tr key={i} data-testid={`row-opp-${i}`}>
                      <td className="text-muted-foreground pr-1">{i + 1}</td>
                      <td className="pr-2">{rowLabel(r)}</td>
                      <td className="text-right pr-2">{fmt(r.grossEdgeUsd)}</td>
                      <td className="text-right pr-2 text-red-400">{fmt((r.makerFeeUsd ?? 0) + (r.hedgeFeeUsd ?? 0), 3)}</td>
                      <td className="text-right pr-2 text-red-400">{fmt(r.hedgeSlippageUsd, 3)}</td>
                      <td className={cn("text-right pr-2 font-semibold", (r.projectedNetUsd ?? 0) > 0 ? "text-green-500" : "text-red-500")}>{fmt(r.projectedNetUsd)}</td>
                      <td className={cn("pr-2", r.inventoryReady ? "" : "text-amber-500")} title={r.inventoryReason}>{r.requiredBalances}{r.inventoryReady ? " ✓" : " ✗"}</td>
                      <td className={fireColor(r.fire)} title={r.reason}>{r.fire} · <span className="font-normal text-muted-foreground">{r.reason}</span></td>
                    </tr>
                  ))}
                  {oppRows.length === 0 && <tr><td colSpan={8} className="text-muted-foreground">Books warming up — no projectable route yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="text-muted-foreground">
              Ranked by projected executable NET dollars (depth-walked, after your detected fees), not raw spread. Taker-taker rows are evaluation-only; if one ever reads FIRE, run it manually from Diagnostics. Rescans every 4s.
            </div>
          </>
        )}
      </CardContent>
    </Card>
    <Card data-testid="card-cb-mm" className="border-primary/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          <span className="text-primary">MAKER-HEDGE ENGINE</span>{" "}
          <span className="text-muted-foreground font-normal">
            (post-only maker · confirmed-fill hedge · $10 fixed · real fees · inventory-aware · {scan ? `${scan.rows?.length ?? 0}+ routes scanned` : "15 assets"})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {!hasCreds && <div className="text-amber-500" data-testid="text-mm2-nocreds">Enter Kraken AND Coinbase API keys to scan.</div>}
        {hasCreds && scanError && <div className="text-red-500" data-testid="text-mm2-scanerror">Scan failed: {scanError} — no assumed fees, no trading.</div>}
        {hasCreds && !scan && !scanError && <div className="text-muted-foreground">Detecting real fees, balances, and live books…</div>}

        {scan && (
          <>
            <div className="text-muted-foreground" data-testid="text-mm2-gate">
              Gate: net after ALL costs ≥ floor {fmt(scan.floorUsd, 2)} + buffer {fmt(scan.bufferUsd, 2)} with inventory on both legs.
              Real tiers: CB maker {scan.fees?.coinbaseMakerPct}% / taker {scan.fees?.coinbaseTakerPct}% · K maker {scan.fees?.krakenMakerPct ?? "—"}% / taker {scan.fees?.krakenTakerPct}%
              (detected {scan.fees?.detectedAt ? new Date(scan.fees.detectedAt).toLocaleTimeString() : "—"}).
              Balances: Kraken {fmt(scan.balances?.krakenUsd, 2)} · Coinbase {fmt(scan.balances?.coinbaseUsd, 2)}.
            </div>
            <div data-testid="text-mm2-best">
              Best projected route:{" "}
              {best ? (
                <>
                  <span className={cn("font-semibold", best.verdict === "RUN" ? "text-green-500" : "")}>{rowLabel(best)}</span>{" "}
                  net <span className={cn("font-semibold", (best.projectedNetUsd ?? 0) >= 0 ? "text-green-500" : "text-red-500")}>{fmt(best.projectedNetUsd)}</span>{" "}
                  (fees {fmt((best.makerFeeUsd ?? 0) + (best.hedgeFeeUsd ?? 0), 3)} · slip {fmt(best.hedgeSlippageUsd, 3)} ·{" "}
                  inventory {best.inventoryReady ? <span className="text-green-500">ready</span> : <span className="text-amber-500">{best.inventoryReason}</span>}) — {best.verdict === "RUN" ? "RUN ✓" : `WAIT: ${best.reason}`}
                </>
              ) : "no route projectable (books warming up)"}
            </div>
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr><th>route</th><th className="text-right">proj. net</th><th className="text-right">fees+slip</th><th>inventory</th><th className="text-right">verdict</th></tr>
              </thead>
              <tbody>
                {topRows.map((r, i) => (
                  <tr key={i} className={cn(r.verdict === "RUN" && "text-green-500 font-semibold")} data-testid={`row-mm2-scan-${i}`}>
                    <td>{rowLabel(r)}</td>
                    <td className={cn("text-right", (r.projectedNetUsd ?? 0) >= 0 ? "text-green-500" : "text-red-500")}>{fmt(r.projectedNetUsd)}</td>
                    <td className="text-right">{r.available ? fmt((r.makerFeeUsd ?? 0) + (r.hedgeFeeUsd ?? 0) + (r.hedgeSlippageUsd ?? 0), 3) : "—"}</td>
                    <td>{r.inventoryReady ? "✓" : <span className="text-amber-500" title={r.inventoryReason}>✗</span>}</td>
                    <td className="text-right">{r.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-muted-foreground">floor $ (min 0.01)</label>
          <input value={floorUsd} onChange={e => setFloorUsd(e.target.value)} className="bg-background border rounded px-2 py-1 w-16" data-testid="input-mm2-floor" />
          <label className="text-muted-foreground">rest (s)</label>
          <input value={restWindowSec} onChange={e => setRestWindowSec(e.target.value)} className="bg-background border rounded px-2 py-1 w-14" data-testid="input-mm2-rest" />
          <Button size="sm" variant={autoRunning ? "destructive" : "default"} disabled={!hasCreds || !liveMode || autoStart.isPending || autoStop.isPending} onClick={toggleAuto} data-testid="button-mm2-auto">
            {autoRunning ? "Stop AUTO" : "Start AUTO (watch & fire $10 cycles)"}
          </Button>
          <Button size="sm" variant="secondary" disabled={running || autoRunning || !hasCreds || !liveMode || !manualCandidate} onClick={run} data-testid="button-mm2-run">
            {running ? "resting…" : manualCandidate ? `Fire ${manualCandidate.asset} ${manualCandidate.direction} once` : "No route clears the gate"}
          </Button>
          {!liveMode && <span className="text-muted-foreground">LIVE mode off</span>}
        </div>

        {auto && (auto.running || auto.stopReason || (auto.events?.length ?? 0) > 0) && (
          <div className="border rounded p-2 space-y-1" data-testid="text-mm2-auto">
            <div>
              AUTO: <span className={cn("font-semibold", auto.running ? "text-green-500" : "text-muted-foreground")}>{auto.running ? "RUNNING" : "stopped"}</span>
              {auto.running && <> · scans {auto.ticks} · fires {auto.fires} · completed {auto.completed} · realized <span className={cn("font-semibold", (auto.realizedUsd ?? 0) >= 0 ? "text-green-500" : "text-red-500")}>{fmt(auto.realizedUsd)}</span></>}
              {!auto.running && auto.stopReason && <span className="text-amber-500"> — {auto.stopReason}</span>}
              {auto.reconcileLatch && <span className="text-red-500"> · LATCHED: {auto.reconcileLatch}</span>}
            </div>
            {(auto.events ?? []).slice(0, 4).map((e, i) => (
              <div key={i} className="text-muted-foreground">[{e.at ? new Date(e.at).toLocaleTimeString() : ""}] {e.kind}: {e.detail}</div>
            ))}
          </div>
        )}

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
    </>
  );
}
