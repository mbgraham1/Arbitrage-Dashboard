import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import {
  Activity, Play, Square, DollarSign, TrendingUp, Zap, ShieldAlert,
  FileText, ArrowRight, Radio, Wifi, WifiOff, Siren, RefreshCw, BookOpen,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useGetTradeSummary, useListTrades, useScanAllPairs, useGetObScan, getObScanQueryKey, TradeRecord, PairScanEntry, ObCycleEntry } from "@workspace/api-client-react";

// ── Small helpers ──────────────────────────────────────────────────────────────

function PriceTile({
  label,
  bid,
  ask,
  wsLive,
  highlight,
  tag,
}: {
  label: string;
  bid: number | null | undefined;
  ask: number | null | undefined;
  wsLive?: boolean;
  highlight?: "buy" | "sell" | null;
  tag?: string;
}) {
  return (
    <div className={cn(
      "flex flex-col gap-1 border-2 p-3",
      highlight === "buy" && "border-success bg-success/5",
      highlight === "sell" && "border-primary bg-primary/5",
      !highlight && "border-border bg-muted/10",
    )}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-bold uppercase text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {tag && (
            <span className={cn(
              "text-[9px] font-mono font-bold px-1 border",
              highlight === "buy" ? "text-success border-success" :
              highlight === "sell" ? "text-primary border-primary" :
              "text-muted-foreground border-border"
            )}>{tag}</span>
          )}
          {wsLive != null ? (
            wsLive
              ? <Wifi className="h-3 w-3 text-success" />
              : <WifiOff className="h-3 w-3 text-yellow-500" />
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[10px] text-muted-foreground">
          Bid <span className={cn("font-bold", highlight === "sell" && "text-primary")}>
            {bid != null ? `$${bid.toFixed(4)}` : "—"}
          </span>
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          Ask <span className={cn("font-bold", highlight === "buy" && "text-success")}>
            {ask != null ? `$${ask.toFixed(4)}` : "—"}
          </span>
        </span>
      </div>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export default function Dashboard() {
  const {
    isRunning, setIsRunning, liveMode,
    latestPriceData, cachedBalances, activityLog, sessionProfitUsd,
    settings, credentials, addLog,
    forceTrade, isForcingTrade,
    forceTriangular, isForcingTriangular,
    isExecutingTriangular,
    emergencyStop, setEmergencyStop,
    startTime, failedTrades, sessionTradeCount, apiLatencyMs,
    triOpportunities,
  } = useBotContext();
  const [uptimeStr, setUptimeStr] = useState("0h 0m");
  useEffect(() => {
    if (!startTime) { setUptimeStr("0h 0m"); return; }
    const tick = () => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      setUptimeStr(`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [startTime]);

  const handleEmergencyStop = () => {
    setEmergencyStop(true);
    setIsRunning(false);
    addLog("error", "Emergency stop pressed.");
  };

  const summaryQuery = useGetTradeSummary();

  const toggleBot = () => {
    if (!credentials.krakenKey && !isRunning) {
      addLog("error", "Cannot start bot without API credentials. Go to Settings.");
      return;
    }
    setIsRunning(!isRunning);
  };

  const netEdge = latestPriceData
    ? latestPriceData.grossSpreadPct - settings.totalFees - settings.slippage
    : null;
  const hasEdge = netEdge != null && netEdge >= settings.minNetEdge;

  const buy = latestPriceData?.bestBuyExchange ?? null;
  const sell = latestPriceData?.bestSellExchange ?? null;

  const highlightFor = (exchange: string) => {
    if (exchange === buy && exchange !== sell) return "buy" as const;
    if (exchange === sell && exchange !== buy) return "sell" as const;
    return null;
  };

  const tagFor = (exchange: string) => {
    if (exchange === buy && exchange !== sell) return "BUY";
    if (exchange === sell && exchange !== buy) return "SELL";
    return undefined;
  };

  return (
    <div className="flex flex-col gap-6">

      {/* Top Action Bar */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-card p-4 border-2 border-border">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold uppercase tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            Control Deck
          </h1>
          <p className="text-muted-foreground font-mono text-sm">
            Kraken ↔ Coinbase · Persistent Ledger
          </p>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto flex-wrap">
          {isRunning && (
            <div className="bg-muted px-3 py-2 border-2 border-border flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase font-bold text-muted-foreground">Uptime</span>
              <span className="text-sm font-mono font-bold leading-none">{uptimeStr}</span>
            </div>
          )}

          <div className="bg-muted px-3 py-2 border-2 border-border flex flex-col items-center justify-center">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">Trades Today</span>
            <span className="text-sm font-mono font-bold leading-none">{sessionTradeCount}</span>
          </div>

          {apiLatencyMs != null && (
            <div className="bg-muted px-3 py-2 border-2 border-border flex flex-col items-center justify-center">
              <span className="text-[10px] uppercase font-bold text-muted-foreground">API Latency</span>
              <span className={cn(
                "text-sm font-mono font-bold leading-none",
                apiLatencyMs > 500 ? "text-destructive" : apiLatencyMs > 200 ? "text-yellow-500" : "text-success"
              )}>{apiLatencyMs.toFixed(0)} ms</span>
            </div>
          )}

          <div className="bg-muted px-3 py-2 border-2 border-border flex flex-col items-center justify-center">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">Failed Trades</span>
            <span className={cn("text-sm font-mono font-bold leading-none", failedTrades > 0 ? "text-destructive" : "")}>
              {failedTrades}
            </span>
          </div>

          <div className="bg-muted px-4 py-2 border-2 border-border flex flex-col items-end flex-1 md:flex-none">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">
              Total P&L (Persistent) · {summaryQuery.data?.totalTrades ?? 0} trades
            </span>
            <span className={cn(
              "text-xl font-mono font-bold leading-none",
              (summaryQuery.data?.totalProfitUsd ?? 0) > 0 ? "text-success" :
              (summaryQuery.data?.totalProfitUsd ?? 0) < 0 ? "text-destructive" : ""
            )}>
              {(summaryQuery.data?.totalProfitUsd ?? 0) >= 0 ? "+" : "-"}$
              {Math.abs(summaryQuery.data?.totalProfitUsd ?? 0).toFixed(2)}
            </span>
            {sessionProfitUsd !== 0 && (
              <span className="text-[10px] font-mono text-muted-foreground">
                session: {sessionProfitUsd >= 0 ? "+" : "-"}${Math.abs(sessionProfitUsd).toFixed(2)}
              </span>
            )}
          </div>

          {/* Force Trade — live mode only */}
          {liveMode && (
            <Button
              variant="outline"
              size="lg"
              className="border-2 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground font-bold uppercase"
              onClick={forceTrade}
              disabled={isForcingTrade}
              title="Execute immediately on Kraken/Coinbase, ignoring edge threshold"
            >
              <Siren className="h-4 w-4 mr-2" />
              {isForcingTrade ? "EXECUTING..." : "FORCE MARKET TRADE"}
            </Button>
          )}

          {/* Force Triangular — live mode only, $10 BTC/SOL test loop */}
          {liveMode && (
            <Button
              variant="outline"
              size="lg"
              className="border-2 border-yellow-500 text-yellow-600 hover:bg-yellow-500 hover:text-white font-bold uppercase"
              onClick={forceTriangular}
              disabled={isForcingTriangular}
              title="Fire best BTC/SOL/USD loop on Kraken with $10 test — 3 market orders"
            >
              <RefreshCw className={cn("h-4 w-4 mr-2", isForcingTriangular && "animate-spin")} />
              {isForcingTriangular ? "TRI FIRING..." : "FORCE TRI"}
            </Button>
          )}

          <Button
            size="lg"
            variant={isRunning ? "destructive" : "default"}
            className="w-full md:w-40"
            onClick={toggleBot}
          >
            {isRunning ? (
              <><Square className="h-4 w-4 mr-2" /> STOP BOT</>
            ) : (
              <><Play className="h-4 w-4 mr-2" /> START BOT</>
            )}
          </Button>

          <Button
            size="lg"
            variant="destructive"
            className="w-full md:w-auto border-2 border-red-400 font-bold"
            onClick={handleEmergencyStop}
            disabled={emergencyStop}
            title={emergencyStop ? "Emergency stop is active — reset in Settings" : "Immediately halt bot and cancel any open orders"}
          >
            🛑 {emergencyStop ? "EMERGENCY STOPPED" : "EMERGENCY STOP"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left Column */}
        <div className="flex flex-col gap-6">

          {/* 4-Exchange Price Grid */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Radio className="h-4 w-4" /> Kraken ↔ Coinbase
                {latestPriceData && (
                  <span className="ml-auto text-[10px] font-mono font-bold px-2 py-0.5 border border-success text-success">
                    LIVE
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 grid grid-cols-2 gap-2">
              <PriceTile
                label="Kraken"
                bid={latestPriceData?.krakenBid}
                ask={latestPriceData?.krakenAsk}
                wsLive={latestPriceData?.wsStatus.kraken}
                highlight={highlightFor("Kraken")}
                tag={tagFor("Kraken")}
              />
              <PriceTile
                label="Coinbase"
                bid={latestPriceData?.coinbaseBid}
                ask={latestPriceData?.coinbaseAsk}
                wsLive={latestPriceData?.wsStatus.coinbase}
                highlight={highlightFor("Coinbase")}
                tag={tagFor("Coinbase")}
              />
            </CardContent>
          </Card>

          {/* Spread Card */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap className="h-4 w-4" /> Best Spread
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 flex flex-col gap-4">
              <div className="flex justify-between items-center">
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-muted-foreground uppercase">Route</span>
                  <div className="flex items-center gap-1.5">
                    {latestPriceData?.pair && (
                      <span className="text-[9px] font-mono font-bold px-1 border border-muted-foreground text-muted-foreground">{latestPriceData.pair}</span>
                    )}
                    <span className="font-mono text-sm leading-tight">{latestPriceData?.route || "—"}</span>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex flex-col items-end">
                  <span className="text-xs font-bold text-muted-foreground uppercase">Net Edge</span>
                  <div className={cn(
                    "font-mono text-2xl font-bold px-2 py-0.5 border-2",
                    hasEdge
                      ? "bg-success text-success-foreground border-transparent animate-pulse"
                      : "bg-muted text-muted-foreground border-border"
                  )}>
                    {netEdge != null ? `${netEdge.toFixed(3)}%` : "0.000%"}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs font-mono border-t-2 border-border pt-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Gross Spread</span>
                  <span>{latestPriceData?.grossSpreadPct.toFixed(3) ?? "—"}%</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Spread $</span>
                  <span className="font-bold">
                    {latestPriceData
                      ? `$${(latestPriceData.sellPrice - latestPriceData.buyPrice).toFixed(4)}`
                      : "—"}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Fees + Slip</span>
                  <span>{(settings.totalFees + settings.slippage).toFixed(2)}%</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Expected Profit</span>
                  {(() => {
                    const ep = netEdge != null && latestPriceData
                      ? (netEdge / 100) * latestPriceData.buyPrice * 1.0
                      : null;
                    return (
                      <span className={cn("font-bold", ep != null && ep >= settings.minProfitUsd ? "text-success" : "")}>
                        {ep != null ? `$${ep.toFixed(2)}` : "—"}
                      </span>
                    );
                  })()}
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Buy At</span>
                  <span className="text-success">${latestPriceData?.buyPrice.toFixed(4) ?? "—"}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Sell At</span>
                  <span className="text-primary">${latestPriceData?.sellPrice.toFixed(4) ?? "—"}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Balances */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <DollarSign className="h-4 w-4" /> Exchange Balances
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {cachedBalances ? (
                <div className="flex flex-col">
                  <div className="p-4 border-b-2 border-border flex justify-between items-center">
                    <span className="font-bold text-sm">Kraken SOL</span>
                    <span className="font-mono">{cachedBalances.solOnKraken?.toFixed(4) ?? "0.0000"}</span>
                  </div>
                  <div className="p-4 border-b-2 border-border flex justify-between items-center bg-muted/20">
                    <span className="font-bold text-sm">Coinbase SOL</span>
                    <span className="font-mono">{cachedBalances.solOnCoinbase?.toFixed(4) ?? "0.0000"}</span>
                  </div>
                  <div className="p-4 flex justify-between items-center bg-primary/5">
                    <span className="font-bold text-sm text-primary">Coinbase USD</span>
                    <span className="font-mono text-primary font-bold">${cachedBalances.usdOnCoinbase?.toFixed(2) ?? "0.00"}</span>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-sm font-mono text-muted-foreground">
                  {isRunning ? "Fetching balances…" : "Start bot to load balances"}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Status pill */}
          <Card className={cn(liveMode ? "border-destructive border-4" : "")}>
            <CardContent className="p-4 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm font-bold uppercase mb-2">
                {liveMode ? (
                  <><ShieldAlert className="h-4 w-4 text-destructive" /> WARNING: LIVE TRADING ACTIVE</>
                ) : (
                  <><ShieldAlert className="h-4 w-4 text-primary" /> DRY RUN MODE ACTIVE</>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="flex flex-col border-2 border-border p-2">
                  <span className="text-muted-foreground uppercase text-[10px]">Min Edge</span>
                  <span>{settings.minNetEdge}%</span>
                </div>
                <div className="flex flex-col border-2 border-border p-2">
                  <span className="text-muted-foreground uppercase text-[10px]">Min Profit</span>
                  <span>${settings.minProfitUsd.toFixed(2)}</span>
                </div>
                <div className="flex flex-col border-2 border-border p-2">
                  <span className="text-muted-foreground uppercase text-[10px]">Cooldown</span>
                  <span>{settings.cooldown}s</span>
                </div>
                <div className="flex flex-col border-2 border-border p-2">
                  <span className="text-muted-foreground uppercase text-[10px]">Poll</span>
                  <span>{settings.pollInterval}s</span>
                </div>
                <div className="flex flex-col border-2 border-border p-2">
                  <span className="text-muted-foreground uppercase text-[10px]">Fees+Slip</span>
                  <span>{settings.totalFees + settings.slippage}%</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Activity Log */}
        <div className="lg:col-span-2">
          <Card className="h-full flex flex-col">
            <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="h-4 w-4" /> System Log
              </CardTitle>
              <div className="flex items-center gap-3">
                {latestPriceData && (
                  <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
                    <TrendingUp className="h-3 w-3" />
                    {latestPriceData.wsStatus.kraken ? "K:WS" : "K:REST"} / {latestPriceData.wsStatus.coinbase ? "C:WS" : "C:REST"}
                  </div>
                )}
                {isRunning && <span className="flex h-2 w-2 rounded-full bg-success animate-pulse" />}
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 relative bg-black text-green-400 font-mono text-xs overflow-hidden h-[500px] lg:h-auto min-h-[500px]">
              <div className="absolute inset-0 overflow-y-auto p-4 flex flex-col gap-1">
                {activityLog.length === 0 ? (
                  <div className="text-green-800 italic">Waiting for events...</div>
                ) : (
                  activityLog.map((log) => (
                    <div key={log.id} className="flex gap-3 hover:bg-white/5 p-1 -mx-1 rounded">
                      <span className="text-green-600 shrink-0">[{format(new Date(log.timestamp), "HH:mm:ss")}]</span>
                      <span className={cn(
                        "break-words",
                        log.type === "error" ? "text-red-500 font-bold" :
                        log.type === "warning" ? "text-yellow-500" :
                        log.type === "success" ? "text-blue-400 font-bold" :
                        log.type === "trade" ? "text-white font-bold bg-green-700/30 px-1" :
                        "text-green-400"
                      )}>
                        {log.message}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Multi-Coin Opportunity Ranker */}
      <MultiCoinRankerCard settings={settings} />

      {/* Triangular Arb Opportunities */}
      <TriangularCard opportunities={triOpportunities} isRunning={isRunning} isExecutingTri={isExecutingTriangular} />
      <OrderBookHunterCard />

      {/* Trade History Table */}
      <TradeHistoryTable />
    </div>
  );
}

// ── Multi-Coin Opportunity Ranker ─────────────────────────────────────────────

function MultiCoinRankerCard({ settings }: { settings: { totalFees: number; slippage: number; minNetEdge: number } }) {
  const scanQuery = useScanAllPairs();
  // Refresh every 5 s independently of the bot poll loop
  useEffect(() => {
    const id = setInterval(() => { scanQuery.refetch(); }, 5_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const entries: PairScanEntry[] = scanQuery.data ?? [];
  const feesAndSlip = settings.totalFees + settings.slippage;

  // Annotate with net edge and sort descending (scan already sorted by gross; re-sort by net)
  const rows = entries
    .map(e => ({ ...e, netEdgePct: e.grossSpreadPct - feesAndSlip }))
    .sort((a, b) => b.netEdgePct - a.netEdgePct);

  const bestSol = rows.find(r => r.coin === "SOL");

  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Zap className="h-4 w-4" /> Multi-Coin Opportunity Ranker
          <span className="text-[9px] font-mono font-bold px-1 border border-primary text-primary">10 PAIRS</span>
          <span className="text-[10px] font-mono text-muted-foreground">Kraken ↔ Coinbase · ranked by net edge</span>
        </CardTitle>
        {scanQuery.isFetching && (
          <span className="text-[10px] font-mono text-muted-foreground flex items-center gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" /> scanning…
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {bestSol && (
          <div className={cn(
            "px-4 py-2 text-xs font-mono border-b border-border flex items-center gap-2",
            bestSol.netEdgePct >= settings.minNetEdge ? "bg-success/10 text-success" : "bg-muted/30 text-muted-foreground"
          )}>
            <ArrowRight className="h-3 w-3 shrink-0" />
            SOL Current Edge: <span className="font-bold">{bestSol.netEdgePct.toFixed(3)}%</span>
            <span className="text-muted-foreground">({bestSol.buyExchange} → {bestSol.sellExchange})</span>
            {bestSol.netEdgePct >= settings.minNetEdge && (
              <span className="ml-1 text-[9px] font-bold px-1 border border-success animate-pulse">EXECUTABLE</span>
            )}
          </div>
        )}
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm font-mono text-muted-foreground">
            {scanQuery.isLoading ? "Fetching prices for all 10 pairs…" : "Could not fetch multi-coin data."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  {["#", "Coin", "Route", "Kraken", "Coinbase", "Gross %", "Net %"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.pair} className={cn(
                    "border-b border-border/50",
                    i % 2 === 0 ? "" : "bg-muted/20",
                    row.coin === "SOL" && "ring-1 ring-inset ring-primary/30"
                  )}>
                    <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-1.5 font-bold">
                      {row.coin}
                      {row.coin === "SOL" && (
                        <span className="ml-1 text-[8px] font-bold px-0.5 border border-primary text-primary">BOT</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                      {row.buyExchange} → {row.sellExchange}
                    </td>
                    <td className="px-3 py-1.5">${row.krakenPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                    <td className="px-3 py-1.5">${row.coinbasePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{row.grossSpreadPct.toFixed(3)}%</td>
                    <td className={cn("px-3 py-1.5 font-bold", row.netEdgePct > 0 ? "text-success" : "text-destructive")}>
                      {row.netEdgePct >= 0 ? "+" : ""}{row.netEdgePct.toFixed(3)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Triangular Arb Card ────────────────────────────────────────────────────────

// ── v15 Order Book Hunter Card (Conservative) ──────────────────────────────────
const OB_STATUS_META: Record<string, { label: string; className: string }> = {
  READY:         { label: "✅ READY",         className: "text-success border-success" },
  HIGH_SLIPPAGE: { label: "⚠ HIGH SLIPPAGE", className: "text-amber-500 border-amber-500" },
  LOW_PROFIT:    { label: "✕ LOW PROFIT",    className: "text-muted-foreground border-border" },
};

function OrderBookHunterCard() {
  const { data, isLoading } = useGetObScan(10, 0.5, 0.01, 0.5, {
    query: { queryKey: getObScanQueryKey(10, 0.5, 0.01, 0.5), refetchInterval: 5_000, staleTime: 4_000 },
  });

  const cycles: ObCycleEntry[] = data?.cycles ?? [];

  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <BookOpen className="h-4 w-4" /> Order Book Hunter
          <span className="text-[10px] font-mono text-muted-foreground font-normal">
            v15 · Conservative · $10 · 30 cycles
          </span>
          {data && data.readyCount > 0 && (
            <span className="text-[9px] font-mono font-bold px-1 border border-success text-success animate-pulse">
              {data.readyCount} READY
            </span>
          )}
        </CardTitle>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
          {isLoading && <RefreshCw className="h-3 w-3 animate-spin" />}
          {data && `${data.pairsScanned}/${data.pairsRequested} pairs · ${data.cycles.length} cycles ranked`}
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {cycles.length === 0 ? (
          <div className="p-6 text-center text-sm font-mono text-muted-foreground">
            {isLoading
              ? "Fetching order books…"
              : data && data.pairsScanned === 0
                ? "⚠ Market data unavailable — could not reach Kraken order books"
                : "No simulatable cycles (insufficient order book depth at this trade size)"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  {["#", "Route", "Net Profit", "Profit %", "Slippage", "Status", "Vol A"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cycles.map((c, i) => {
                  const meta = OB_STATUS_META[c.status] ?? OB_STATUS_META["LOW_PROFIT"]!;
                  return (
                    <tr key={`${c.route}-${i}`} className={cn(
                      "border-b border-border/50",
                      c.status === "READY" ? "bg-success/10" : i % 2 === 0 ? "" : "bg-muted/20",
                    )}>
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5 font-bold text-foreground whitespace-nowrap">{c.route}</td>
                      <td className={cn("px-3 py-1.5 font-bold", c.estimatedProfitUsd > 0 ? "text-success" : "text-destructive")}>
                        ${c.estimatedProfitUsd.toFixed(4)}
                      </td>
                      <td className={cn("px-3 py-1.5", c.profitPct > 0 ? "text-success" : "text-destructive")}>
                        {c.profitPct.toFixed(3)}%
                      </td>
                      <td className={cn("px-3 py-1.5", c.slippagePct > (data?.maxSlippagePct ?? 0.5) ? "text-amber-500" : "text-muted-foreground")}>
                        {c.slippagePct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={cn("text-[9px] font-bold px-1 border whitespace-nowrap", meta.className)}>{meta.label}</span>
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {c.volumeA < 0.01 ? c.volumeA.toFixed(6) : c.volumeA.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data && (
              <div className="px-3 py-2 text-[10px] font-mono text-muted-foreground border-t border-border/50">
                Trade size: ${data.tradeSizeUsd} · Fees: {data.feesPct}% · Min profit: ${data.minProfitUsd} · Max slippage: {data.maxSlippagePct}% · Scanned: {format(new Date(data.scannedAt), "HH:mm:ss")}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TriangularCard({
  opportunities,
  isRunning,
  isExecutingTri,
}: {
  opportunities: Array<{ exchange: string; loop: string; profitPct: number; solUsd: number; ethUsd: number; ethSol: number; variant?: string; timestamp: string }>;
  isRunning: boolean;
  isExecutingTri?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <RefreshCw className={cn("h-4 w-4", isExecutingTri && "animate-spin text-yellow-500")} />
          Triangular Arbitrage
          <span className="text-[9px] font-mono font-bold px-1 border border-primary text-primary">TRI</span>
          <span className="text-[10px] font-mono text-muted-foreground">Same-exchange loops</span>
          {isExecutingTri && (
            <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500 border border-yellow-500/50 animate-pulse">
              EXECUTING
            </span>
          )}
        </CardTitle>
        {isRunning && !isExecutingTri && (
          <span className="text-[10px] font-mono text-muted-foreground">scanning…</span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {opportunities.length === 0 ? (
          <div className="p-6 text-center text-sm font-mono text-muted-foreground">
            {isRunning
              ? "No triangular opportunities detected (net profit > 0.1% threshold)"
              : "Start bot to begin scanning for triangular loops"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  {["Tag", "Exchange", "Loop", "Net Profit", "SOL/USD", "Other/USD", "Cross Rate", "Detected"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {opportunities.map((opp, i) => {
                  const isBtc = opp.variant === "btc";
                  return (
                    <tr key={`${opp.exchange}-${opp.loop}-${i}`} className={cn(
                      "border-b border-border/50",
                      i % 2 === 0 ? "" : "bg-muted/20",
                    )}>
                      <td className="px-3 py-1.5">
                        <span className={cn(
                          "text-[9px] font-mono font-bold px-1 border",
                          isBtc ? "border-yellow-500 text-yellow-500" : "border-success text-success"
                        )}>{isBtc ? "BTC" : "ETH"}</span>
                      </td>
                      <td className="px-3 py-1.5 font-bold">{opp.exchange}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{opp.loop}</td>
                      <td className={cn("px-3 py-1.5 font-bold", opp.profitPct > 0 ? "text-success animate-pulse" : "")}>
                        +{opp.profitPct.toFixed(3)}%
                      </td>
                      <td className="px-3 py-1.5">${opp.solUsd.toFixed(4)}</td>
                      <td className="px-3 py-1.5">
                        <span className="text-[9px] text-muted-foreground mr-1">{isBtc ? "BTC" : "ETH"}</span>
                        ${opp.ethUsd.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="text-[9px] text-muted-foreground mr-1">{isBtc ? "SOL/BTC" : "ETH/SOL"}</span>
                        {isBtc ? opp.ethSol.toFixed(6) : opp.ethSol.toFixed(4)}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{format(new Date(opp.timestamp), "HH:mm:ss")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TradeHistoryTable() {
  const tradesQuery = useListTrades({ limit: 50 });
  const trades: TradeRecord[] = tradesQuery.data ?? [];

  return (
    <Card className="mt-6">
      <CardHeader className="py-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> Trade History
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {trades.length === 0 ? (
          <div className="p-8 text-center text-sm font-mono text-muted-foreground">No trades recorded yet.</div>
        ) : (
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="border-b-2 border-border bg-muted/50">
                {["Time","Trade ID","Pair","Buy","Sell","Volume","Buy Price","Sell Price","Profit","Order IDs"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => {
                const profit = t.estimatedProfitUsd;
                const buyPrice = t.buyExchange === "Kraken" ? t.krakenPrice : t.coinbasePrice;
                const sellPrice = t.sellExchange === "Kraken" ? t.krakenPrice : t.coinbasePrice;
                return (
                  <tr key={t.id} className={cn("border-b border-border/50", i % 2 === 0 ? "" : "bg-muted/20")}>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{format(new Date(t.createdAt), "MM/dd HH:mm:ss")}</td>
                    <td className="px-3 py-1.5 font-bold">#{t.id}</td>
                    <td className="px-3 py-1.5">
                      <span className="text-[9px] font-mono font-bold px-1 border border-border text-muted-foreground">{t.pair ?? "SOL/USD"}</span>
                    </td>
                    <td className="px-3 py-1.5 text-success font-bold">{t.buyExchange}</td>
                    <td className="px-3 py-1.5 text-primary font-bold">{t.sellExchange}</td>
                    <td className="px-3 py-1.5">{Number(t.volumeSol).toFixed(4)} SOL</td>
                    <td className="px-3 py-1.5">${Number(buyPrice).toFixed(4)}</td>
                    <td className="px-3 py-1.5">${Number(sellPrice).toFixed(4)}</td>
                    <td className={cn("px-3 py-1.5 font-bold", profit >= 0 ? "text-success" : "text-destructive")}>
                      {profit >= 0 ? "+" : ""}${profit.toFixed(4)}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground max-w-[160px] truncate">
                      {[t.buyOrderId, t.sellOrderId].filter(Boolean).join(" / ") || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
