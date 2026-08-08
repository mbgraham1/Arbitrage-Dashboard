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
  useXvAutoStart, useXvAutoStop, useXvAutoStatus, getXvAutoStatusQueryKey,
  useXvPlan,
  XvScanResult, XvRoute, XvVenueStatus, XvProjection, XvExecuteResult,
  XvAutoStatus, XvAutoStartError, XvAutoVenueVerify, XvAutoLogEntry,
  XvPlan, XvPlanRoute, XvPlanRequirement, XvPlanFundingVenue,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const fmt = (v: number | null | undefined, d = 4) => (v == null ? "—" : `$${v.toFixed(d)}`);

/** Colour a plain-English blocker/READY label. */
function blockerClasses(blocker: string): string {
  const b = blocker.toUpperCase();
  if (b.startsWith("READY")) return "bg-green-500/15 text-green-500";
  if (b.startsWith("STALE") || b.includes("UNVERIFIED") || b.startsWith("NEED") || b.includes("NEGATIVE")) return "bg-red-500/15 text-red-500";
  if (b.includes("ASSUMED") || b.includes("FLOOR") || b.includes("BELOW") || b.includes("MINIMUM")) return "bg-amber-500/15 text-amber-500";
  return "bg-muted text-muted-foreground";
}

function BlockerBadge({ blocker }: { blocker: string }) {
  return (
    <span
      className={cn("rounded px-1.5 py-0.5 font-mono font-semibold uppercase tracking-tight whitespace-nowrap", blockerClasses(blocker))}
      data-testid="badge-xv-blocker"
      title={blocker}
    >
      {blocker}
    </span>
  );
}
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
  const [showErr, setShowErr] = useState(false);
  // NEVER render $0.00 USD for a venue whose detection errored — the balance is
  // UNVERIFIED, not a real zero (Gemini scope issues are the common case).
  const balanceUnverified = v.error != null;
  return (
    <div className="flex flex-col gap-0.5" data-testid={`xv-venue-${v.id}`}>
      <div className="flex items-center gap-2 whitespace-nowrap">
        <span className="font-medium capitalize">{v.id}</span>
        <FeeBadge source={v.feeSource} pct={v.takerPct} />
        {balanceUnverified
          ? <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-500 font-semibold" title="balance could not be verified — not a real $0.00">UNVERIFIED</span>
          : v.usd != null && <span className="text-muted-foreground">${v.usd.toFixed(2)} USD</span>}
        {v.id === "gemini" && (
          <span className={cn("rounded px-1 py-0.5", v.streaming ? "bg-green-500/15 text-green-500" : "bg-red-500/15 text-red-500")}
            title={v.streaming ? "Gemini live book stream connected" : "Gemini book stream DISCONNECTED"}>
            {v.streaming ? "● stream" : "○ stream"}
          </span>
        )}
        {v.error && (
          <button
            className="flex items-center gap-1 text-red-500"
            onClick={() => setShowErr(s => !s)}
            title={v.error}
            data-testid={`button-xv-venue-error-${v.id}`}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="max-w-[220px] truncate">{v.error}</span>
          </button>
        )}
      </div>
      {v.error && showErr && (
        <div className="text-red-400 whitespace-pre-wrap pl-1" data-testid={`text-xv-venue-error-${v.id}`}>{v.error}</div>
      )}
    </div>
  );
}

/** Expandable near-miss / feasibility breakdown for one route. */
function RouteBreakdown({ r }: { r: XvRoute }) {
  const g = r.bestFeasible ?? r.best;
  return (
    <tr data-testid={`xv-breakdown-${r.asset}-${r.buyVenue}-${r.sellVenue}`}>
      <td colSpan={8} className="pb-2">
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

/** Collapsible viewer of the auto-executor's decision log (newest first). */
function DecisionLog({ log }: { log: XvAutoLogEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="xv-auto-log">
      <button className="text-violet-300 underline-offset-2 hover:underline" onClick={() => setOpen(o => !o)} data-testid="button-xv-auto-log-toggle">
        {open ? "hide" : "show"} decision log ({log.length})
      </button>
      {open && (
        <div className="overflow-x-auto mt-1">
          {log.length === 0 ? (
            <div className="text-muted-foreground">no decisions logged yet — the log records near-positives and fires only.</div>
          ) : (
            <table className="w-full text-left whitespace-nowrap">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pr-3">time</th><th className="pr-3">asset</th><th className="pr-3">route</th>
                  <th className="pr-3 text-right">size</th><th className="pr-3 text-right">buy age</th><th className="pr-3 text-right">sell age</th>
                  <th className="pr-3">fees</th><th className="pr-3 text-right">scanner net</th><th className="pr-3 text-right">exec net</th>
                  <th className="pr-3 text-right">floor</th><th className="pr-3">decision</th><th className="pr-3">outcome</th>
                  <th className="pr-3 text-right">realized</th><th>reason</th>
                </tr>
              </thead>
              <tbody>
                {log.map((e, i) => (
                  <tr key={i} data-testid={`row-xv-auto-log-${i}`}>
                    <td className="pr-3">{new Date(e.at).toLocaleTimeString()}</td>
                    <td className="pr-3">{e.asset}</td>
                    <td className="pr-3 capitalize">{e.buyVenue}→{e.sellVenue}</td>
                    <td className="pr-3 text-right">${e.sizeUsd}</td>
                    <td className="pr-3 text-right">{e.buyAgeMs}ms</td>
                    <td className="pr-3 text-right">{e.sellAgeMs}ms</td>
                    <td className="pr-3">
                      <span className={e.feeSourceBuy === "detected" ? "text-green-500" : "text-amber-500"}>{e.feeSourceBuy}</span>/
                      <span className={e.feeSourceSell === "detected" ? "text-green-500" : "text-amber-500"}>{e.feeSourceSell}</span>
                    </td>
                    <td className={cn("pr-3 text-right", e.scannerNetUsd > 0 ? "text-green-500" : "text-red-500")}>{fmt(e.scannerNetUsd, 4)}</td>
                    <td className={cn("pr-3 text-right", e.executableNetUsd > 0 ? "text-green-500" : "text-red-500")}>{fmt(e.executableNetUsd, 4)}</td>
                    <td className="pr-3 text-right">{fmt(e.floorUsd, 2)}</td>
                    <td className={cn("pr-3 font-semibold", e.decision === "FIRE" ? "text-green-500" : "text-muted-foreground")}>{e.decision}</td>
                    <td className={cn("pr-3", UNSAFE_OUTCOMES.has(e.outcome ?? "") ? "text-red-500 font-semibold" : "text-muted-foreground")}>{e.outcome ?? "—"}</td>
                    <td className={cn("pr-3 text-right", e.realizedUsd == null ? "text-muted-foreground" : e.realizedUsd >= 0 ? "text-green-500" : "text-red-500")}>{e.realizedUsd == null ? "—" : fmt(e.realizedUsd, 4)}</td>
                    <td className="text-muted-foreground max-w-[420px] truncate" title={e.reason}>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Auto-Execute engine controls + status. Uses the SAME saved creds the scanner
 * uses and arms with the CURRENT scanner floor. Auto never transfers assets
 * between exchanges and cannot loosen freshness past the 200ms hard gate; it
 * runs the identical hard guards as manual Execute.
 */
function AutoExecutePanel({ floorUsd }: { floorUsd: number | null | undefined }) {
  const { credentials } = useBotContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, geminiKey, geminiSecret } = credentials;
  const [busy, setBusy] = useState(false);
  const [venueWhy, setVenueWhy] = useState<XvAutoVenueVerify[] | null>(null);

  const status = useXvAutoStatus({ query: { queryKey: getXvAutoStatusQueryKey(), refetchInterval: 3_000 } });
  const start = useXvAutoStart();
  const stop = useXvAutoStop();
  const st: XvAutoStatus | undefined = status.data;
  const armed = st?.armed ?? false;

  const savedCreds = () => ({
    ...(krakenKey && krakenSecret ? { krakenKey, krakenSecret } : {}),
    ...(coinbaseKey && coinbaseSecret ? { coinbaseKey, coinbaseSecret } : {}),
    ...(geminiKey && geminiSecret ? { geminiKey, geminiSecret } : {}),
  });

  const arm = async () => {
    setBusy(true);
    setVenueWhy(null);
    try {
      await start.mutateAsync({ data: { ...savedCreds(), ...(floorUsd != null ? { minNetUsd: floorUsd } : {}) } });
      qc.invalidateQueries({ queryKey: getXvAutoStatusQueryKey() });
      toast({ title: "Auto-Execute armed", description: "Event-driven — fires only when every hard guard passes." });
    } catch (e) {
      // 400 → per-venue verification reasons; show them verbatim.
      const body = (e as { data?: XvAutoStartError }).data;
      if (body?.venues) { setVenueWhy(body.venues); toast({ title: "Cannot arm", description: body.error, variant: "destructive" }); }
      else toast({ title: "Cannot arm auto-execute", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const disarm = async () => {
    setBusy(true);
    try {
      await stop.mutateAsync();
      qc.invalidateQueries({ queryKey: getXvAutoStatusQueryKey() });
      toast({ title: "Auto-Execute disarmed", description: "Keys wiped from memory." });
    } catch (e) {
      toast({ title: "Stop failed", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded border border-violet-500/40 p-2 space-y-2" data-testid="xv-auto-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-violet-300">Auto-Execute</span>
        <span className={cn("rounded px-1.5 py-0.5 font-semibold", armed ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground")}>
          {armed ? "ARMED" : "DISARMED"}
        </span>
        {armed
          ? <Button size="sm" variant="destructive" className="h-6 px-3 font-bold" disabled={busy} onClick={disarm} data-testid="button-xv-auto-stop">{busy ? "…" : "STOP"}</Button>
          : <Button size="sm" className="h-6 px-3" disabled={busy} onClick={arm} data-testid="button-xv-auto-start">{busy ? "…" : "Arm auto-execute"}</Button>}
        {st?.startedAt && armed && <span className="text-muted-foreground">since {new Date(st.startedAt).toLocaleTimeString()}</span>}
      </div>

      <div className="text-muted-foreground">
        Arms with your saved keys + the current floor {fmt(floorUsd, 2)}. Event-driven: every book tick re-checks the affected asset and fires the SAME execution core with the SAME hard guards as manual Execute (auto is not an override). Auto NEVER transfers assets between exchanges. Freshness and floor can only be tightened — never loosened past the 200ms hard gate.
      </div>

      {/* Live-runs reconcile lock — loud red. */}
      {st?.liveNeedsReconcile && (
        <div className="border border-red-500 bg-red-500/10 rounded p-2 font-bold text-red-500" data-testid="text-xv-auto-reconcile">
          ⚠ LIVE RUNS LOCKED — {st.liveNeedsReconcile}. Verify on the exchange, then restart the server.
        </div>
      )}
      {/* Engine self-pause — loud red. */}
      {st?.pausedReason && (
        <div className="border border-red-500 bg-red-500/10 rounded p-2 font-bold text-red-500" data-testid="text-xv-auto-paused">
          ⚠ AUTO-EXECUTE PAUSED — {st.pausedReason}
        </div>
      )}

      {/* Per-venue verification failure (400 on arm) — verbatim reasons. */}
      {venueWhy && (
        <div className="border border-amber-500/60 bg-amber-500/10 rounded p-2 space-y-1" data-testid="text-xv-auto-venue-why">
          <div className="text-amber-500 font-semibold flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> Need ≥2 fully-verified venues to arm:</div>
          {venueWhy.map(v => (
            <div key={v.id}>
              <span className="capitalize font-medium">{v.id}</span>:{" "}
              {v.verified ? <span className="text-green-500">verified</span> : <span className="text-amber-400">{v.why ?? "not verified"}</span>}
            </div>
          ))}
        </div>
      )}

      {armed && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground" data-testid="text-xv-auto-counters">
          <span>verified venues: <span className="text-green-500 capitalize">{(st?.verifiedVenues ?? []).join(", ") || "—"}</span></span>
          <span>floor: {fmt(st?.minNetUsd, 2)}</span>
          <span>max quote age: {st?.maxQuoteAgeMs ?? "—"}ms</span>
          <span>evals: {st?.evals ?? 0}</span>
          <span>fires: <span className={cn((st?.fires ?? 0) > 0 && "text-green-500 font-semibold")}>{st?.fires ?? 0}</span></span>
          <span>last fire: {st?.lastFireAt ? new Date(st.lastFireAt).toLocaleTimeString() : "—"}</span>
        </div>
      )}

      <DecisionLog log={st?.log ?? []} />
    </div>
  );
}

/** Format a base-asset quantity compactly (large qtys as locale ints). */
const qtyLabel = (v: number, asset: string) =>
  `${v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(6)} ${asset}`;

/** READY / SHORT / UNVERIFIED chip with the honest UNVERIFIED copy. */
function StatusChip({ status, shortBy, unit }: { status: string; shortBy?: number | null; unit?: string }) {
  if (status === "READY")
    return <span className="rounded px-1.5 py-0.5 font-semibold bg-green-500/15 text-green-500" data-testid="chip-plan-ready">READY</span>;
  if (status === "SHORT")
    return (
      <span className="rounded px-1.5 py-0.5 font-semibold bg-red-500/15 text-red-500" data-testid="chip-plan-short">
        SHORT{shortBy != null ? ` — short by ${unit === "USD" ? `$${shortBy.toFixed(2)}` : (unit ? qtyLabel(shortBy, unit) : shortBy.toFixed(6))}` : ""}
      </span>
    );
  return (
    <span className="rounded px-1.5 py-0.5 font-semibold bg-amber-500/15 text-amber-500" title="balance unverified — connect/fix keys, never assumed" data-testid="chip-plan-unverified">
      UNVERIFIED
    </span>
  );
}

/** One requirement row inside a planned route. */
function RequirementRow({ req }: { req: XvPlanRequirement }) {
  const isQuote = req.kind === "quote";
  const unit = isQuote ? "USD" : req.asset;
  const required = isQuote ? `$${req.requiredAmount.toFixed(2)}` : `${qtyLabel(req.requiredAmount, req.asset)} (~$${req.requiredUsdValue.toFixed(2)})`;
  const have = req.haveAmount == null ? "UNVERIFIED" : isQuote ? `$${req.haveAmount.toFixed(2)}` : qtyLabel(req.haveAmount, req.asset);
  return (
    <tr data-testid={`row-plan-req-${req.venue}-${req.asset}`}>
      <td className="pr-3 capitalize">{req.venue}</td>
      <td className="pr-3">{req.asset}</td>
      <td className="pr-3">{required}</td>
      <td className={cn("pr-3", req.haveAmount == null && "text-amber-500")}>{have}</td>
      <td><StatusChip status={req.status} shortBy={req.shortBy} unit={unit} /></td>
    </tr>
  );
}

/**
 * INVENTORY PLANNER — for every positive-net route, exactly what to fund WHERE
 * before execution (assets are never transferred during a trade). Balances are
 * only ever READY / SHORT by an exact amount / UNVERIFIED — never assumed.
 */
function InventoryPlanner({ savedCreds, floorUsd }: { savedCreds: () => Record<string, string>; floorUsd: number | null | undefined }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<XvPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const planM = useXvPlan();

  // Refetch every 15s only while the section is expanded.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const params = floorUsd != null ? { minNetUsd: floorUsd } : undefined;
    const tick = async () => {
      try {
        const r = await planM.mutateAsync({ data: savedCreds(), params });
        if (!cancelled) { setPlan(r); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, floorUsd]);

  const fundingVenues: Array<[string, XvPlanFundingVenue]> = plan
    ? (Object.entries(plan.funding) as Array<[string, XvPlanFundingVenue]>).filter(([, f]) => f.usdNeeded > 0 || f.assets.length > 0)
    : [];

  return (
    <div className="rounded border border-violet-500/40 p-2 space-y-2" data-testid="xv-planner">
      <button className="font-semibold text-violet-300 underline-offset-2 hover:underline" onClick={() => setOpen(o => !o)} data-testid="button-xv-planner-toggle">
        {open ? "▾" : "▸"} Inventory Planner — what to fund where
      </button>

      {open && (
        <div className="space-y-3">
          {error && <div className="text-red-500" data-testid="text-xv-planner-error">Planner failed: {error}</div>}
          {!plan && !error && <div className="text-muted-foreground">Computing funding requirements on current books…</div>}

          {plan && plan.routes.length === 0 && (
            <div className="text-muted-foreground" data-testid="text-xv-planner-empty">
              No positive-net routes right now — nothing worth pre-positioning.
            </div>
          )}

          {plan && plan.routes.length > 0 && (
            <>
              {/* Per positive route + its two requirements. */}
              <div className="space-y-2">
                {plan.routes.map((r: XvPlanRoute) => {
                  const key = `${r.asset}-${r.buyVenue}-${r.sellVenue}`;
                  return (
                    <div key={key} className="rounded bg-muted/30 p-2 space-y-1" data-testid={`plan-route-${key}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.asset}</span>
                        <span className="capitalize text-muted-foreground">{r.buyVenue} → {r.sellVenue}</span>
                        <span>${r.sizeUsd.toFixed(0)}</span>
                        <span className={cn("font-semibold", r.netAfterBufferUsd >= 0 ? "text-green-500" : "text-red-500")}>net {fmt(r.netAfterBufferUsd)}</span>
                        {r.blocker && <BlockerBadge blocker={r.blocker} />}
                      </div>
                      <table className="w-full text-left">
                        <thead className="text-muted-foreground">
                          <tr><th className="pr-3">venue</th><th className="pr-3">asset</th><th className="pr-3">required</th><th className="pr-3">have</th><th>status</th></tr>
                        </thead>
                        <tbody>
                          {r.requirements.map((req, i) => <RequirementRow key={i} req={req} />)}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>

              {/* Consolidated "what to fund where" per venue. */}
              {fundingVenues.length > 0 && (
                <div className="space-y-2">
                  <div className="font-semibold text-violet-300">What to fund where</div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {fundingVenues.map(([venue, f]) => (
                      <div key={venue} className="rounded border border-border p-2 space-y-1" data-testid={`plan-fund-${venue}`}>
                        <div className="font-medium capitalize">{venue}</div>
                        {f.usdNeeded > 0 && (
                          <div>
                            USD needed <span className="font-semibold">${f.usdNeeded.toFixed(2)}</span>{" "}
                            <span className="text-muted-foreground">
                              (have {f.usdHave == null ? <span className="text-amber-500">UNVERIFIED</span> : `$${f.usdHave.toFixed(2)}`})
                            </span>
                          </div>
                        )}
                        {f.assets.map((a) => (
                          <div key={a.asset} data-testid={`plan-fund-${venue}-${a.asset}`}>
                            <span className="font-semibold">{qtyLabel(a.qtyNeeded, a.asset)}</span> <span className="text-muted-foreground">(~${a.usdValue.toFixed(2)})</span>{" — "}
                            {a.have == null ? <span className="text-amber-500">UNVERIFIED</span> : <>have {qtyLabel(a.have, a.asset)}</>}
                            {a.status === "SHORT" && a.shortBy != null && <span className="text-red-500">, short by {qtyLabel(a.shortBy, a.asset)}</span>}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {plan && (
            <div className="text-muted-foreground text-[11px] leading-snug" data-testid="text-xv-planner-note">
              planned {new Date(plan.plannedAt).toLocaleTimeString()} · floor {fmt(plan.minNetUsd, 2)}. {plan.note}
            </div>
          )}
        </div>
      )}
    </div>
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

  // Same saved creds the scanner uses — shared with the inventory planner.
  const savedCreds = () => ({
    ...(krakenKey && krakenSecret ? { krakenKey, krakenSecret } : {}),
    ...(coinbaseKey && coinbaseSecret ? { coinbaseKey, coinbaseSecret } : {}),
    ...(geminiKey && geminiSecret ? { geminiKey, geminiSecret } : {}),
  });

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

        {/* Auto-Execute engine */}
        <AutoExecutePanel floorUsd={params?.minNetUsd} />

        <div className="text-muted-foreground">
          Manual EXECUTE obeys the EXACT same hard guards as auto (detected fees on both legs, fresh books ≤200ms, verified balances, positive net after buffer) — it is not an override.
        </div>

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
                <th className="pr-2">Blocker</th>
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
                      <td className={cn("pr-2 text-right", isFire ? "text-green-500 font-semibold" : (g?.netAfterBufferUsd ?? -1) > 0 ? "text-amber-500" : "text-muted-foreground")}
                          title="Canonical executable net: raw spread − verified fees − depth/slippage − safety buffer (fill-risk allowance). All-USD taker routes: transfer/basis cost is $0 by design — no transfers ever.">
                        {fmt(g?.netAfterBufferUsd)}
                      </td>
                      <td className="pr-2">
                        <span
                          className={cn("rounded px-1.5 py-0.5 font-semibold",
                            isFire ? "bg-green-500/15 text-green-500"
                            : (g?.netAfterBufferUsd ?? -1) > 0 ? "bg-red-500/15 text-red-400"
                            : "bg-muted text-muted-foreground")}
                          title={r.reason}
                        >
                          {isFire ? "FIRE" : (g?.netAfterBufferUsd ?? -1) > 0 ? "BLOCKED" : "SKIP"}
                        </span>
                      </td>
                      <td className="pr-2">
                        {r.blocker && <BlockerBadge blocker={r.blocker} />}
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
                                {isFire ? (
                                  <Button
                                    size="sm"
                                    className="h-6 px-2"
                                    disabled={running || !liveMode}
                                    onClick={() => setConfirm(r)}
                                    data-testid={`button-xv-fire-${key}`}
                                  >
                                    {running && confirm == null ? "…" : `Execute $${g?.sizeUsd ?? 10}`}
                                  </Button>
                                ) : (
                                  <span
                                    className="inline-flex h-6 cursor-not-allowed items-center rounded border border-red-500/30 bg-red-500/10 px-2 font-semibold text-red-400"
                                    data-testid={`blocked-xv-${key}`}
                                  >
                                    ⛔ BLOCKED
                                  </span>
                                )}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[420px] space-y-1">
                              {isFire
                                ? (liveMode ? "Executes one $10-capped cycle on CURRENT books with detected fees — preflight re-runs every gate (≤200ms freshness) on the same live snapshot first." : "Enable LIVE mode to fire.")
                                : (<>
                                    <div className="font-semibold">{r.blocker ?? "blocked"}</div>
                                    <div>{r.reason}</div>
                                    {r.requiredBalances?.buyUsd != null && r.requiredBalances?.sellAssetQty != null && (
                                      <div>
                                        To make this executable: ${r.requiredBalances.buyUsd.toFixed(2)} USD on {r.buyVenue}
                                        {" + "}~{r.requiredBalances.sellAssetQty >= 1000 ? r.requiredBalances.sellAssetQty.toLocaleString(undefined, { maximumFractionDigits: 0 }) : r.requiredBalances.sellAssetQty.toFixed(6)} {r.asset} pre-positioned on {r.sellVenue}. No transfers are ever done automatically.
                                      </div>
                                    )}
                                  </>)}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </td>
                    </tr>
                    {isOpen && <RouteBreakdown r={r} />}
                  </Fragment>
                );
              })}
              {routes.length === 0 && data && <tr><td colSpan={8} className="text-muted-foreground py-2">no routes — waiting for live books…</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Inventory / pre-positioning planner */}
        <InventoryPlanner savedCreds={savedCreds} floorUsd={params?.minNetUsd} />

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
