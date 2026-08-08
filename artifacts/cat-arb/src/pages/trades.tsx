import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useListTrades, useGetTradeSummary, useGetTriangularHistory, useGetTriangularHistorySummary } from "@workspace/api-client-react";
import { format } from "date-fns";
import { ArrowRight, BarChart2, Activity, Triangle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { TriProfitChart } from "@/components/tri-profit-chart";
import { useBotContext } from "@/store/bot-context";

const TRI_PAGE_SIZE = 100;
const EXEC_PAGE_SIZE = 50;

const TRI_SIZE_STORAGE_KEY = "tri-counterfactual-trade-size-usd";
const TRI_SIZE_MIN = 100;
const TRI_SIZE_MAX = 10_000;
const TRI_SIZE_DEFAULT = 1000;

function loadStoredTriSize(): number {
  try {
    const raw = localStorage.getItem(TRI_SIZE_STORAGE_KEY);
    if (raw == null) return TRI_SIZE_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return TRI_SIZE_DEFAULT;
    return Math.min(TRI_SIZE_MAX, Math.max(TRI_SIZE_MIN, n));
  } catch {
    return TRI_SIZE_DEFAULT;
  }
}

type Tab = "executions" | "triangular";

export default function Trades() {
  const { settings } = useBotContext();
  const [tab, setTab] = useState<Tab>("executions");
  const [statusFilter, setStatusFilter] = useState<"all" | "verified" | "failed" | "simulated">("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [triPage, setTriPage] = useState(0);
  const [execPage, setExecPage] = useState(0);
  // Applied (clamped) trade size driving the query, plus the raw input text so
  // the user can type freely before the value is committed on blur/Enter.
  const [triSizeUsd, setTriSizeUsd] = useState<number>(() => loadStoredTriSize());
  const [triSizeInput, setTriSizeInput] = useState<string>(() => String(loadStoredTriSize()));

  const commitTriSize = () => {
    const n = Number(triSizeInput);
    const next = Number.isFinite(n) && triSizeInput.trim() !== ""
      ? Math.min(TRI_SIZE_MAX, Math.max(TRI_SIZE_MIN, n))
      : triSizeUsd;
    setTriSizeUsd(next);
    setTriSizeInput(String(next));
    try {
      localStorage.setItem(TRI_SIZE_STORAGE_KEY, String(next));
    } catch {
      // localStorage unavailable (private mode) — value still applies for the session
    }
  };

  const tradesQuery = useListTrades({ limit: EXEC_PAGE_SIZE, offset: execPage * EXEC_PAGE_SIZE });
  const summaryQuery = useGetTradeSummary();
  const triHistoryQuery = useGetTriangularHistory(
    { limit: TRI_PAGE_SIZE, offset: triPage * TRI_PAGE_SIZE },
    { refetchInterval: 30_000, enabled: tab === "triangular" },
  );
  const triSummaryQuery = useGetTriangularHistorySummary(
    { tradeSizeUsd: triSizeUsd },
    { refetchInterval: 30_000, enabled: tab === "triangular" },
  );

  const trades = tradesQuery.data || [];
  const summary = summaryQuery.data;
  const triItems = triHistoryQuery.data?.items ?? [];
  const triTotal = triHistoryQuery.data?.total ?? 0;
  const triSummary = triSummaryQuery.data;

  const execTotal = summary?.totalTrades ?? 0;
  const execTotalPages = Math.max(1, Math.ceil(execTotal / EXEC_PAGE_SIZE));
  const execRangeStart = execTotal === 0 ? 0 : execPage * EXEC_PAGE_SIZE + 1;
  const execRangeEnd = execPage * EXEC_PAGE_SIZE + trades.length;

  const visibleTrades = trades.filter(t => {
    if (statusFilter === "all") return true;
    if (statusFilter === "verified") return t.status === "verified";
    if (statusFilter === "failed") return t.status === "failed";
    return t.status === "simulated" || t.status === "estimated" || t.status == null;
  });
  // Base asset for the Volume header — derived from each trade's pair (legacy
  // rows without a pair are SOL/USD). If the visible page mixes assets, keep a
  // generic header and per-row labels so units stay unambiguous.
  const baseAssets = new Set(visibleTrades.map(t => (t.pair ?? "SOL/USD").split("/")[0]));
  const volumeBase = baseAssets.size === 1 ? [...baseAssets][0] : baseAssets.size === 0 ? "SOL" : null;

  const triTotalPages = Math.max(1, Math.ceil(triTotal / TRI_PAGE_SIZE));
  const triRangeStart = triTotal === 0 ? 0 : triPage * TRI_PAGE_SIZE + 1;
  const triRangeEnd = Math.min((triPage + 1) * TRI_PAGE_SIZE, triTotal);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col">
        <h1 className="text-2xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Activity className="h-6 w-6 text-primary" />
          Trade Ledger
        </h1>
        <p className="text-muted-foreground font-mono text-sm">Historical operations and performance</p>
      </div>

      {/* Summary Cards — shown only on Executions tab */}
      {tab === "executions" && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold text-muted-foreground uppercase">Total Trades</span>
              <span className="text-2xl font-mono font-bold">{summary?.totalTrades || 0}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold text-muted-foreground uppercase">Live Trades</span>
              <span className="text-2xl font-mono font-bold text-primary">{summary?.liveTrades || 0}</span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold text-muted-foreground uppercase">Avg Net Edge</span>
              <span className="text-2xl font-mono font-bold">{summary?.avgNetEdgePct.toFixed(3) || "0.000"}%</span>
            </CardContent>
          </Card>
          <Card className="bg-primary text-primary-foreground border-primary">
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold uppercase opacity-80">Realized P&L (Verified)</span>
              <span className="text-2xl font-mono font-bold" data-testid="text-realized-pnl-card">
                ${(summary?.realizedPnlUsd ?? 0).toFixed(2)}
              </span>
              <span className="text-[10px] font-mono opacity-80">
                {summary?.verifiedTrades ?? 0} verified · {summary?.failedTrades ?? 0} failed · {summary?.simulatedTrades ?? 0} sim/est
              </span>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        <button
          onClick={() => setTab("executions")}
          className={cn(
            "px-4 py-2 text-xs font-bold uppercase tracking-wide border-b-2 -mb-px transition-colors flex items-center gap-2",
            tab === "executions"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <BarChart2 className="h-3.5 w-3.5" />
          Executions
        </button>
        <button
          onClick={() => { setTab("triangular"); setTriPage(0); }}
          className={cn(
            "px-4 py-2 text-xs font-bold uppercase tracking-wide border-b-2 -mb-px transition-colors flex items-center gap-2",
            tab === "triangular"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <Triangle className="h-3.5 w-3.5" />
          Triangular Scans
          {triTotal > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {triTotal}
            </span>
          )}
        </button>
      </div>

      {/* ── Executions tab ── */}
      {tab === "executions" && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart2 className="h-4 w-4" /> Execution History
              <span className="flex gap-1 ml-2">
                {([["all","ALL"],["verified","✓ VERIFIED"],["failed","✗ FAILED"],["simulated","🧪 SIM/EST"]] as const).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setStatusFilter(v)}
                    data-testid={`filter-${v}`}
                    className={cn(
                      "text-[10px] font-mono font-bold px-1.5 py-0.5 border transition-colors",
                      statusFilter === v ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </span>
              {execTotal > 0 && (
                <span className="ml-auto text-xs text-muted-foreground font-normal font-mono">
                  Showing {execRangeStart}–{execRangeEnd} of {execTotal}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {tradesQuery.isPending ? (
              <div className="p-8 text-center text-sm font-mono text-muted-foreground animate-pulse">Loading ledger...</div>
            ) : trades.length === 0 ? (
              <div className="p-8 text-center text-sm font-mono text-muted-foreground">No trades recorded yet.</div>
            ) : (
              <table className="w-full text-sm font-mono whitespace-nowrap">
                <thead>
                  <tr className="border-b-2 border-border bg-muted/50">
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Date</th>
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Mode</th>
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Pair</th>
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Route</th>
                    <th className="px-4 py-3 text-right font-bold uppercase text-xs">
                      {volumeBase ? `Volume (${volumeBase})` : "Volume"}
                    </th>
                    <th className="px-4 py-3 text-right font-bold uppercase text-xs">Net Edge</th>
                    <th className="px-4 py-3 text-right font-bold uppercase text-xs">Expected (USD)</th>
                    <th className="px-4 py-3 text-right font-bold uppercase text-xs">Realized (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-border">
                  {visibleTrades.map((trade) => {
                    const verified = trade.status === "verified";
                    const failed = trade.status === "failed";
                    const fills = Array.isArray(trade.legFills) ? trade.legFills : [];
                    const expanded = expandedId === trade.id;
                    return (
                    <React.Fragment key={trade.id}>
                    <tr
                      className="hover:bg-muted/30 transition-colors cursor-pointer"
                      onClick={() => setExpandedId(expanded ? null : trade.id)}
                      data-testid={`row-trade-${trade.id}`}
                    >
                      <td className="px-4 py-3 text-muted-foreground">
                        {format(new Date(trade.createdAt), "MM/dd HH:mm:ss")}
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5">
                          {verified ? (
                            <Badge className="text-[10px] bg-success text-success-foreground hover:bg-success">✓ VERIFIED</Badge>
                          ) : failed ? (
                            <Badge variant="destructive" className="text-[10px]">✗ FAILED</Badge>
                          ) : trade.isDryRun || trade.status === "simulated" ? (
                            <Badge variant="secondary" className="text-[10px]">🧪 SIMULATED</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">EST (LEGACY)</Badge>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 border border-border text-muted-foreground">{trade.pair ?? "SOL/USD"}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-bold">{trade.buyExchange.toUpperCase()}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span className="font-bold">{trade.sellExchange.toUpperCase()}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {trade.volume.toFixed(4)}
                        {!volumeBase && (
                          <>
                            {" "}
                            <span className="text-muted-foreground text-[10px]">{(trade.pair ?? "SOL/USD").split("/")[0]}</span>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={cn(trade.netEdgePct > 0 ? "text-success font-bold" : "")}>
                          {trade.netEdgePct.toFixed(3)}%
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground" title="Scanner expectation at execution time — never counted as profit">
                        ~${trade.estimatedProfitUsd.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold" data-testid={`text-realized-${trade.id}`}>
                        {trade.realizedProfitUsd != null ? (
                          <span className={cn(trade.realizedProfitUsd > 0 ? "text-success" : trade.realizedProfitUsd < 0 ? "text-destructive" : "")}>
                            ${trade.realizedProfitUsd.toFixed(4)}
                          </span>
                        ) : failed ? (
                          <span className="text-muted-foreground" title="Partial fills occurred — net effect not reconciled">—</span>
                        ) : (
                          <span className="text-muted-foreground" title="No confirmed fill data — nothing realized">—</span>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-muted/20">
                        <td colSpan={8} className="px-6 py-3 text-xs">
                          {fills.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              <span className="font-bold uppercase text-[10px] text-muted-foreground">Confirmed exchange fills</span>
                              {fills.map((f: any, fi: number) => (
                                <div key={fi} className="flex flex-wrap gap-x-4 gap-y-0.5">
                                  <span className="font-bold">leg {f.leg}{f.taker ? " (taker)" : ""}{f.unwind ? " (unwind)" : ""}</span>
                                  <span>{f.side} {f.pair}</span>
                                  <span>vol {Number(f.volume).toFixed(8)}</span>
                                  {f.price != null && <span>@ {Number(f.price).toFixed(6)}</span>}
                                  {f.fee != null && <span>fee ${Number(f.fee).toFixed(6)}</span>}
                                  <span className="text-muted-foreground">order {f.txid || "—"}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="flex flex-col gap-0.5 text-muted-foreground">
                              <span>No per-leg fill data recorded for this row{trade.status === "estimated" || trade.status == null ? " (legacy record — cannot be verified)" : ""}.</span>
                              {(trade.buyOrderId || trade.sellOrderId) && (
                                <span>Order IDs: {[trade.buyOrderId, trade.sellOrderId].filter(Boolean).join(" / ")}</span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );})}
                </tbody>
              </table>
            )}
          </CardContent>
          {execTotal > EXEC_PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs font-mono text-muted-foreground">
                Page {execPage + 1} of {execTotalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs font-mono"
                  disabled={execPage === 0 || tradesQuery.isFetching}
                  onClick={() => setExecPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs font-mono"
                  disabled={execPage >= execTotalPages - 1 || tradesQuery.isFetching}
                  onClick={() => setExecPage((p) => Math.min(execTotalPages - 1, p + 1))}
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ── Triangular Scans tab — summary cards ── */}
      {tab === "triangular" && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold text-muted-foreground uppercase">Total Opportunities</span>
              <span className="text-2xl font-mono font-bold">
                {triSummary?.total ?? triTotal ?? 0}
              </span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold text-muted-foreground uppercase">Avg Profit %</span>
              <span className="text-2xl font-mono font-bold text-primary">
                {triSummary ? `+${triSummary.avgProfitPct.toFixed(4)}%` : "—"}
              </span>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold text-muted-foreground uppercase">Best Opportunity</span>
              <span className="text-2xl font-mono font-bold text-success">
                {triSummary ? `+${triSummary.bestProfitPct.toFixed(4)}%` : "—"}
              </span>
            </CardContent>
          </Card>
          <Card className="bg-primary text-primary-foreground border-primary">
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-bold uppercase opacity-80">Counterfactual P&amp;L</span>
              <span className="text-2xl font-mono font-bold">
                {triSummary ? `$${triSummary.counterfactualPnlUsd.toFixed(2)}` : "—"}
              </span>
              <label className="flex items-center gap-1.5 text-[10px] opacity-80 font-mono">
                @ $
                <input
                  type="number"
                  min={TRI_SIZE_MIN}
                  max={TRI_SIZE_MAX}
                  step={100}
                  value={triSizeInput}
                  onChange={(e) => setTriSizeInput(e.target.value)}
                  onBlur={commitTriSize}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  aria-label="Assumed trade size in USD"
                  className="w-20 bg-primary-foreground/10 border border-primary-foreground/30 rounded px-1.5 py-0.5 text-[11px] font-mono font-bold text-primary-foreground focus:outline-none focus:border-primary-foreground/70"
                />
                /trade
              </label>
              <span className="text-[10px] font-mono opacity-70 leading-tight">
                Analysis-only assumption — independent of the live scan trade size
                {settings.obTradeSize !== triSizeUsd && (
                  <> (currently ${settings.obTradeSize})</>
                )}
              </span>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Triangular Scans tab — profit-over-time chart ── */}
      {tab === "triangular" && <TriProfitChart items={triItems} />}

      {/* ── Triangular Scans tab — history table ── */}
      {tab === "triangular" && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Triangle className="h-4 w-4" /> Triangular Scan History
              {triTotal > 0 && (
                <span className="ml-auto text-xs text-muted-foreground font-normal font-mono">
                  Showing {triRangeStart}–{triRangeEnd} of {triTotal}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {triHistoryQuery.isPending ? (
              <div className="p-8 text-center text-sm font-mono text-muted-foreground animate-pulse">Loading scan history...</div>
            ) : triItems.length === 0 ? (
              <div className="p-8 text-center text-sm font-mono text-muted-foreground">
                No triangular opportunities recorded yet. Run a TRI scan on the dashboard to start tracking.
              </div>
            ) : (
              <table className="w-full text-sm font-mono whitespace-nowrap">
                <thead>
                  <tr className="border-b-2 border-border bg-muted/50">
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Date</th>
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Exchange</th>
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Loop</th>
                    <th className="px-4 py-3 text-left font-bold uppercase text-xs">Variant</th>
                    <th className="px-4 py-3 text-right font-bold uppercase text-xs">SOL/USD</th>
                    <th className="px-4 py-3 text-right font-bold uppercase text-xs">ETH/USD</th>
                    <th className="px-4 py-3 text-right font-bold uppercase text-xs">Net Profit %</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-border">
                  {triItems.map((row: import("@workspace/api-client-react").TriScanRecord) => (
                    <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 text-muted-foreground">
                        {format(new Date(row.createdAt), "MM/dd HH:mm:ss")}
                      </td>
                      <td className="px-4 py-3 font-bold">{row.exchange}</td>
                      <td className="px-4 py-3 text-muted-foreground max-w-[220px] truncate">
                        {row.loop}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 border border-border text-muted-foreground">
                          {row.variant === "btc" ? "BTC" : "ETH"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        ${row.solUsd.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        ${row.variant === "btc"
                          ? row.ethUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })
                          : row.ethUsd.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold">
                        <span className="text-success">
                          +{row.profitPct.toFixed(4)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
          {triTotal > TRI_PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs font-mono text-muted-foreground">
                Page {triPage + 1} of {triTotalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs font-mono"
                  disabled={triPage === 0 || triHistoryQuery.isFetching}
                  onClick={() => setTriPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs font-mono"
                  disabled={triPage >= triTotalPages - 1 || triHistoryQuery.isFetching}
                  onClick={() => setTriPage((p) => Math.min(triTotalPages - 1, p + 1))}
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
