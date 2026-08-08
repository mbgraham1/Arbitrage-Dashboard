/**
 * PROFIT HUNTER card — 24-hour read-only evidence collector.
 *
 * Start it once and it samples every strategy the app can price (~every 30s)
 * for 24 hours: cross-exchange spot, maker-hedge structures, stablecoin
 * dislocations, and spot-vs-perp funding carry. Records frequency,
 * survivability, best/worst/avg net — evidence for what deserves live wiring
 * next. It NEVER trades; the live safeguards and $10 cap are untouched.
 */
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { useHunterStart, useHunterStop, useHunterReport, getHunterReportQueryKey, HunterOpp } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const money = (v: number | null | undefined, d = 4) => (v == null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`);
const STRAT_LABEL: Record<string, string> = {
  "spot-cross": "Spot cross-exchange",
  "maker-hedge": "Maker→hedge",
  "stablecoin": "Stablecoin dislocation",
  "perp-funding": "Perp funding carry",
};
const CAT_STYLE: Record<string, string> = {
  EXECUTABLE_NOW: "text-green-500 font-semibold",
  NEEDS_ACCOUNT_OR_INVENTORY: "text-amber-500",
  NOT_PROFITABLE: "text-muted-foreground",
};
const CAT_LABEL: Record<string, string> = {
  EXECUTABLE_NOW: "EXECUTABLE NOW",
  NEEDS_ACCOUNT_OR_INVENTORY: "NEEDS ACCOUNT / INVENTORY",
  NOT_PROFITABLE: "NOT PROFITABLE",
};

function fmtDur(sec: number): string {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export function ProfitHunterCard() {
  const { credentials } = useBotContext();
  const { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } = credentials;
  const hasCreds = !!krakenKey && !!krakenSecret && !!coinbaseKey && !!coinbaseSecret;
  const start = useHunterStart();
  const stop = useHunterStop();
  const report = useHunterReport({ query: { queryKey: getHunterReportQueryKey(), refetchInterval: 10_000 } });
  const [actionErr, setActionErr] = useState<string | null>(null);
  const d = report.data;

  useEffect(() => { setActionErr(null); }, [d?.running]);

  const onStart = async () => {
    setActionErr(null);
    try {
      await start.mutateAsync({ data: {
        ...(hasCreds ? { krakenKey, krakenSecret, coinbaseKey, coinbaseSecret } : {}),
        ...(credentials.geminiKey && credentials.geminiSecret ? { geminiKey: credentials.geminiKey, geminiSecret: credentials.geminiSecret } : {}),
      } });
      await report.refetch();
    } catch (e) { setActionErr((e as Error).message); }
  };
  const onStop = async () => {
    setActionErr(null);
    try { await stop.mutateAsync(); await report.refetch(); } catch (e) { setActionErr((e as Error).message); }
  };

  const remaining = d?.running && d.endsAt ? Math.max(0, (Date.parse(d.endsAt) - Date.now()) / 1000) : null;
  const rows: HunterOpp[] = d?.top ?? [];

  return (
    <Card data-testid="card-profit-hunter" className="border-purple-500/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex flex-wrap items-center gap-2">
          <span className="text-purple-500">PROFIT HUNTER</span>
          <span className="text-muted-foreground font-normal">
            (24h read-only evidence collector · spot cross · maker-hedge · stablecoins · perp funding · records only, NEVER trades)
          </span>
          {d?.running ? (
            <Button size="sm" variant="destructive" onClick={onStop} disabled={stop.isPending} data-testid="button-hunter-stop">
              Stop hunt {remaining != null && `(${fmtDur(remaining)} left)`}
            </Button>
          ) : (
            <Button size="sm" className="bg-purple-600 hover:bg-purple-700" onClick={onStart} disabled={start.isPending} data-testid="button-hunter-start">
              Start 24h hunt {hasCreds ? "(with your keys)" : "(no keys — assumed fees)"}
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {actionErr && <div className="text-red-500">{actionErr}</div>}
        {!d && <div className="text-muted-foreground">Loading hunter state…</div>}
        {d && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
              <span>status: <span className={d.running ? "text-green-500" : ""}>{d.running ? "HUNTING" : "stopped"}</span></span>
              <span>samples: {d.ticks ?? 0}</span>
              <span>tracked opportunities: {d.tracked ?? 0}</span>
              <span>fees: {d.feeSource === "detected" ? <span className="text-green-500">your detected {credentials.geminiKey && credentials.geminiSecret ? "K/CB/Gemini" : "K/CB"} tiers</span> : <span className="text-amber-500">assumed entry tiers*</span>}{credentials.geminiKey && credentials.geminiSecret ? <span className="text-muted-foreground"> (Gemini keys forwarded — its legs use detected fees too)</span> : null}</span>
              {d.stopReason && <span className="text-amber-500">{d.stopReason}</span>}
            </div>
            {(d.errors?.length ?? 0) > 0 && <div className="text-red-400">recent sampling errors: {d.errors!.join(" · ")}</div>}
            <div className={cn("font-semibold", rows.some(r => (r.best10 ?? 0) > 0) ? "text-green-500" : "text-muted-foreground")} data-testid="text-hunter-verdict">
              {d.verdict}
            </div>
            {(d.strategyBest?.length ?? 0) > 0 && (
              <div className="text-muted-foreground">
                Best per strategy:{" "}
                {d.strategyBest!.map((r, i) => (
                  <span key={i} className="mr-3">
                    {STRAT_LABEL[r.strategy ?? ""] ?? r.strategy}: <span className={(r.best10 ?? 0) > 0 ? "text-green-500" : "text-red-400"}>{money(r.best10, 3)}</span> ({r.asset} {r.venues})
                  </span>
                ))}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left whitespace-nowrap">
                <thead className="text-muted-foreground">
                  <tr>
                    <th>strategy</th><th>opportunity</th>
                    <th className="text-right">last @$10</th><th className="text-right">@$50</th><th className="text-right">@$100</th>
                    <th className="text-right">best</th><th className="text-right">avg</th>
                    <th className="text-right">freq</th><th className="text-right">survives</th>
                    <th>status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={10} className="text-muted-foreground py-1">No samples yet — start the hunt.</td></tr>}
                  {rows.map((r, i) => (
                    <tr key={r.key ?? i} data-testid={`row-hunter-${i}`}>
                      <td className="pr-2">{STRAT_LABEL[r.strategy ?? ""] ?? r.strategy}</td>
                      <td className="pr-2" title={`${r.description}\nRequires: ${r.requirement}`}>{r.asset} · {r.venues}</td>
                      {[r.last10, r.last50, r.last100].map((v, j) => (
                        <td key={j} className={cn("text-right pr-2", (v ?? 0) > 0 ? "text-green-500 font-semibold" : "text-red-500")}>{money(v, 3)}</td>
                      ))}
                      <td className="text-right pr-2">{money(r.best10, 3)}</td>
                      <td className="text-right pr-2">{money(r.avg10, 3)}</td>
                      <td className="text-right pr-2" title={`positive on ${r.appearances} of ${r.sampledTicks} samples`}>{r.frequencyPct ?? 0}%</td>
                      <td className="text-right pr-2" title="longest consecutive positive run">{fmtDur(r.longestSurvivalSec ?? 0)}</td>
                      <td className={CAT_STYLE[r.category ?? ""] ?? ""} title={r.category === "NEEDS_ACCOUNT_OR_INVENTORY" ? r.requirement : undefined}>
                        {CAT_LABEL[r.category ?? ""] ?? r.category}
                        {r.category !== "NOT_PROFITABLE" && !r.executableKnown && <span className="text-muted-foreground" title="no keys during sampling — balance check impossible">†</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-muted-foreground">
              Ranked by realized-style expected value (avg positive net × frequency × survivability), never raw spread.
              * assumed fees are published entry tiers, not your real tiers. † executability unverified (no keys at start).
              Perp funding rows require a derivatives account and are informational only. This card records evidence — it cannot place trades, and the live $10 cap and safeguards are untouched.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
