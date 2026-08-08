/**
 * AUTO REBALANCE — funding engine that pre-positions inventory for the best
 * positive-net cross-venue routes so they become executable.
 *
 * Honest UI: LOCAL BUYS are the only actions ever fired automatically (v1).
 * Transfers are PLANNED with real withdrawal fees but never auto-executed —
 * confirmation delays make a quoted edge unreliable. Every profit figure is a
 * PROJECTION, not a guarantee. No action ever runs on assumed fees or
 * unverified balances. Missing exchange permissions are shown verbatim (the
 * exact setting to change). Uses the SAME saved venue creds the scanner uses.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBotContext } from "@/store/bot-context";
import { useToast } from "@/hooks/use-toast";
import {
  useRebalanceCaps, useRebalancePlan, useRebalanceArm, useRebalanceStop,
  useRebalanceStatus, getRebalanceStatusQueryKey, useRebalanceClearLatch,
  RebalanceCaps, RebalancePlan, RebalanceStatus, RebalanceVenueCaps,
  RebalanceAction, RebalanceLogEntry, ErrorResponse,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const usd = (v: number | null | undefined, d = 2) => (v == null ? "—" : `$${v.toFixed(d)}`);
const qtyLabel = (v: number, asset: string) =>
  `${v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(6)} ${asset}`;

const VENUES = ["kraken", "coinbase", "gemini"] as const;

/** yes/no capability pill. */
function YesNo({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 font-semibold", ok ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground")}>
      {label} {ok ? "yes" : "no"}
    </span>
  );
}

/** Per-venue capability panel with verbatim missing-permission guidance. */
function CapabilityPanel({ caps }: { caps: RebalanceVenueCaps[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3" data-testid="rebalance-caps">
      {caps.map((v) => (
        <div key={v.venue} className="rounded border border-border p-2 space-y-1" data-testid={`rebalance-cap-${v.venue}`}>
          <div className="font-medium capitalize">{v.venue}</div>
          <div className="flex flex-wrap gap-1">
            <YesNo ok={v.localBuy} label="LOCAL BUY" />
            <YesNo ok={v.withdraw} label="WITHDRAW" />
          </div>
          {v.whitelist.length > 0 && (
            <div className="text-muted-foreground">
              whitelist: {v.whitelist.map(w => `${w.key} (${w.asset})`).join(", ")}
            </div>
          )}
          {v.missing && (
            <div className="flex gap-1 rounded bg-amber-500/10 p-1 text-amber-500" data-testid={`rebalance-missing-${v.venue}`}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{v.missing}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** done/partial/failed/refused/skipped status chip. */
function LogStatusChip({ status }: { status: string }) {
  const cls = status === "done" ? "bg-green-500/15 text-green-500"
    : status === "failed" ? "bg-red-500/15 text-red-500"
    : "bg-amber-500/15 text-amber-500"; // partial | refused | skipped
  return <span className={cn("rounded px-1.5 py-0.5 font-semibold", cls)}>{status}</span>;
}

export function AutoRebalanceCard() {
  const { credentials } = useBotContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, geminiKey, geminiSecret } = credentials;

  const [caps, setCaps] = useState<RebalanceCaps | null>(null);
  const [plan, setPlan] = useState<RebalancePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Arm controls
  const [perActionCapUsd, setPerActionCapUsd] = useState(15);
  const [dailyCapUsd, setDailyCapUsd] = useState(30);
  const [reserves, setReserves] = useState<Record<string, number>>({ kraken: 0, coinbase: 0, gemini: 0 });

  const capsM = useRebalanceCaps();
  const planM = useRebalancePlan();
  const armM = useRebalanceArm();
  const stopM = useRebalanceStop();
  const clearM = useRebalanceClearLatch();
  const status = useRebalanceStatus({ query: { queryKey: getRebalanceStatusQueryKey(), refetchInterval: (q) => (((q.state.data as RebalanceStatus | undefined)?.armed) ? 5_000 : false) } });
  const st: RebalanceStatus | undefined = status.data;
  const armed = st?.armed ?? false;
  // Latch may surface from status OR the periodic plan poll.
  const latch = st?.latch ?? plan?.latch ?? null;

  const savedCreds = () => ({
    ...(krakenKey && krakenSecret ? { krakenKey, krakenSecret } : {}),
    ...(coinbaseKey && coinbaseSecret ? { coinbaseKey, coinbaseSecret } : {}),
    ...(geminiKey && geminiSecret ? { geminiKey, geminiSecret } : {}),
  });

  // Caps + plan refresh every 20s using the same saved creds as the scanner.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const creds = savedCreds();
      try {
        const [c, p] = await Promise.all([
          capsM.mutateAsync({ data: creds }),
          planM.mutateAsync({ data: creds }),
        ]);
        if (!cancelled) { setCaps(c); setPlan(p); setPlanError(null); }
      } catch (e) {
        if (!cancelled) setPlanError((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 20_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [krakenKey, krakenSecret, coinbaseKey, coinbaseSecret, geminiKey, geminiSecret]);

  const arm = async () => {
    setBusy(true);
    try {
      await armM.mutateAsync({ data: { ...savedCreds(), perActionCapUsd, dailyCapUsd, reservesUsd: { kraken: reserves.kraken, coinbase: reserves.coinbase, gemini: reserves.gemini } } });
      qc.invalidateQueries({ queryKey: getRebalanceStatusQueryKey() });
      toast({ title: "Auto Rebalance armed", description: "Executes beneficial LOCAL BUYS only, within your caps and reserves." });
    } catch (e) {
      const msg = (e as { data?: ErrorResponse }).data?.error ?? (e as Error).message;
      toast({ title: "Cannot arm", description: msg, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopM.mutateAsync();
      qc.invalidateQueries({ queryKey: getRebalanceStatusQueryKey() });
      toast({ title: "EMERGENCY STOP", description: "Engine disarmed — in-memory keys wiped." });
    } catch (e) {
      toast({ title: "Stop failed", description: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const clearLatch = async () => {
    setBusy(true);
    try {
      await clearM.mutateAsync({ data: { confirm: true } });
      qc.invalidateQueries({ queryKey: getRebalanceStatusQueryKey() });
      toast({ title: "Reconciliation latch cleared", description: "Engine can arm again." });
    } catch (e) {
      const msg = (e as { data?: ErrorResponse }).data?.error ?? (e as Error).message;
      toast({ title: "Clear latch failed", description: msg, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const actions = plan?.actions ?? [];

  return (
    <Card data-testid="card-auto-rebalance" className="mt-6 border-violet-500/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          <span className="text-violet-400">Auto Rebalance — funding engine</span>{" "}
          <span className="text-muted-foreground font-normal">
            (pre-positions inventory for the best positive-net routes · LOCAL BUYS only · transfers planned, never auto-fired)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="text-muted-foreground">
          Executes LOCAL BUYS only (v1), as bounded IOC limit orders — never market orders — after a fresh ≤2s revalidation of fees, depth, and net edge immediately before the order. Only routes with DETECTED fees on BOTH legs and VERIFIED balances are ever acted on. Transfers are planned with real withdrawal fees but never fired automatically — confirmation delays make quoted edges unreliable. All profits shown are projections, not guarantees.
        </div>

        {/* Durable reconciliation latch — loud red, blocks arming. */}
        {latch && (
          <div className="border border-red-500 bg-red-500/10 rounded p-2 space-y-2" data-testid="text-rebalance-latch">
            <div className="font-bold text-red-500">⚠ RECONCILIATION LATCH SET — {latch}</div>
            <div className="text-red-400">An earlier order's outcome is unverified. Check the exchange's order history first, then clear.</div>
            <Button size="sm" variant="destructive" className="h-7 px-3" disabled={busy} onClick={clearLatch} data-testid="button-rebalance-clear-latch">
              {busy ? "…" : "I checked the exchange — clear latch"}
            </Button>
          </div>
        )}

        {/* Capability probe */}
        {caps ? <CapabilityPanel caps={caps.venues} /> : <div className="text-muted-foreground">Probing venue capabilities…</div>}

        {/* Plan table */}
        <div>
          <div className="font-semibold text-violet-300 mb-1">
            Planned actions{plan ? ` · ${plan.routesConsidered} positive routes considered` : ""}
          </div>
          {planError && <div className="text-red-500" data-testid="text-rebalance-plan-error">Plan failed: {planError}</div>}
          {plan && actions.length === 0 && !planError && (
            <div className="text-muted-foreground" data-testid="text-rebalance-plan-empty">
              No funding actions right now — either nothing is positive-net or every route is already positioned.
            </div>
          )}
          {actions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left" data-testid="table-rebalance-plan">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pr-2">kind</th><th className="pr-2">asset</th><th className="pr-2">destination</th>
                    <th className="pr-2 text-right">qty (~$notional)</th><th className="pr-2 text-right">overhead</th>
                    <th className="pr-2 text-right">route net</th><th className="pr-2 text-right">net after overhead</th>
                    <th className="pr-2"></th><th>reason</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((a: RebalanceAction, i) => (
                    <tr key={i} data-testid={`row-rebalance-action-${i}`} className={cn(a.beneficial && "bg-violet-500/5")}>
                      <td className="pr-2 whitespace-nowrap font-mono">{a.kind}</td>
                      <td className="pr-2">{a.asset}</td>
                      <td className="pr-2 whitespace-nowrap capitalize">
                        {a.venue}{a.kind === "TRANSFER" && a.sourceVenue ? <span className="text-muted-foreground"> ← {a.sourceVenue}</span> : null}
                      </td>
                      <td className="pr-2 text-right whitespace-nowrap">{qtyLabel(a.qty, a.asset)} <span className="text-muted-foreground">(~{usd(a.estNotionalUsd)})</span></td>
                      <td className="pr-2 text-right">{usd(a.overheadUsd, 3)}</td>
                      <td className="pr-2 text-right">{usd(a.routeNetUsd, 3)}</td>
                      <td className={cn("pr-2 text-right", a.netAfterOverheadUsd > 0 ? "text-green-500" : "text-red-500")}>{usd(a.netAfterOverheadUsd, 3)}</td>
                      <td className="pr-2">
                        <span className={cn("rounded px-1.5 py-0.5 font-semibold whitespace-nowrap", a.beneficial ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground")}>
                          {a.beneficial ? "BENEFICIAL" : "REFUSED"}
                        </span>
                      </td>
                      <td className="text-muted-foreground">
                        <div>{a.reason}</div>
                        {a.transferRisk && <div className="italic text-red-500" data-testid={`text-rebalance-risk-${i}`}>{a.transferRisk}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {plan?.note && <div className="text-muted-foreground mt-1 text-[11px] leading-snug" data-testid="text-rebalance-note">{plan.note}</div>}
        </div>

        {/* Arm controls */}
        <div className="rounded border border-violet-500/40 p-2 space-y-2" data-testid="rebalance-controls">
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1">
              <div className="text-muted-foreground">per-action cap $ (max 25)</div>
              <Input type="number" min={1} max={25} value={perActionCapUsd} disabled={armed}
                onChange={(e) => setPerActionCapUsd(Number(e.target.value))} className="h-7 w-24" data-testid="input-rebalance-peraction" />
            </label>
            <label className="space-y-1">
              <div className="text-muted-foreground">daily cap $ (max 100)</div>
              <Input type="number" min={1} max={100} value={dailyCapUsd} disabled={armed}
                onChange={(e) => setDailyCapUsd(Number(e.target.value))} className="h-7 w-24" data-testid="input-rebalance-daily" />
            </label>
            {VENUES.map((v) => (
              <label key={v} className="space-y-1">
                <div className="text-muted-foreground capitalize">{v} reserve $</div>
                <Input type="number" min={0} value={reserves[v]} disabled={armed}
                  onChange={(e) => setReserves(r => ({ ...r, [v]: Number(e.target.value) }))} className="h-7 w-24" data-testid={`input-rebalance-reserve-${v}`} />
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded px-1.5 py-0.5 font-semibold", armed ? "bg-green-500/15 text-green-500" : "bg-muted text-muted-foreground")}>
              {armed ? "ARMED" : "DISARMED"}
            </span>
            {armed
              ? <Button size="sm" variant="destructive" className="h-7 px-4 font-bold" disabled={busy} onClick={stop} data-testid="button-rebalance-stop">{busy ? "…" : "EMERGENCY STOP"}</Button>
              : <Button size="sm" className="h-7 px-4" disabled={busy || !!latch} onClick={arm} data-testid="button-rebalance-arm" title={latch ? "clear the reconciliation latch first" : undefined}>{busy ? "…" : "Arm Auto Rebalance"}</Button>}
            {!armed && latch && <span className="text-red-500">clear the reconciliation latch to arm</span>}
          </div>

          {st?.pausedReason && (
            <div className="border border-red-500 bg-red-500/10 rounded p-2 font-bold text-red-500" data-testid="text-rebalance-paused">
              ⚠ AUTO REBALANCE PAUSED — {st.pausedReason}
            </div>
          )}

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground" data-testid="text-rebalance-counters">
            <span>rolling 24h used: <span className={cn((st?.dailyUsedUsd ?? 0) > 0 && "text-foreground")}>{usd(st?.dailyUsedUsd ?? 0)}</span> / {usd(st?.cfg?.dailyCapUsd ?? dailyCapUsd)}</span>
            <span>ticks: {st?.ticks ?? 0}</span>
            <span>actions done: <span className={cn((st?.actionsDone ?? 0) > 0 && "text-green-500 font-semibold")}>{st?.actionsDone ?? 0}</span></span>
          </div>
        </div>

        {/* Activity log */}
        <div>
          <div className="font-semibold text-violet-300 mb-1">Activity log</div>
          <div className="overflow-x-auto">
            {(st?.log?.length ?? 0) === 0 ? (
              <div className="text-muted-foreground">no activity yet.</div>
            ) : (
              <table className="w-full text-left whitespace-nowrap" data-testid="table-rebalance-log">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pr-3">time</th><th className="pr-3">action</th><th className="pr-3">asset</th>
                    <th className="pr-3">from→to</th><th className="pr-3 text-right">qty</th><th className="pr-3 text-right">$notional</th>
                    <th className="pr-3 text-right">fee</th><th className="pr-3">status</th><th>detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(st?.log ?? []).map((e: RebalanceLogEntry, i) => (
                    <tr key={i} data-testid={`row-rebalance-log-${i}`}>
                      <td className="pr-3">{new Date(e.at).toLocaleTimeString()}</td>
                      <td className="pr-3 font-mono">{e.kind}</td>
                      <td className="pr-3">{e.asset}</td>
                      <td className="pr-3 capitalize">{e.fromVenue ? `${e.fromVenue}→` : ""}{e.toVenue}</td>
                      <td className="pr-3 text-right">{e.qty ? e.qty.toFixed(6) : "—"}</td>
                      <td className="pr-3 text-right">{usd(e.notionalUsd)}</td>
                      <td className="pr-3 text-right">{usd(e.feeUsd, 4)}</td>
                      <td className="pr-3"><LogStatusChip status={e.status} /></td>
                      <td className="text-muted-foreground max-w-[420px] truncate" title={e.detail}>{e.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
