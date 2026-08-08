/**
 * CROSS-VENUE SCANNER (Kraken · Coinbase · Gemini) — profitability-gated
 * inventory arbitrage across the three live venues.
 *
 * Read-first, honest UI: fees are marked DETECTED (your real tier) or ASSUMED
 * (labeled — connect keys), and a route is NEVER rendered as executable while
 * either leg's fee is assumed. Only FIRE routes expose an Execute button; every
 * other row's button is disabled with the server's verbatim SKIP reason as the
 * tooltip. Execute confirms asset/venues/size/net + the $10 cap, then renders
 * the outcome from CONFIRMED fills only. Indeterminate/unhedged outcomes are
 * loud red alerts that live runs are locked pending manual reconciliation.
 */
import { Fragment, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import {
  useXvScan, useXvExecute, useXvStats, getXvStatsQueryKey,
  XvScanResult, XvRoute, XvVenueStatus, XvProjection, XvExecuteResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const fmt = (v: number | null | undefined, d = 4) => (v == null ? "—" : `$${v.toFixed(d)}`);
const qty = (v: number | null | undefined, d = 6) => (v == null ? "—" : v.toFixed(d));

// The outcomes that mean an unhedged / unknown position — LOUD red alert.
const UNSAFE_OUTCOMES = new Set(["indeterminate", "unhedged"]);

function FeeBadge({ source, pct }: { source: string; pct: number }) {
  const detected = source === "detected";
  return (
    <span
      className={cn(
        "rounded px-1 py-0.5 font-semibold whitespace-nowrap",
        detected ? "bg-green-500/15 text-green-500" : "bg-amber-500/15 text-amber-500",
      )}
      title={detected
        ? `DETECTED — your real taker tier ${pct}%`
        : `ASSUMED ${pct}% — connect this venue's keys to verify; assumed fees can never fire a live trade`}
    >
      {detected ? `real ${pct}%` : `assumed ${pct}%`}
    </span>
  );
}

function VenueStatusRow({ v }: { v: XvVenueStatus }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap" data-testid={`xv-venue-${v.id}`}>
      <span className="font-medium capitalize">{v.id}</span>
      <FeeBadge source={v.feeSource} pct={v.takerPct} />
      {v.usd != null && <span className="text-muted-foreground">${v.usd.toFixed(2)} USD</span>}
      {v.id === "gemini" && (
        <span className={cn("rounded px-1 py-0.5", v.streaming ? "bg-green-500/15 text-green-500" : "bg-red-500/15 text-red-500")}
          title={v.streaming ? "Gemini live book stream connected" : "Gemini book stream DISCONNECTED"}>
          {v.streaming ? "● stream" : "○ stream"}
        </span>
      )}
      {v.error && <span className="text-red-500" title={v.error}>detect failed: {v.error}</span>}
    </div>
  );
}

/** Expandable near-miss / feasibility breakdown for one route. */
function RouteBreakdown({ r }: { r: XvRoute }) {
  const g = r.bestFeasible ?? r.best;
  return (
    <tr data-testid={`xv-breakdown-${r.asset}-${r.buyVenue}-${r.sellVenue}`}>
      <td colSpan={7} className="pb-2">
        <div className="rounded border border-border bg-muted/30 p-2 space-y-2">
          {g && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 md:grid-cols-3">
              <span className="text-muted-foreground">raw spread: <span className="text-foreground">{fmt(g.grossSpreadUsd, 4)}</span></span>
              <span className="text-muted-foreground">fees: <span className="text-foreground">{fmt(g.feesUsd, 4)}</span></span>
              <span className="text-muted-foreground">slippage: <span className="text-foreground">{fmt(g.slippageUsd, 4)}</span></span>
              <span className="text-muted-foreground">buffer: <span className="text-foreground">{fmt(g.bufferUsd, 4)}</span></span>
              <span className="text-muted-foreground">net: <span className={cn(g.netProfitUsd > 0 ? "text-green-500" : "text-red-500")}>{fmt(g.netProfitUsd, 4)}</span></span>
              <span className="text-muted-foreground">net after buffer: <span className={cn(g.netAfterBufferUsd > 0 ? "text-green-500" : "text-red-500")}>{fmt(g.netAfterBufferUsd, 4)}</span></span>
              <span className="text-muted-foreground">buy leg age: <span className="text-foreground">{g.buyAgeMs}ms</span></span>
              <span className="text-muted-foreground" title={r.sellVenue === "gemini" || r.buyVenue === "gemini" ? "Gemini leg age is measured from local arrival — no exchange timestamp on its feed" : undefined}>
                sell leg age: <span className="text-foreground">{g.sellAgeMs}ms</span>
              </span>
              <span className="text-muted-foreground">optimal feasible size: <span className="text-foreground">{r.bestFeasible ? `$${r.bestFeasible.sizeUsd}` : "none feasible"}</span></span>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <span className="text-muted-foreground">
              buy fee: <span className={r.feeSourceBuy === "detected" ? "text-green-500" : "text-amber-500"}>{r.feeSourceBuy} {r.buyTakerPct}%</span>
            </span>
            <span className="text-muted-foreground">
              sell fee: <span className={r.feeSourceSell === "detected" ? "text-green-500" : "text-amber-500"}>{r.feeSourceSell} {r.sellTakerPct}%</span>
            </span>
            {r.requiredBalances && (
              <span className="text-muted-foreground">
                requires: <span className="text-foreground">{fmt(r.requiredBalances.buyUsd, 2)} on {r.buyVenue}</span>
                {" + "}
                <span className="text-foreground">{qty(r.requiredBalances.sellAssetQty)} {r.asset} on {r.sellVenue}</span>
              </span>
            )}
            {r.minNotionalUsd != null && (
              <span className="text-muted-foreground">exchange min notional: <span className="text-foreground">{fmt(r.minNotionalUsd, 2)}</span></span>
            )}
            {r.balancesOk === false && <span className="text-amber-500">balances insufficient at every candidate size</span>}
            {r.balancesOk == null && <span className="text-muted-foreground">balances unverified (connect keys)</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pr-3">size</th>
                  <th className="pr-3 text-right">net</th>
                  <th className="pr-3 text-right">net a/buffer</th>
                  <th className="pr-3 text-right">base qty</th>
                  <th className="pr-3">feasible?</th>
                </tr>
              </thead>
              <tbody>
                {r.projections.map((p: XvProjection, i) => (
                  <tr key={i}>
                    <td className="pr-3">${p.sizeUsd}</td>
                    <td className={cn("pr-3 text-right", p.netProfitUsd > 0 ? "text-green-500" : "text-red-500")}>{fmt(p.netProfitUsd, 4)}</td>
                    <td className={cn("pr-3 text-right", p.netAfterBufferUsd > 0 ? "text-green-500" : "text-red-500")}>{fmt(p.netAfterBufferUsd, 4)}</td>
                    <td className="pr-3 text-right">{qty(p.baseQty)}</td>
                    <td className={cn("pr-3", p.feasible ? "text-green-500" : "text-muted-foreground")}>
                      {p.feasible ? "yes" : (p.infeasibleWhy ?? "no")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function CrossVenueScannerCard() {
  const { credentials, liveMode, addLog } = useBotContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, geminiKey, geminiSecret } = credentials;

  const [data, setData] = useState<XvScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<XvRoute | null>(null);
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<XvExecuteResult | null>(null);

  const scan = useXvScan();
  const exec = useXvExecute();
  const stats = useXvStats({ query: { queryKey: getXvStatsQueryKey(), refetchInterval: 15_000 } });

  // ALL saved venue creds are passed on every scan so DETECTED fees + balances
  // are used wherever keys exist; missing venues fall back to labeled ASSUMED.
  useEffect(() => {
    let cancelled = false;
    const creds = {
      ...(krakenKey && krakenSecret ? { krakenKey, krakenSecret } : {}),
      ...(coinbaseKey && coinbaseSecret ? { coinbaseKey, coinbaseSecret } : {}),
      ...(geminiKey && geminiSecret ? { geminiKey, geminiSecret } : {}),
    };
    const tick = async () => {
      try {
        const r = await scan.mutateAsync({ data: creds });
        if (!cancelled) { setData(r); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    tick();
    const iv = setInterval(tick, 5_000);
    return () => { cancelled = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, geminiKey, geminiSecret]);

  const routes = data?.routes ?? [];
  const params = data?.params;

  const doExecute = async (r: XvRoute) => {
    setConfirm(null);
    if (!liveMode) { toast({ title: "LIVE mode is off", description: "Enable LIVE to fire cross-venue trades." }); return; }
    setRunning(true);
    addLog("info", `XV: firing ${r.asset} ${r.buyVenue}→${r.sellVenue} (feasible net ${fmt(r.bestFeasible?.netAfterBufferUsd)})`);
    try {
      const out = await exec.mutateAsync({ data: {
        ...(krakenKey && krakenSecret ? { krakenKey, krakenSecret } : {}),
        ...(coinbaseKey && coinbaseSecret ? { coinbaseKey, coinbaseSecret } : {}),
        ...(geminiKey && geminiSecret ? { geminiKey, geminiSecret } : {}),
        asset: r.asset,
        buyVenue: r.buyVenue as "kraken" | "coinbase" | "gemini",
        sellVenue: r.sellVenue as "kraken" | "coinbase" | "gemini",
        sizeUsd: r.bestFeasible?.sizeUsd ?? 10,
      } });
      setLast(out);
      addLog(out.outcome === "completed" ? "success" : "warning", `XV ${out.outcome}: ${out.reason}`);
      qc.invalidateQueries({ queryKey: getXvStatsQueryKey() });
      if (UNSAFE_OUTCOMES.has(out.outcome)) {
        toast({ title: `XV ${out.outcome.toUpperCase()} — live runs locked`, description: out.reason, variant: "destructive" });
      } else if (out.outcome !== "completed" && out.outcome !== "skipped") {
        toast({ title: `XV ${out.outcome}`, description: out.reason, variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "XV execute failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card data-testid="card-xv-scanner" className="mt-6 border-violet-500/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          <span className="text-violet-400">Cross-Venue Scanner</span>{" "}
          <span className="text-muted-foreground font-normal">
            (Kraken · Coinbase · Gemini · every venue pair × USD asset · $10 hard cap · fires only on DETECTED fees + verified balances · rescans 5s)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {error && <div className="text-red-500" data-testid="text-xv-error">Cross-venue scan failed: {error}</div>}
        {!data && !error && <div className="text-muted-foreground">Scanning live books across Kraken, Coinbase, Gemini…</div>}

        {/* Venue status row */}
        {data && (
          <div className="flex flex-wrap gap-x-6 gap-y-1" data-testid="row-xv-venues">
            {data.venues.map(v => <VenueStatusRow key={v.id} v={v} />)}
          </div>
        )}

        {params && (
          <div className="text-muted-foreground" data-testid="text-xv-params">
            floor {fmt(params.minNetUsd, 2)} · max quote age {params.maxQuoteAgeMs}ms · exec cap {fmt(params.execCapUsd, 0)} · sizes {params.candidateSizes?.map(s => `$${s}`).join("/")}
            {" · "}<span className="text-violet-300">{data?.fireCount ?? 0} FIRE</span>
          </div>
        )}

        {/* Stats strip */}
        <div data-testid="text-xv-stats">
          strategy realized P&amp;L:{" "}
          <span className={cn("font-semibold", (stats.data?.cumulativeRealizedUsd ?? 0) >= 0 ? "text-green-500" : "text-red-500")}>
            {fmt(stats.data?.cumulativeRealizedUsd ?? 0, 4)}
          </span>{" "}
          across {stats.data?.completed ?? 0} completed / {stats.data?.trades ?? 0} total live cycles
          {(stats.data?.incomplete ?? 0) > 0 && <span className="text-amber-500"> · {stats.data?.incomplete} incomplete (no realized P&amp;L)</span>}
        </div>

        {!liveMode && <div className="text-muted-foreground">LIVE mode is off — scanner shows decisions but cannot fire.</div>}

        {/* Route table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left" data-testid="table-xv-routes">
            <thead className="text-muted-foreground">
              <tr>
                <th className="pr-2">Asset</th>
                <th className="pr-2">Direction</th>
                <th className="pr-2">Fees</th>
                <th className="pr-2 text-right">Net a/buffer</th>
                <th className="pr-2">Decision</th>
                <th className="pr-2"></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {routes.slice(0, 15).map((r) => {
                const key = `${r.asset}-${r.buyVenue}-${r.sellVenue}`;
                const isFire = r.decision === "FIRE";
                const g = r.bestFeasible ?? r.best;
                const isOpen = expanded === key;
                return (
                  <Fragment key={key}>
                    <tr data-testid={`row-xv-${key}`} className={cn(isFire && "bg-violet-500/5")}>
                      <td className="pr-2 whitespace-nowrap">
                        {r.asset}
                        {r.stable && <span className="ml-1 rounded bg-cyan-500/15 px-1 py-0.5 text-cyan-400 font-semibold" title="USDC stablecoin rotation — near-zero volatility">STABLE</span>}
                      </td>
                      <td className="pr-2 whitespace-nowrap">
                        <span className="capitalize">{r.buyVenue}</span> → <span className="capitalize">{r.sellVenue}</span>
                      </td>
                      <td className="pr-2 whitespace-nowrap">
                        <FeeBadge source={r.feeSourceBuy} pct={r.buyTakerPct} />
                        {" / "}
                        <FeeBadge source={r.feeSourceSell} pct={r.sellTakerPct} />
                      </td>
                      <td className={cn("pr-2 text-right", isFire ? "text-green-500 font-semibold" : (g?.netAfterBufferUsd ?? -1) > 0 ? "text-amber-500" : "text-muted-foreground")}>
                        {fmt(g?.netAfterBufferUsd)}
                        {!isFire && (g?.netAfterBufferUsd ?? -1) > 0 && <span className="ml-1 text-muted-foreground" title="positive projection but NOT executable — see reason">(not executable)</span>}
                      </td>
                      <td className="pr-2">
                        <span className={cn("rounded px-1.5 py-0.5 font-semibold", isFire ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground")} title={r.reason}>
                          {r.decision}
                        </span>
                      </td>
                      <td className="pr-2">
                        <button className="text-violet-300 underline-offset-2 hover:underline" onClick={() => setExpanded(isOpen ? null : key)} data-testid={`button-xv-expand-${key}`}>
                          {isOpen ? "hide" : "near-miss"}
                        </button>
                      </td>
                      <td>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button
                                  size="sm"
                                  className="h-6 px-2"
                                  disabled={!isFire || running || !liveMode}
                                  onClick={() => setConfirm(r)}
                                  data-testid={`button-xv-fire-${key}`}
                                >
                                  {running && confirm == null ? "…" : `Execute $${g?.sizeUsd ?? 10}`}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[380px]">
                              {isFire
                                ? (liveMode ? "Executes one $10-capped cycle on CURRENT books with detected fees." : "Enable LIVE mode to fire.")
                                : r.reason}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </td>
                    </tr>
                    {isOpen && <RouteBreakdown r={r} />}
                  </Fragment>
                );
              })}
              {routes.length === 0 && data && <tr><td colSpan={7} className="text-muted-foreground py-2">no routes — waiting for live books…</td></tr>}
            </tbody>
          </table>
        </div>

        {data?.note && <div className="text-muted-foreground">{data.note}</div>}

        {/* Last execution outcome */}
        {last && (
          <div
            className={cn(
              "border rounded p-2 space-y-1",
              UNSAFE_OUTCOMES.has(last.outcome) ? "border-red-500 bg-red-500/10"
                : last.outcome === "completed" ? "border-green-500/40" : "border-amber-500/40",
            )}
            data-testid="text-xv-last"
          >
            {UNSAFE_OUTCOMES.has(last.outcome) && (
              <div className="font-bold text-red-500" data-testid="text-xv-reconcile-alert">
                ⚠ {last.outcome.toUpperCase()} — LIVE RUNS ARE LOCKED pending manual reconciliation. Verify the position on the exchange, then restart the server.
              </div>
            )}
            <div>last execution: <span className="font-semibold">{last.outcome}</span> — {last.reason}</div>
            {last.buyLeg && (
              <div>buy [{last.buyLeg.venue}] {last.buyLeg.status} · confirmed {qty(last.buyLeg.filledQty, 8)} @ {last.buyLeg.avgPrice ?? "?"} · fee {fmt(last.buyLeg.feeUsd)} · {last.buyLeg.latencyMs}ms · {last.buyLeg.orderId ?? "no id"}</div>
            )}
            {last.sellLeg && (
              <div>sell [{last.sellLeg.venue}] {last.sellLeg.status} · confirmed {qty(last.sellLeg.filledQty, 8)} @ {last.sellLeg.avgPrice ?? "?"} · fee {fmt(last.sellLeg.feeUsd)} · {last.sellLeg.latencyMs}ms · {last.sellLeg.orderId ?? "no id"}</div>
            )}
            <div>
              realized P&amp;L:{" "}
              {last.realizedProfitUsd != null
                ? <span className={cn("font-semibold", last.realizedProfitUsd >= 0 ? "text-green-500" : "text-red-500")}>{fmt(last.realizedProfitUsd)}</span>
                : <span className="text-muted-foreground">— (not fully hedged / indeterminate — no realized P&amp;L)</span>}
            </div>
            {last.geminiFeeNote && <div className="text-muted-foreground">{last.geminiFeeNote}</div>}
          </div>
        )}
      </CardContent>

      {/* Confirm dialog */}
      <Dialog open={confirm != null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent data-testid="dialog-xv-confirm">
          <DialogHeader>
            <DialogTitle>Confirm cross-venue execution</DialogTitle>
            <DialogDescription>
              This places ONE live cycle, capped at $10, on current books with your detected fees.
            </DialogDescription>
          </DialogHeader>
          {confirm && (
            <div className="text-sm space-y-1">
              <div>Asset: <span className="font-semibold">{confirm.asset}{confirm.stable ? " (STABLE)" : ""}</span></div>
              <div>Route: <span className="font-semibold capitalize">{confirm.buyVenue} → {confirm.sellVenue}</span></div>
              <div>Size: <span className="font-semibold">${confirm.bestFeasible?.sizeUsd ?? 10}</span> <span className="text-muted-foreground">(hard cap $10)</span></div>
              <div>Projected net after buffer: <span className={cn("font-semibold", (confirm.bestFeasible?.netAfterBufferUsd ?? 0) >= 0 ? "text-green-500" : "text-red-500")}>{fmt(confirm.bestFeasible?.netAfterBufferUsd)}</span></div>
              <div className="text-muted-foreground">{confirm.reason}</div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} data-testid="button-xv-confirm-cancel">Cancel</Button>
            <Button onClick={() => confirm && doExecute(confirm)} disabled={running} data-testid="button-xv-confirm-fire">
              {running ? "Executing…" : "Execute now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
