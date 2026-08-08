import React, { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext, ALL_PAIRS } from "@/store/bot-context";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Activity, Play, Square, DollarSign, TrendingUp, Zap, ShieldAlert,
  FileText, ArrowRight, Radio, Wifi, WifiOff, Siren, RefreshCw, BookOpen,
  Repeat2, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useGetTradeSummary, useListTrades, useScanAllPairs, useGetObScan, getGetObScanQueryKey, useObExecute, useGetAllPairSnapshots, getGetAllPairSnapshotsQueryKey, useGetGraphScan, getGetGraphScanQueryKey, useGraphExecute, useGetFeeTier, getGetFeeTierQueryKey, useGetExecutionQuality, getGetExecutionQualityQueryKey, useGetExecutionStatus, getGetExecutionStatusQueryKey, useGetAccountPnl, getGetAccountPnlQueryKey, useGetInventoryScan, getGetInventoryScanQueryKey, useInventoryExecute, TradeRecord, PairScanEntry, ObCycleEntry, AllPairSnapshot, GraphRoute, GraphRouteHop, InventoryOpportunity, InventoryRebalanceAlert } from "@workspace/api-client-react";

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
    triOpportunities, triPriceSource,
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

  // ── Best pair for Force Trade indicator ──────────────────────────────────────
  // Mirrors the ranker logic: fetch all enabled pairs, sort by net edge descending,
  // pick #1. Refreshes every 5 s independently of the bot poll loop.
  const enabledPairsForScan = settings.enabledPairs?.length > 0 ? settings.enabledPairs : undefined;
  const forceScanQuery = useScanAllPairs({ enabledPairs: enabledPairsForScan });
  useEffect(() => {
    const id = setInterval(() => { forceScanQuery.refetch(); }, 5_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const feesAndSlip = settings.totalFees + settings.slippage;
  const bestForcePair = React.useMemo(() => {
    const entries = forceScanQuery.data ?? [];
    if (entries.length === 0) return null;
    const sorted = [...entries]
      .filter(e => e.grossSpreadPct != null)
      .sort((a, b) => (b.grossSpreadPct - feesAndSlip) - (a.grossSpreadPct - feesAndSlip));
    return sorted[0] ?? null;
  }, [forceScanQuery.data, feesAndSlip]);

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
              Realized P&L (Verified) · {summaryQuery.data?.verifiedTrades ?? 0} verified fills
            </span>
            <span className={cn(
              "text-xl font-mono font-bold leading-none",
              (summaryQuery.data?.realizedPnlUsd ?? 0) > 0 ? "text-success" :
              (summaryQuery.data?.realizedPnlUsd ?? 0) < 0 ? "text-destructive" : ""
            )} data-testid="text-realized-pnl">
              {(summaryQuery.data?.realizedPnlUsd ?? 0) >= 0 ? "+" : "-"}$
              {Math.abs(summaryQuery.data?.realizedPnlUsd ?? 0).toFixed(2)}
            </span>
            {sessionProfitUsd !== 0 && (
              <span className="text-[10px] font-mono text-muted-foreground">
                session: {sessionProfitUsd >= 0 ? "+" : "-"}${Math.abs(sessionProfitUsd).toFixed(2)}
              </span>
            )}
          </div>

          {/* Force Trade — live mode only */}
          {liveMode && (
            <div className="flex flex-col items-center gap-1">
              <Button
                variant="outline"
                size="lg"
                className="border-2 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground font-bold uppercase"
                onClick={forceTrade}
                disabled={isForcingTrade}
                title={
                  bestForcePair
                    ? `Rescans, then trades ${bestForcePair.pair} if net edge clears your minimum · net edge ${(bestForcePair.grossSpreadPct - feesAndSlip) >= 0 ? "+" : ""}${(bestForcePair.grossSpreadPct - feesAndSlip).toFixed(3)}% (gross ${bestForcePair.grossSpreadPct >= 0 ? "+" : ""}${bestForcePair.grossSpreadPct.toFixed(3)}% − ${feesAndSlip.toFixed(2)}% fees+slip)`
                    : "Rescans all pairs, fetches a fresh quote, then trades only if net edge clears your minimum"
                }
              >
                <Siren className="h-4 w-4 mr-2" />
                {isForcingTrade ? "EXECUTING..." : "FORCE SCAN & TRADE"}
              </Button>
              <span className="text-[10px] font-mono text-muted-foreground leading-none">
                {bestForcePair
                  ? <>Best: <span className="font-bold text-foreground">{bestForcePair.pair}</span> <span className={cn((bestForcePair.grossSpreadPct - feesAndSlip) >= 0 ? "text-success" : "text-destructive")}>{(bestForcePair.grossSpreadPct - feesAndSlip) >= 0 ? "+" : ""}{(bestForcePair.grossSpreadPct - feesAndSlip).toFixed(3)}% net</span></>
                  : <span className="italic">SOL/USD (fallback)</span>
                }
              </span>
            </div>
          )}

          {/* Force Triangular — live mode only, $10 BTC/SOL test loop.
              Blocked when the ETH/SOL leg is priced from a synthetic cross-rate
              (ETH/USD ÷ SOL/USD): spread errors compound across three legs, so
              the profit estimate is too unreliable for live orders. Dry-run mode
              is unaffected — this button only renders in live mode. */}
          {liveMode && (() => {
            const krakenSynthetic = triPriceSource.kraken === "synthetic";
            return (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Button
                        variant="outline"
                        size="lg"
                        className="border-2 border-yellow-500 text-yellow-600 hover:bg-yellow-500 hover:text-white font-bold uppercase"
                        onClick={forceTriangular}
                        disabled={isForcingTriangular || krakenSynthetic}
                      >
                        <RefreshCw className={cn("h-4 w-4 mr-2", isForcingTriangular && "animate-spin")} />
                        {isForcingTriangular ? "TRI FIRING..." : "FORCE TRI"}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[240px]">
                    {krakenSynthetic
                      ? "Blocked: ETH/SOL direct market unavailable on Kraken — prices are estimated from a cross-rate (ETH/USD ÷ SOL/USD) and may be imprecise. Live triangular trades are disabled until the direct market returns."
                      : "Fire best BTC/SOL/USD loop on Kraken with $10 test — 3 market orders"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })()}

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
                  {(() => {
                    // Show base-asset balance when the active pair differs from SOL/USD.
                    // Falls back to SOL fields when no pair-specific data is available.
                    const baseAsset = cachedBalances.baseAsset ?? "SOL";
                    const isNonSol = baseAsset !== "SOL";
                    const krakenAmt = isNonSol
                      ? (cachedBalances.baseAssetOnKraken ?? 0)
                      : (cachedBalances.solOnKraken ?? 0);
                    const coinbaseAmt = isNonSol
                      ? (cachedBalances.baseAssetOnCoinbase ?? 0)
                      : (cachedBalances.solOnCoinbase ?? 0);
                    const precision = baseAsset === "BTC" ? 6 : 4;
                    return (
                      <>
                        <div className="p-4 border-b-2 border-border flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="font-bold text-sm">Kraken {baseAsset}</span>
                            {isNonSol && cachedBalances.solOnKraken != null && (
                              <span className="text-[10px] font-mono text-muted-foreground">SOL: {cachedBalances.solOnKraken.toFixed(4)}</span>
                            )}
                          </div>
                          <span className="font-mono">{krakenAmt.toFixed(precision)}</span>
                        </div>
                        <div className="p-4 border-b-2 border-border flex justify-between items-center bg-muted/20">
                          <div className="flex flex-col">
                            <span className="font-bold text-sm">Coinbase {baseAsset}</span>
                            {isNonSol && cachedBalances.solOnCoinbase != null && (
                              <span className="text-[10px] font-mono text-muted-foreground">SOL: {cachedBalances.solOnCoinbase.toFixed(4)}</span>
                            )}
                          </div>
                          <span className="font-mono">{coinbaseAmt.toFixed(precision)}</span>
                        </div>
                      </>
                    );
                  })()}
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
              {(() => {
                const filtered = settings.enabledPairs.length < ALL_PAIRS.length;
                return (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className={cn(
                          "flex items-center gap-1.5 cursor-default mb-1 px-2 py-1 border-2 w-fit",
                          filtered
                            ? "border-yellow-500/60 bg-yellow-500/5"
                            : "border-border bg-muted/20",
                        )}>
                          <span className={cn(
                            "text-[10px] font-mono font-bold uppercase",
                            filtered ? "text-yellow-600" : "text-muted-foreground",
                          )}>
                            Watching {settings.enabledPairs.length}/{ALL_PAIRS.length} pairs
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[180px]">
                        <p className="font-bold mb-1 text-[10px] uppercase tracking-wide">Active pairs</p>
                        <ul className="flex flex-col gap-0.5">
                          {settings.enabledPairs.map((p) => (
                            <li key={p} className="font-mono text-[11px]">{p}</li>
                          ))}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })()}
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
                  <span>{(settings.totalFees + settings.slippage).toFixed(2)}%</span>
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
                    {latestPriceData.wsStatus.kraken ? "K:WS" : "K:REST·fallback"} / {latestPriceData.wsStatus.coinbase ? "C:REST·2s" : "C:STALE"}
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

      {/* All-Pairs Breakdown */}
      <AllPairsCard activePair={latestPriceData?.pair ?? null} feesAndSlipPct={settings.totalFees + settings.slippage} enabledPairs={enabledPairsForScan} />

      {/* Multi-Coin Opportunity Ranker */}
      <MultiCoinRankerCard settings={settings} />

      {/* Triangular Arb Opportunities */}
      {/* Inventory Mode Opportunities — shown only when the feature is toggled on in Config */}
      {settings.inventoryModeEnabled && <InventoryCard />}

      <TriangularCard opportunities={triOpportunities} isRunning={isRunning} isExecutingTri={isExecutingTriangular} priceSource={triPriceSource} />
      <OrderBookHunterCard />
      <GraphEngineCard />
      <RealizedPnlCard />
      <ExecutionQualityCard />

      {/* Trade History Table */}
      <TradeHistoryTable />
    </div>
  );
}

// ── All-Pairs Breakdown Card ───────────────────────────────────────────────────

function AllPairsCard({ activePair, feesAndSlipPct, enabledPairs }: { activePair: string | null; feesAndSlipPct: number; enabledPairs?: string[] }) {
  const query = useGetAllPairSnapshots({ enabledPairs }, {
    query: {
      queryKey: getGetAllPairSnapshotsQueryKey({ enabledPairs }),
      refetchInterval: 5_000,
      staleTime: 4_000,
    },
  });

  const rows: AllPairSnapshot[] = query.data ?? [];

  const bestPair = rows.find(r => r.grossSpreadPct != null)?.pair ?? null;
  const highlightedPair = activePair ?? bestPair;

  const fmt = (v: number | null | undefined, decimals = 4) =>
    v != null ? `$${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}` : "—";

  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Radio className="h-4 w-4" /> All Pairs
          <span className="text-[9px] font-mono font-bold px-1 border border-primary text-primary">10 PAIRS</span>
          <span className="text-[10px] font-mono text-muted-foreground">Live bid/ask · sorted by spread</span>
        </CardTitle>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
          {query.isFetching && <RefreshCw className="h-3 w-3 animate-spin" />}
          {rows.length > 0 && `${rows.filter(r => r.grossSpreadPct != null).length}/${rows.length} pairs live`}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm font-mono text-muted-foreground">
            {query.isLoading ? "Fetching price snapshots…" : "Price data unavailable."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  {["#", "Pair", "Kraken Bid", "Kraken Ask", "Coinbase Bid", "Coinbase Ask", "Spread %", "Net Edge %", "Route"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const isActive = row.pair === highlightedPair;
                  const hasData  = row.grossSpreadPct != null;
                  return (
                    <tr
                      key={row.pair}
                      className={cn(
                        "border-b border-border/50",
                        isActive && hasData
                          ? "bg-primary/10 ring-1 ring-inset ring-primary/40"
                          : i % 2 === 0 ? "" : "bg-muted/20",
                        !hasData && "opacity-50",
                      )}
                    >
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5 font-bold whitespace-nowrap">
                        {row.coin}
                        {isActive && hasData && (
                          <span className="ml-1 text-[8px] font-bold px-0.5 border border-primary text-primary">BEST</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{fmt(row.krakenBid)}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{fmt(row.krakenAsk)}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{fmt(row.coinbaseBid)}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{fmt(row.coinbaseAsk)}</td>
                      <td className={cn(
                        "px-3 py-1.5 font-bold",
                        row.grossSpreadPct == null
                          ? "text-muted-foreground"
                          : row.grossSpreadPct > 0
                            ? "text-success"
                            : "text-destructive",
                      )}>
                        {row.grossSpreadPct != null ? `${row.grossSpreadPct >= 0 ? "+" : ""}${row.grossSpreadPct.toFixed(3)}%` : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-1.5 font-bold",
                          row.grossSpreadPct == null
                            ? "text-muted-foreground"
                            : row.grossSpreadPct - feesAndSlipPct > 0
                              ? "text-success"
                              : "text-destructive",
                        )}
                        title={`Gross spread minus fees + slippage (${feesAndSlipPct.toFixed(2)}%) — what you'd actually keep`}
                      >
                        {row.grossSpreadPct != null
                          ? `${row.grossSpreadPct - feesAndSlipPct >= 0 ? "+" : ""}${(row.grossSpreadPct - feesAndSlipPct).toFixed(3)}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                        {row.buyExchange != null
                          ? `${row.buyExchange} → ${row.buyExchange === "Kraken" ? "Coinbase" : "Kraken"}`
                          : "—"}
                      </td>
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

// ── Multi-Coin Opportunity Ranker ─────────────────────────────────────────────

function MultiCoinRankerCard({ settings }: { settings: { totalFees: number; slippage: number; minNetEdge: number; enabledPairs?: string[] } }) {
  const enabledPairs = settings.enabledPairs && settings.enabledPairs.length > 0 ? settings.enabledPairs : undefined;
  const scanQuery = useScanAllPairs({ enabledPairs });
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

// ── Inventory Mode Card ───────────────────────────────────────────────────────
// Cross-exchange inventory arb: buy on the cheap venue, sell from existing
// inventory on the expensive venue — no inter-exchange transfer needed.

function InventoryCard() {
  const { credentials, liveMode, settings, addLog } = useBotContext();
  const executeMutation = useInventoryExecute();
  const [execResult, setExecResult] = useState<string | null>(null);
  const [executingAsset, setExecutingAsset] = useState<string | null>(null);

  const krakenFeesPct   = 0.16;
  const coinbaseFeesPct = 0.40;

  // Public bid/ask scan — no credentials in query params (avoids URL logging).
  // Rebalance alerts (balance-dependent) are returned only when optional creds
  // are passed; omitting them here is intentional: the execute endpoint handles
  // everything that requires live credentials.
  const scanParams = {
    assets: (settings.inventoryAssets ?? ["BTC", "ETH", "SOL"]).join(","),
    krakenFeesPct,
    coinbaseFeesPct,
    tradeSizeUsd: settings.inventoryTradeSizeUsd ?? 10,
    targetPct: settings.inventoryTargetPct ?? 50,
  };

  const { data, isFetching, refetch } = useGetInventoryScan(scanParams, {
    query: {
      queryKey: getGetInventoryScanQueryKey(scanParams),
      refetchInterval: 10_000,
      staleTime: 9_000,
    },
  });

  const opportunities: InventoryOpportunity[] = data?.opportunities ?? [];
  const rebalanceAlerts: InventoryRebalanceAlert[] = data?.rebalanceAlerts ?? [];
  const topOpportunity = opportunities.find(o => o.meetsThreshold) ?? opportunities[0] ?? null;

  const doExecute = async (opp: InventoryOpportunity) => {
    setExecResult(null);
    setExecutingAsset(opp.asset);
    const isDryRun = !liveMode;
    const tag = isDryRun ? "[INV·DRY]" : "[INV·LIVE]";
    addLog("trade", `${tag} ${opp.asset}: ${opp.buyExchange}→${opp.sellExchange} | net ${opp.netSpreadPct.toFixed(3)}% | $${settings.inventoryTradeSizeUsd} — executing…`);
    try {
      const r = await executeMutation.mutateAsync({
        data: {
          krakenKey: credentials.krakenKey ?? "",
          krakenSecret: credentials.krakenSecret ?? "",
          coinbaseKey: credentials.coinbaseKey ?? undefined,
          coinbaseSecret: credentials.coinbaseSecret ?? undefined,
          asset: opp.asset,
          tradeSizeUsd: settings.inventoryTradeSizeUsd ?? 10,
          minProfitUsd: 0.01,
          krakenFeesPct,
          coinbaseFeesPct,
          isDryRun,
        },
      });
      if (r.success && r.executed) {
        const profit = r.realizedProfitUsd ?? r.estimatedNetProfitUsd;
        addLog("success", `${tag} ✅ ${r.asset} | $${profit.toFixed(4)}${r.isDryRun ? " (dry run)" : ` | buy:${r.buyOrderId} sell:${r.sellOrderId}`}`);
        setExecResult(`✅ ${r.asset}: buy on ${r.buyExchange}, sell on ${r.sellExchange} — net $${profit.toFixed(4)}${r.isDryRun ? " (dry run)" : ""}`);
        refetch();
      } else {
        addLog("warning", `${tag} ❌ ${r.error ?? "Pre-flight failed."}`);
        setExecResult(`❌ ${r.error ?? "Pre-flight failed — edge disappeared."}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      addLog("error", `${tag} Exception: ${msg}`);
      setExecResult(`❌ ${msg}`);
    } finally {
      setExecutingAsset(null);
    }
  };

  return (
    <Card className="border-2 border-primary/40">
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Repeat2 className="h-4 w-4 text-primary" />
          Inventory Arb
          <span className="text-[9px] font-mono font-bold px-1 border border-primary text-primary">CROSS-EXCHANGE</span>
          <span className="text-[10px] font-mono text-muted-foreground">buy cheap · sell expensive · no transfer</span>
        </CardTitle>
        <div className="flex items-center gap-2">
          {isFetching && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
          <span className={cn(
            "text-[9px] font-mono font-bold px-1 border",
            liveMode ? "text-destructive border-destructive" : "text-muted-foreground border-border"
          )}>{liveMode ? "LIVE" : "DRY RUN"}</span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {/* Rebalance alerts (only shown when creds provided to scan) */}
        {rebalanceAlerts.length > 0 && (
          <div className="flex flex-col gap-1 px-4 py-3 border-b border-border">
            {rebalanceAlerts.map((alert) => (
              <div
                key={`${alert.asset}-${alert.exchange}`}
                className={cn(
                  "flex items-start gap-2 text-xs font-mono px-2 py-1 border",
                  alert.alertLevel === "critical"
                    ? "border-destructive bg-destructive/10 text-destructive"
                    : "border-yellow-500 bg-yellow-500/10 text-yellow-600"
                )}
              >
                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>{alert.message}</span>
                <span className="ml-auto text-[10px] text-muted-foreground whitespace-nowrap">
                  K:{alert.krakenPct.toFixed(0)}% CB:{alert.coinbasePct.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Opportunity table */}
        {opportunities.length === 0 ? (
          <div className="p-6 text-center text-sm font-mono text-muted-foreground">
            {isFetching ? "Scanning inventory opportunities…" : "No opportunities found. Enable more assets in Config → Inventory Mode."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  {["Asset", "K Bid", "K Ask", "CB Bid", "CB Ask", "Gross %", "Net %", "Est. Profit", "Route", ""].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {opportunities.map((opp) => {
                  const isTop = opp === topOpportunity;
                  const isExec = executingAsset === opp.asset;
                  return (
                    <tr
                      key={opp.asset}
                      className={cn(
                        "border-b border-border/50",
                        opp.meetsThreshold && isTop && "bg-success/5 ring-1 ring-inset ring-success/30",
                        !opp.meetsThreshold && "opacity-60",
                      )}
                    >
                      <td className="px-3 py-2 font-bold">
                        {opp.asset}
                        {opp.meetsThreshold && <span className="ml-1 text-[8px] font-bold px-0.5 border border-success text-success animate-pulse">✓</span>}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">${opp.krakenBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">${opp.krakenAsk.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">${opp.coinbaseBid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">${opp.coinbaseAsk.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                      <td className={cn("px-3 py-1.5 font-bold", opp.grossSpreadPct > 0 ? "text-success" : "text-destructive")}>
                        {opp.grossSpreadPct >= 0 ? "+" : ""}{opp.grossSpreadPct.toFixed(3)}%
                      </td>
                      <td className={cn("px-3 py-1.5 font-bold", opp.netSpreadPct > 0 ? "text-success" : "text-destructive")}>
                        {opp.netSpreadPct >= 0 ? "+" : ""}{opp.netSpreadPct.toFixed(3)}%
                      </td>
                      <td className={cn("px-3 py-1.5 font-bold", opp.estimatedNetProfitUsd > 0 ? "text-success" : "text-destructive")}>
                        ${opp.estimatedNetProfitUsd.toFixed(4)}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                        {opp.buyExchange} → {opp.sellExchange}
                      </td>
                      <td className="px-3 py-1.5">
                        <Button
                          size="sm"
                          variant={opp.meetsThreshold ? "default" : "outline"}
                          className="h-6 px-2 text-[10px] font-bold"
                          disabled={isExec || executeMutation.isPending}
                          onClick={() => doExecute(opp)}
                        >
                          {isExec ? <RefreshCw className="h-3 w-3 animate-spin" /> : <><Play className="h-3 w-3 mr-1" />EXEC</>}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Execute result banner */}
        {execResult && (
          <div className={cn(
            "mx-4 mt-3 mb-3 px-3 py-2 border-2 text-xs font-mono flex items-start gap-2",
            execResult.startsWith("✅") ? "border-success bg-success/5 text-success" : "border-destructive bg-destructive/5 text-destructive"
          )}>
            {execResult.startsWith("✅")
              ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            }
            {execResult}
          </div>
        )}

        <div className="px-4 py-2 border-t border-border flex items-center gap-2 text-[10px] font-mono text-muted-foreground flex-wrap">
          <span>Threshold: spread &gt; 2× fees (K {krakenFeesPct}% + CB {coinbaseFeesPct}%)</span>
          <span>·</span>
          <span>Size: ${settings.inventoryTradeSizeUsd ?? 10}</span>
          {data?.scannedAt && (
            <><span>·</span><span className="ml-auto">scanned {new Date(data.scannedAt).toLocaleTimeString()}</span></>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Triangular Arb Card ────────────────────────────────────────────────────────

/** Profit must be ≥ this fraction of trade size to execute without a warning (0.1%). */
const THIN_EDGE_PCT = 0.001;

// ── v15 Order Book Hunter Card (Conservative) ──────────────────────────────────
const OB_STATUS_META: Record<string, { label: string; className: string }> = {
  READY:         { label: "✅ READY",         className: "text-success border-success" },
  HIGH_SLIPPAGE: { label: "⚠ HIGH SLIPPAGE", className: "text-amber-500 border-amber-500" },
  LOW_PROFIT:    { label: "✕ LOW PROFIT",    className: "text-muted-foreground border-border" },
};

const OB_SCALING_META: Record<string, { label: string; className: string }> = {
  VIABLE:        { label: "✅ VIABLE",        className: "text-success border-success" },
  HIGH_SLIPPAGE: { label: "⚠ HIGH SLIPPAGE", className: "text-amber-500 border-amber-500" },
  REJECTED:      { label: "✕ REJECTED",      className: "text-muted-foreground border-border" },
};

/**
 * Actual Kraken taker fee (percent per leg) for the account, or null when
 * unavailable (no creds / lookup failed). One cached lookup shared by all
 * cards; refreshed every 10 min.
 */
function useActualKrakenFees(): { taker: number | null; maker: number | null } {
  const { credentials } = useBotContext();
  const hasCreds = !!credentials.krakenKey && !!credentials.krakenSecret;
  const { data } = useGetFeeTier(
    { krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret },
    { query: { queryKey: getGetFeeTierQueryKey({ krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret }), enabled: hasCreds, staleTime: 10 * 60_000, refetchInterval: 10 * 60_000 } },
  );
  return { taker: data?.takerFeePct ?? null, maker: data?.makerFeePct ?? null };
}

function OrderBookHunterCard() {
  const { credentials, liveMode, addLog, settings, isRunning, isAutoExecutingOb, lastObAutoTrade } = useBotContext();
  const executeMutation = useObExecute();
  const [execResult, setExecResult] = useState<string | null>(null);
  const [thinEdgePending, setThinEdgePending] = useState(false);
  const [tradeSizeInput, setTradeSizeInput] = useState(String(settings.obTradeSize));
  // Debounce so we don't fire a Kraken scan on every keystroke (e.g. 10→1→100)
  const [debouncedSize, setDebouncedSize] = useState(String(settings.obTradeSize));
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSize(tradeSizeInput), 500);
    return () => clearTimeout(t);
  }, [tradeSizeInput]);
  // Sync back whenever the setting changes externally (e.g. trader updates
  // OB Trade Size in Config and returns to the dashboard).
  useEffect(() => {
    setTradeSizeInput(String(settings.obTradeSize));
    setDebouncedSize(String(settings.obTradeSize));
  }, [settings.obTradeSize, settings.obFeesPct]);
  const tradeSize = Math.max(1, parseFloat(debouncedSize) || settings.obTradeSize);
  // Min-profit floor: seeded from settings.minProfitUsd so it matches the
  // auto-execute threshold that the bot loop uses.
  const [minProfitInput, setMinProfitInput] = useState(String(settings.minProfitUsd));
  const minProfit = Math.max(0, parseFloat(minProfitInput) || 0);
  // Fee per leg: prefer the account's ACTUAL Kraken taker fee tier (fetched
  // once, shared across cards) over the configured assumption. A 0.40%
  // assumption makes a 1.2% 3-leg hurdle that hides every real edge.
  const actualFee = useActualKrakenFees().taker;
  const effectiveFeePct = actualFee ?? settings.obFeesPct;
  // Persisted so a trader's preference survives page refreshes. The hook
  // reads localStorage synchronously in its initializer, so the saved value
  // is applied before the first scan query fires.
  const [volatilityFilter, setVolatilityFilter] = useLocalStorage<boolean>("ob-volatility-filter", true);
  const obParams = { tradeSizeUsd: tradeSize, feesPct: effectiveFeePct, minProfitUsd: 0.02, maxSlippagePct: 0.5, volatilityFilter };
  const { data, isLoading } = useGetObScan(obParams, {
    query: { queryKey: getGetObScanQueryKey(obParams), refetchInterval: 5_000, staleTime: 4_000 },
  });

  const cycles: ObCycleEntry[] = data?.cycles ?? [];
  // Execute targets the top 3-LEG route only — the live OB executor places
  // exactly three orders from (assetA, assetB); firing it on a 4-leg route
  // would silently skip the middle hop. 4-leg routes are display/ranking only.
  const topCycle = cycles.find(c => (c.legs ?? 3) === 3);
  // Execution gate: fresh profit after real fees must clear the min-profit
  // floor. The button stays clickable whenever a route exists — the server
  // pre-flight is the real guard.
  const topBelowThreshold = !!topCycle && topCycle.estimatedProfitUsd <= minProfit;
  const canExecute = !!topCycle && !executeMutation.isPending;

  const doExecuteObRoute = async () => {
    if (!topCycle) return;
    setThinEdgePending(false);
    setExecResult(null);
    addLog("trade", `[OB·EXEC] ${topCycle.route} | $${tradeSize} | ${liveMode ? "LIVE" : "dry run"} — pre-flight…`);
    try {
      const r = await executeMutation.mutateAsync({
        data: {
          krakenKey: credentials.krakenKey,
          krakenSecret: credentials.krakenSecret,
          assetA: topCycle.assetA,
          assetB: topCycle.assetB,
          tradeSizeUsd: tradeSize,
          feesPct: settings.obFeesPct, // fallback only — server uses your actual Kraken fee tier
          minProfitUsd: minProfit,
          isDryRun: !liveMode,
        },
      });
      if (r.success && r.executed) {
        const profit = r.preflightProfitUsd ?? 0;
        addLog("success", `[OB·EXEC] ✅ ${r.route} | profit $${profit.toFixed(4)}${r.isDryRun ? " (dry run)" : ` | orders ${[r.leg1OrderId, r.leg2OrderId, r.leg3OrderId].filter(Boolean).join(", ")}`}`);
        setExecResult(`✅ Executed ${r.route} — $${profit.toFixed(4)}${r.isDryRun ? " (dry run, recorded to ledger)" : ""}`);
      } else {
        addLog("warning", `[OB·EXEC] ❌ ${r.error ?? "Pre-flight failed."}`);
        setExecResult(`❌ ${r.error ?? "Pre-flight failed — edge disappeared."}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      addLog("error", `[OB·EXEC] Exception: ${msg}`);
      setExecResult(`❌ ${msg}`);
    }
  };

  const executeTopRoute = async () => {
    if (!topCycle) return;
    if (!credentials.krakenKey || !credentials.krakenSecret) {
      addLog("warning", "[OB·EXEC] Add Kraken credentials in Config first.");
      setExecResult("❌ No Kraken credentials — add them in Config.");
      return;
    }
    // In live mode, warn when profit is below the thin-edge safety margin (< 0.1% of trade size).
    // Dry runs bypass this gate so testing is frictionless.
    if (liveMode && topCycle.estimatedProfitUsd < THIN_EDGE_PCT * tradeSize) {
      setThinEdgePending(true);
      return;
    }
    await doExecuteObRoute();
  };

  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          <BookOpen className={cn("h-4 w-4", isAutoExecutingOb && "animate-pulse text-yellow-500")} /> Order Book Hunter
          <span className="text-[10px] font-mono text-muted-foreground font-normal">
            v19 · {data ? (data.crossPairsDiscovered > 0 ? `${data.crossPairsDiscovered} live crosses` : "hardcoded crosses") : "Scaling Analyzer"} · 34 assets
          </span>
          {isRunning && (
            <span className="text-[9px] font-mono font-bold px-1 border border-primary text-primary">AUTO</span>
          )}
          {isAutoExecutingOb && (
            <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500 border border-yellow-500/50 animate-pulse flex items-center gap-1">
              <RefreshCw className="h-2.5 w-2.5 animate-spin" /> EXECUTING
            </span>
          )}
          {!isAutoExecutingOb && lastObAutoTrade && (
            <span
              className="text-[9px] font-mono text-muted-foreground border border-border px-1 py-0.5"
              title={`Last auto-fire: ${lastObAutoTrade.route} at ${new Date(lastObAutoTrade.timestamp).toLocaleTimeString()}`}
            >
              last: {lastObAutoTrade.route}{lastObAutoTrade.profitUsd != null ? ` $${lastObAutoTrade.profitUsd.toFixed(4)}` : ""} · {new Date(lastObAutoTrade.timestamp).toLocaleTimeString()}
            </span>
          )}
          <span className="flex items-center gap-1 text-[10px] font-mono font-normal text-muted-foreground">
            $<input
              type="number"
              min={1}
              step={5}
              value={tradeSizeInput}
              onChange={e => setTradeSizeInput(e.target.value)}
              className="w-16 bg-transparent border border-border px-1 py-0.5 text-foreground focus:outline-none focus:border-primary"
              aria-label="Trade size in USD"
            /> trade size
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn(
                  "flex items-center gap-0.5 text-[10px] font-mono font-normal px-1.5 py-0.5 border cursor-default",
                  actualFee != null
                    ? "border-success/60 text-success bg-success/5"
                    : "border-border text-muted-foreground",
                )}>
                  fees: {effectiveFeePct.toFixed(2)}%
                  {actualFee != null && <span className="text-[8px] font-bold ml-0.5">✓</span>}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[200px]">
                {actualFee != null
                  ? <p className="text-[11px]">Your actual Kraken taker fee tier: <span className="font-bold">{actualFee.toFixed(2)}%</span> per leg. Overrides the configured {settings.obFeesPct.toFixed(2)}% assumption.</p>
                  : <p className="text-[11px]">Configured OB fee assumption: <span className="font-bold">{settings.obFeesPct.toFixed(2)}%</span> per leg. Add Kraken credentials to auto-detect your actual tier.</p>
                }
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="flex items-center gap-1 text-[10px] font-mono font-normal text-muted-foreground">
            min $<input
              type="number"
              min={0}
              step={0.05}
              value={minProfitInput}
              onChange={e => setMinProfitInput(e.target.value)}
              className="w-14 bg-transparent border border-border px-1 py-0.5 text-foreground focus:outline-none focus:border-primary"
              aria-label="Minimum profit in USD to execute"
            /> profit
          </span>
          <button
            onClick={() => setVolatilityFilter(v => !v)}
            className={cn(
              "flex items-center gap-1 text-[10px] font-mono font-normal px-1.5 py-0.5 border transition-colors",
              volatilityFilter
                ? "border-amber-500/60 text-amber-500 hover:border-amber-400"
                : "border-border text-muted-foreground hover:border-primary hover:text-foreground",
            )}
            title={volatilityFilter ? "Volatility filter ON — only scanning assets that moved >1.5%/24h. Click to scan all assets." : "Volatility filter OFF — scanning all assets. Click to restrict to high-volatility assets."}
          >
            {volatilityFilter ? "⚡ vol filter on" : "vol filter off"}
          </button>
          {data && data.readyCount > 0 && (
            <span className="text-[9px] font-mono font-bold px-1 border border-success text-success animate-pulse">
              {data.readyCount} READY
            </span>
          )}
        </CardTitle>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
          {isLoading && <RefreshCw className="h-3 w-3 animate-spin" />}
          {isRunning && !isAutoExecutingOb && !isLoading && (
            <span className="text-muted-foreground">scanning…</span>
          )}
          {data && `${data.activeAssets.length} active assets · ${data.pairsScanned}/${data.pairsRequested} pairs · ${data.cycles.length} routes ranked`}
          <Button
            size="sm"
            variant={liveMode ? "destructive" : "outline"}
            className="h-6 px-2 text-[10px] font-mono font-bold"
            disabled={!canExecute}
            onClick={executeTopRoute}
            title={topCycle ? `Pre-flight + execute ${topCycle.route} at $${tradeSize}${liveMode ? " (LIVE ORDERS)" : " (dry run)"}` : "No executable route"}
          >
            {executeMutation.isPending ? "EXECUTING…" : `🔴 EXECUTE TOP ROUTE${liveMode ? "" : " (DRY)"}`}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {thinEdgePending && topCycle && (
          <div className="px-3 py-3 border-b-2 border-amber-500 bg-amber-500/10 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-amber-500 font-bold text-[11px] font-mono uppercase">
              ⚠ Thin Edge — Confirm Live Execution
            </div>
            <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-[10px] font-mono">
              <span className="text-muted-foreground">Expected profit</span>
              <span className="text-muted-foreground">Trade size</span>
              <span className="text-muted-foreground">Break-even move</span>
              <span className="font-bold text-amber-500">${topCycle.estimatedProfitUsd.toFixed(4)}</span>
              <span className="font-bold">${tradeSize.toFixed(2)}</span>
              <span className="font-bold text-destructive">
                {((topCycle.estimatedProfitUsd / tradeSize) * 100).toFixed(3)}% of price
              </span>
            </div>
            <p className="text-[10px] font-mono text-muted-foreground">
              A {((topCycle.estimatedProfitUsd / tradeSize) * 100).toFixed(3)}% adverse price move or worse fill will erase this profit before orders settle.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-3 text-[10px] font-mono font-bold"
                onClick={doExecuteObRoute}
                disabled={executeMutation.isPending}
              >
                {executeMutation.isPending ? "EXECUTING…" : "⚡ CONFIRM LIVE EXECUTE"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-3 text-[10px] font-mono"
                onClick={() => setThinEdgePending(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {execResult && (
          <div className={cn("px-3 py-2 text-[11px] font-mono border-b border-border/50", execResult.startsWith("✅") ? "text-success" : "text-destructive")}>
            {execResult}
            {topCycle && !execResult.startsWith("✅") && ` · Current best: ${topCycle.route} | $${topCycle.estimatedProfitUsd.toFixed(4)}`}
          </div>
        )}
        {!execResult && topBelowThreshold && topCycle && (
          <div className="px-3 py-1.5 text-[10px] font-mono text-muted-foreground border-b border-border/50">
            ⚠ Top route {topCycle.route} profit ${topCycle.estimatedProfitUsd.toFixed(4)} is below your ${minProfit.toFixed(2)} minimum — pre-flight will reject unless the edge improves.
          </div>
        )}
        {data && topCycle && (
          <div className="px-3 py-2 text-[10px] font-mono border-b border-border/50 bg-muted/30 grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-0.5">
            <span className="col-span-2 sm:col-span-5 font-bold uppercase text-muted-foreground">Kraken Fee Diagnostic</span>
            <span className="text-muted-foreground">Fee/leg: <span className="text-foreground">{data.feesPct.toFixed(2)}%</span>{actualFee != null && <span className="text-success"> ·actual tier</span>}</span>
            <span className="text-muted-foreground">3-leg drag: <span className="text-foreground">${topCycle.feeUsd.toFixed(4)} ({((topCycle.feeUsd / tradeSize) * 100).toFixed(3)}%)</span></span>
            <span className="text-muted-foreground">Break-even edge: <span className="text-foreground">{((topCycle.feeUsd / tradeSize) * 100).toFixed(3)}%</span></span>
            <span className="text-muted-foreground">Best raw edge: <span className={topCycle.grossProfitUsd > 0 ? "text-success" : "text-destructive"}>${topCycle.grossProfitUsd.toFixed(4)} ({((topCycle.grossProfitUsd / tradeSize) * 100).toFixed(3)}%)</span></span>
            <span className={cn("font-bold", topCycle.estimatedProfitUsd > minProfit ? "text-success" : "text-destructive")}>
              {topCycle.estimatedProfitUsd > minProfit ? "✅ EXECUTABLE TRIANGLE" : "✕ NO EXECUTABLE TRIANGLE"}
            </span>
          </div>
        )}
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
                  {["#", "Route", "Raw Edge", "Fees", "Net Profit", "Profit %", "Slippage", "Confidence", "Status", "Vol A"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cycles.map((c, i) => {
                  const meta = OB_SCALING_META[c.status] ?? OB_SCALING_META["REJECTED"]!;
                  return (
                    <tr key={`${c.route}-${i}`} className={cn(
                      "border-b border-border/50",
                      c.status === "READY" ? "bg-success/10" : i % 2 === 0 ? "" : "bg-muted/20",
                    )}>
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5 font-bold text-foreground whitespace-nowrap">
                        <span className="flex items-center gap-1.5">
                          {c.route}
                          <span className={cn(
                            "text-[9px] font-mono font-bold px-1 border",
                            (c.legs ?? 3) === 4
                              ? "border-purple-500/70 text-purple-500"
                              : "border-muted-foreground/50 text-muted-foreground",
                          )}>{c.legs ?? 3}-leg</span>
                        </span>
                      </td>
                      <td className={cn("px-3 py-1.5", c.grossProfitUsd > 0 ? "text-success" : "text-destructive")}>
                        ${c.grossProfitUsd.toFixed(4)}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        -${c.feeUsd.toFixed(4)}
                      </td>
                      <td className={cn("px-3 py-1.5 font-bold", c.estimatedProfitUsd > 0 ? "text-success" : "text-destructive")}>
                        ${c.estimatedProfitUsd.toFixed(4)}
                      </td>
                      <td className={cn("px-3 py-1.5", c.profitPct > 0 ? "text-success" : "text-destructive")}>
                        {c.profitPct.toFixed(3)}%
                      </td>
                      <td className={cn("px-3 py-1.5", c.slippagePct > (data?.maxSlippagePct ?? 0.5) ? "text-amber-500" : "text-muted-foreground")}>
                        {c.slippagePct.toFixed(2)}%
                      </td>
                      <td className={cn("px-3 py-1.5", c.confidencePct >= 80 ? "text-success" : c.confidencePct >= 40 ? "text-amber-500" : "text-destructive")}>
                        {c.confidencePct}%
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
            {data && data.scalingRoute && data.scaling.length > 0 && (
              <div className="border-t-2 border-border">
                <div className="px-3 py-2 text-[10px] font-mono font-bold uppercase text-muted-foreground bg-muted/50">
                  Scaling Analysis — {data.scalingRoute} (live, re-simulated each scan)
                </div>
                <table className="w-full text-xs font-mono border-collapse">
                  <thead>
                    <tr className="border-b border-border/50">
                      {["Size", "Profit", "Slippage", "Confidence", "Status"].map(h => (
                        <th key={h} className="text-left px-3 py-1.5 text-[10px] uppercase font-bold text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.scaling.map(row => {
                      const meta = OB_SCALING_META[row.status] ?? OB_SCALING_META["REJECTED"]!;
                      return (
                        <tr key={row.sizeUsd} className={cn("border-b border-border/50", row.status === "VIABLE" && "bg-success/10")}>
                          <td className="px-3 py-1.5 font-bold">${row.sizeUsd.toLocaleString()}</td>
                          <td className={cn("px-3 py-1.5 font-bold", row.profitUsd > 0 ? "text-success" : "text-destructive")}>
                            ${row.profitUsd.toFixed(4)}
                          </td>
                          <td className={cn("px-3 py-1.5", row.slippagePct > (data.maxSlippagePct ?? 0.5) ? "text-amber-500" : "text-muted-foreground")}>
                            {row.slippagePct.toFixed(3)}%
                          </td>
                          <td className={cn("px-3 py-1.5", row.confidencePct >= 80 ? "text-success" : row.confidencePct >= 40 ? "text-amber-500" : "text-destructive")}>
                            {row.confidencePct}%
                          </td>
                          <td className="px-3 py-1.5">
                            <span className={cn("text-[9px] font-bold px-1 border whitespace-nowrap", meta.className)}>{meta.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {data.scaling.length < 5 && (
                  <div className="px-3 py-1.5 text-[10px] font-mono text-muted-foreground">
                    Sizes above ${data.scaling[data.scaling.length - 1]?.sizeUsd.toLocaleString()} omitted — order book depth can't absorb them.
                  </div>
                )}
              </div>
            )}
            {data && (
              <div className="px-3 py-2 text-[10px] font-mono text-muted-foreground border-t border-border/50">
                Trade size: ${data.tradeSizeUsd} · Fees: {data.feesPct}% · Min profit: ${data.minProfitUsd} (×size/10) · Max slippage: {data.maxSlippagePct}% · Volatility filter: {data.volatilityFilter ? `on (${data.activeAssets.length}/34 moving)` : "off"} · Scanned: {format(new Date(data.scannedAt), "HH:mm:ss")}
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
  priceSource,
}: {
  opportunities: Array<{ exchange: string; loop: string; profitPct: number; solUsd: number; ethUsd: number; ethSol: number; variant?: string; timestamp: string }>;
  isRunning: boolean;
  isExecutingTri?: boolean;
  priceSource?: Record<string, "direct" | "synthetic">;
}) {
  const krakenSynth = priceSource?.kraken === "synthetic";
  const coinbaseSynth = priceSource?.coinbase === "synthetic";

  // ── SYNTH → DIRECT upgrade detection ────────────────────────────────────────
  // Fire a one-time toast + brief badge highlight the first time the Kraken
  // ETH/SOL source flips from synthetic to direct in this session.
  const { toast } = useToast();
  const prevKrakenSource = useRef<"direct" | "synthetic" | undefined>(undefined);
  const upgradeToastFired = useRef(false);
  const [justUpgraded, setJustUpgraded] = useState(false);
  const krakenSource = priceSource?.kraken;
  useEffect(() => {
    const upgraded =
      prevKrakenSource.current === "synthetic" &&
      krakenSource === "direct" &&
      !upgradeToastFired.current;
    prevKrakenSource.current = krakenSource;
    if (!upgraded) return undefined;
    upgradeToastFired.current = true;
    toast({
      title: "ETH/SOL upgraded to direct prices",
      description: "Kraken now lists a live ETH/SOL market — the triangular scanner switched from synthetic cross rates to direct order-book prices.",
    });
    setJustUpgraded(true);
    const id = setTimeout(() => setJustUpgraded(false), 8_000);
    return () => clearTimeout(id);
  }, [krakenSource, toast]);

  return (
    <Card>
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          <RefreshCw className={cn("h-4 w-4", isExecutingTri && "animate-spin text-yellow-500")} />
          Triangular Arbitrage
          <span className="text-[9px] font-mono font-bold px-1 border border-primary text-primary">TRI</span>
          <span className="text-[10px] font-mono text-muted-foreground">Same-exchange loops</span>
          {/* Price source indicators — shown once data arrives */}
          {priceSource && Object.keys(priceSource).length > 0 && (
            <span className="flex items-center gap-1">
              {krakenSynth && (
                <span
                  className="text-[9px] font-mono font-bold px-1 border border-yellow-500 text-yellow-500"
                  title="Kraken ETH/SOL WS market unavailable — triangular scanner is using a synthetic cross rate (ETH/USD ÷ SOL/USD). Real deviation signals cannot be detected."
                >
                  K:SYNTH
                </span>
              )}
              {!krakenSynth && priceSource.kraken === "direct" && (
                <span
                  className={cn(
                    "text-[9px] font-mono font-bold px-1 border border-success text-success",
                    justUpgraded && "animate-pulse bg-success/20 ring-2 ring-success",
                  )}
                  title="Kraken ETH/SOL direct market — live real-time prices"
                >
                  K:DIRECT
                </span>
              )}
              {coinbaseSynth && (
                <span
                  className="text-[9px] font-mono font-bold px-1 border border-muted-foreground text-muted-foreground"
                  title="Coinbase has no direct ETH/SOL market — synthetic cross rate used"
                >
                  CB:SYNTH
                </span>
              )}
            </span>
          )}
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

// ── Graph Opportunity Engine Card ──────────────────────────────────────────────

const EXCHANGE_BADGE: Record<string, string> = {
  kraken:   "bg-primary/20 text-primary border-primary/40",
  coinbase: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  bridge:   "bg-muted/50 text-muted-foreground border-border",
};

function HopBadge({ hop }: { hop: GraphRouteHop }) {
  const tag = hop.exchange === "bridge" ? "⇌" : hop.exchange === "kraken" ? "K" : "CB";
  return (
    <span className={cn("text-[8px] font-bold px-1 border rounded-sm", EXCHANGE_BADGE[hop.exchange] ?? EXCHANGE_BADGE.bridge)}>
      {tag}
    </span>
  );
}

function GraphEngineCard() {
  const { settings, credentials, liveMode, forceMode, addLog } = useBotContext();
  const executeMutation = useGraphExecute();
  // Live per-leg fill status — polled at 1s only while an execution is in
  // flight (or the server still reports an active leg), idle otherwise.
  const { data: execStatus } = useGetExecutionStatus({
    query: { queryKey: getGetExecutionStatusQueryKey(), refetchInterval: q => (executeMutation.isPending || q.state.data?.active ? 1_000 : false) },
  });
  const legStatus = execStatus?.active ? execStatus : null;
  const [execResult, setExecResult] = useState<string | null>(null);
  const [thinEdgePending, setThinEdgePending] = useState(false);
  const [minProfitInput, setMinProfitInput] = useState("0.10");
  const minProfit = Math.max(0, parseFloat(minProfitInput) || 0);
  const [sizeInput, setSizeInput] = useState(String(settings.obTradeSize));
  const [debouncedSize, setDebouncedSize] = useState(String(settings.obTradeSize));
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSize(sizeInput), 500);
    return () => clearTimeout(t);
  }, [sizeInput]);
  const tradeSize = Math.max(1, parseFloat(debouncedSize) || settings.obTradeSize);

  // Use the account's real Kraken fee tier when available (shared lookup).
  // Maker style: post-only limit orders — better prices + maker fee, but no
  // fill guarantee. Taker style: market orders priced by depth-walked VWAP.
  const [style, setStyle] = useState<"taker" | "maker">("taker");
  // Fast-fill mode (trader-directed): 3s maker window, a single reprice, then
  // an UNGATED taker fallback — fills small edges instead of cancelling them,
  // at the cost of occasionally eating a decayed edge at taker prices.
  const [fastTakerFallback, setFastTakerFallback] = useLocalStorage<boolean>("graph-fast-taker-fallback", true);
  const fees = useActualKrakenFees();
  const actualFee = style === "maker" ? (fees.maker ?? fees.taker) : fees.taker;
  const params = {
    tradeSizeUsd:    tradeSize,
    krakenFeesPct:   actualFee ?? settings.obFeesPct,
    coinbaseFeesPct: 0.40,
    maxHops:         4,
    executionStyle:  style,
  };
  const { data, isLoading, dataUpdatedAt } = useGetGraphScan(params, {
    query: { queryKey: getGetGraphScanQueryKey(params), refetchInterval: 8_000, staleTime: 7_000 },
  });

  const routes: GraphRoute[] = data?.routes ?? [];
  // Execute Top Route must target a route the live executor SUPPORTS —
  // the server ranks executable routes first, but guard here too.
  const topRoute = routes.find(r => r.executable) ?? undefined;
  const viable = routes.filter(r => r.status === "VIABLE" && r.executable);
  const breakEvenPct = topRoute
    ? ((topRoute.feeUsd / tradeSize) * 100).toFixed(3)
    : "—";
  const canExecute = !!topRoute && !executeMutation.isPending;

  // Synchronous in-flight guard: React Query's isPending only updates on the
  // next render, so a rapid auto-fire + manual click could otherwise both
  // pass the check and submit two executions.
  const execInFlight = useRef(false);
  const doExecuteGraphRoute = async () => {
    if (!topRoute) return;
    if (execInFlight.current) return;
    execInFlight.current = true;
    setThinEdgePending(false);
    setExecResult(null);
    // Fall-through: if a route is rejected by the feedback-loop gate (its own
    // fill history), immediately try the next-best viable route from the same
    // scan instead of stalling until the next scan. Max 3 candidates per fire.
    // FORCE MODE lowers the effective floor to $0.01 — take any positive trade.
    const effMinProfit = forceMode && liveMode ? Math.min(minProfit, 0.01) : minProfit;
    const candidates = [topRoute, ...viable.filter(r => r.description !== topRoute.description && r.netProfitUsd > effMinProfit)].slice(0, 3);
    try {
      for (let ci = 0; ci < candidates.length; ci++) {
        const cand = candidates[ci];
        addLog("trade", `[GRAPH·EXEC] ${cand.description} | $${tradeSize} | ${liveMode ? "LIVE" : "dry run"}${ci > 0 ? ` — fallback #${ci} after gate` : ""} — pre-flight…`);
        const r = await executeMutation.mutateAsync({
          data: {
            krakenKey: credentials.krakenKey,
            krakenSecret: credentials.krakenSecret,
            coinbaseKey: credentials.coinbaseKey || undefined,
            coinbaseSecret: credentials.coinbaseSecret || undefined,
            routeDescription: cand.description,
            tradeSizeUsd: tradeSize,
            krakenFeesPct: settings.obFeesPct,
            coinbaseFeesPct: 0.40,
            minProfitUsd: effMinProfit,
            isDryRun: !liveMode,
            executionStyle: style,
            forceMode: forceMode && liveMode,
            ...(fastTakerFallback ? { maxReprices: 1, makerTimeoutMs: 3_000, alwaysTakerFallback: true } : {}),
          },
        });
        if (r.success && r.executed) {
          const profit = r.realizedProfitUsd ?? r.preflightProfitUsd ?? 0;
          const label = r.realizedProfitUsd != null ? "realized" : "expected";
          addLog("success", `[GRAPH·EXEC] ✅ ${r.route} | ${label} $${profit.toFixed(4)}${r.isDryRun ? " (dry run)" : ` | orders ${(r.orderIds ?? []).join(", ")}`}`);
          setExecResult(`✅ Executed ${r.route} — ${label} $${profit.toFixed(4)}${r.isDryRun ? " (dry run, recorded to ledger)" : ""}`);
          return;
        }
        const err = r.error ?? "";
        addLog("warning", `[GRAPH·EXEC] ❌ ${err || "Pre-flight failed."}`);
        setExecResult(`❌ ${err || "Pre-flight failed — edge disappeared."}`);
        const noOrdersPlaced = !r.executed && (err.startsWith("Pre-flight failed") || err.startsWith("Feedback-loop gate") || err.startsWith("Could not fetch"));
        // Feedback-loop gate rejections AND exhausted leg-1 maker reprices fall
        // through to the next-best route — pre-flight failures mean the market
        // moved; a fresh scan handles that.
        const fallsThrough = err.startsWith("Feedback-loop gate") || err.startsWith("Leg 1 unfilled");
        const isLastCandidate = ci === candidates.length - 1 || !fallsThrough;
        if (isLastCandidate) {
          // Clear the AUTO cooldown ONLY when the whole fire ended with no
          // orders placed — a successful fallback keeps the full cooldown.
          if (noOrdersPlaced) lastAutoFire.current = 0;
          return;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      addLog("error", `[GRAPH·EXEC] Exception: ${msg}`);
      setExecResult(`❌ ${msg}`);
    } finally {
      execInFlight.current = false;
    }
  };

  const executeTopRoute = async () => {
    if (!topRoute) return;
    if (!credentials.krakenKey || !credentials.krakenSecret) {
      addLog("warning", "[GRAPH·EXEC] Add Kraken credentials in Config first.");
      setExecResult("❌ No Kraken credentials — add them in Config.");
      return;
    }
    // In live mode, warn when profit is below the thin-edge safety margin (< 0.1% of trade size).
    // Dry runs and AUTO (which calls doExecuteGraphRoute directly) bypass this gate.
    if (liveMode && topRoute.netProfitUsd < THIN_EDGE_PCT * tradeSize) {
      setThinEdgePending(true);
      return;
    }
    await doExecuteGraphRoute();
  };

  // ── Auto-execution loop ────────────────────────────────────────────────────
  // When armed, fires doExecuteGraphRoute (bypasses thin-edge confirm) since
  // AUTO already gates on minProfit and the user armed it knowingly.
  // The server re-validates everything (fresh scan, slippage buffer, feedback
  // -loop history) before any order — this loop only saves the button click.
  // The server re-validates everything (fresh scan, slippage buffer, feedback
  // -loop history) before any order — this loop only saves the button click.
  const [autoArmed, setAutoArmed] = useState(false);
  // Configurable cooldown (seconds) between AUTO fires. Applies only after a
  // REAL execution attempt — pre-flight rejections placed no orders, so they
  // clear the cooldown (overlap is prevented by the in-flight lock instead).
  const [autoCooldownInput, setAutoCooldownInput] = useState("5");
  const autoCooldownSec = Math.max(1, parseFloat(autoCooldownInput) || 5);
  const AUTO_COOLDOWN_MS = autoCooldownSec * 1000;
  const lastAutoFire = useRef(0);
  // Scan generation used for the last fire — AUTO never retries against the
  // SAME scan snapshot (prevents a rejection→retry loop hammering the server
  // with identical stale data; a fresh scan arrives every ~8s).
  const lastFireScanAt = useRef(0);
  // Ticks every second while armed so the cooldown countdown stays live.
  const [, setCooldownTick] = useState(0);
  useEffect(() => {
    if (!autoArmed) return;
    const t = setInterval(() => setCooldownTick(n => n + 1), 1_000);
    return () => clearInterval(t);
  }, [autoArmed]);
  /** Why AUTO is not firing RIGHT NOW (null = clear to fire). */
  const cooldownLeftMs = Math.max(0, AUTO_COOLDOWN_MS - (Date.now() - lastAutoFire.current));
  const autoSkipReason: string | null = !autoArmed ? null
    : executeMutation.isPending ? "execution in flight — waiting for it to finish"
    : routes.length === 0 ? "no routes in scan yet"
    : !topRoute ? "no executable route — every scanned route is a shape the live executor doesn't support (4+ hop / mixed)"
    : cooldownLeftMs > 0 ? `cooldown — ${Math.ceil(cooldownLeftMs / 1000)}s until next fire`
    : dataUpdatedAt !== 0 && dataUpdatedAt === lastFireScanAt.current ? "already attempted on this scan — waiting for the next fresh scan (~8s)"
    : topRoute.netProfitUsd <= 0 ? `fees exceed gross edge — best executable route nets ${topRoute.netProfitUsd < 0 ? "-" : ""}$${Math.abs(topRoute.netProfitUsd).toFixed(4)} after fees`
    : topRoute.netProfitUsd <= minProfit ? `edge too small — best executable edge $${topRoute.netProfitUsd.toFixed(4)} ≤ your $${minProfit.toFixed(2)} floor`
    : null;
  /** Per-route reject reason for the table (pre-execution checks only). */
  const routeRejectReason = (r: (typeof routes)[number]): string | null =>
    !r.executable ? "Unsupported route shape — live executor handles Kraken triangles & 2-leg cross only"
    : r.netProfitUsd <= 0 ? "Fees exceed gross edge"
    : r.netProfitUsd <= minProfit ? `Edge below your $${minProfit.toFixed(2)} min-profit floor`
    : null;
  // AUTO calls doExecuteGraphRoute directly so it never triggers the thin-edge confirm dialog.
  const executeRef = useRef(doExecuteGraphRoute);
  executeRef.current = doExecuteGraphRoute;
  useEffect(() => {
    if (!autoArmed || !topRoute || executeMutation.isPending) return;
    if (topRoute.netProfitUsd <= minProfit) return;
    if (Date.now() - lastAutoFire.current < AUTO_COOLDOWN_MS) return;
    if (dataUpdatedAt !== 0 && dataUpdatedAt === lastFireScanAt.current) return; // one attempt per scan snapshot
    lastFireScanAt.current = dataUpdatedAt;
    lastAutoFire.current = Date.now();
    addLog("info", `[GRAPH·AUTO] Edge $${topRoute.netProfitUsd.toFixed(4)} > floor $${minProfit.toFixed(2)} — auto-firing ${topRoute.description}`);
    void executeRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoArmed, topRoute?.description, topRoute?.netProfitUsd, minProfit, executeMutation.isPending]);
  useEffect(() => {
    if (autoArmed) addLog("warning", `[GRAPH·AUTO] Armed (${liveMode ? "LIVE" : "dry run"}, ${style}) — fires when top route edge > $${minProfit.toFixed(2)}, ${autoCooldownSec}s cooldown after each real attempt.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoArmed]);

  return (
    <Card className="mt-6">
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          Opportunity Engine
          <span className="text-[10px] font-mono text-muted-foreground font-normal">
            Kraken + Coinbase · graph search
          </span>
          <span className="flex items-center gap-1 text-[10px] font-mono font-normal text-muted-foreground">
            $<input
              type="number" min={1} step={10}
              value={sizeInput}
              onChange={e => setSizeInput(e.target.value)}
              className="w-16 bg-transparent border border-border px-1 py-0.5 text-foreground focus:outline-none focus:border-primary"
              aria-label="Trade size USD"
            /> trade size
          </span>
          <span className="flex items-center gap-1 text-[10px] font-mono font-normal text-muted-foreground">
            min $<input
              type="number" min={0} step={0.05}
              value={minProfitInput}
              onChange={e => setMinProfitInput(e.target.value)}
              className="w-14 bg-transparent border border-border px-1 py-0.5 text-foreground focus:outline-none focus:border-primary"
              aria-label="Minimum profit in USD to execute"
            /> profit
          </span>
          <button
            onClick={() => setStyle(s => s === "taker" ? "maker" : "taker")}
            className={cn(
              "text-[10px] font-mono font-bold px-1.5 py-0.5 border",
              style === "maker" ? "border-success text-success" : "border-border text-muted-foreground",
            )}
            title={style === "maker"
              ? "MAKER: post-only limit orders — lower fee + better price, fills not guaranteed. LIVE maker execution: Kraken triangles only."
              : "TAKER: market orders — guaranteed fill, priced by depth-walked VWAP incl. slippage"}
          >
            {style.toUpperCase()}
          </button>
          <button
            onClick={() => setFastTakerFallback(v => !v)}
            data-testid="button-fast-taker"
            className={cn(
              "text-[10px] font-mono font-bold px-1.5 py-0.5 border",
              fastTakerFallback ? "border-primary text-primary" : "border-border text-muted-foreground",
            )}
            title={fastTakerFallback
              ? "FAST FILL ON: 3s maker window, 1 reprice, then IMMEDIATE taker fallback with NO profit-floor gate — a decayed edge can fill at a small loss. Turn off to restore patient maker execution with the gated fallback."
              : "FAST FILL OFF: patient maker execution — up to 4 reprices, taker fallback only if the fresh taker-priced edge still clears your floor."}
          >
            {fastTakerFallback ? "FAST·FILL" : "PATIENT"}
          </button>
          <button
            onClick={() => setAutoArmed(a => !a)}
            className={cn(
              "text-[10px] font-mono font-bold px-1.5 py-0.5 border",
              autoArmed ? "border-destructive text-destructive animate-pulse" : "border-border text-muted-foreground",
            )}
            title="Auto-execution: fires EXECUTE automatically whenever the top route's net edge clears your profit floor. Cooldown applies only after a real execution attempt — pre-flight rejections don't pause the bot. Server re-validates fees, slippage, and this route's execution history before any order."
          >
            {autoArmed ? "AUTO·ON" : "AUTO"}
          </button>
          <span className="flex items-center gap-1 text-[10px] font-mono font-normal text-muted-foreground">
            cd <input
              type="number" min={1} step={1}
              value={autoCooldownInput}
              onChange={e => setAutoCooldownInput(e.target.value)}
              className="w-10 bg-transparent border border-border px-1 py-0.5 text-foreground focus:outline-none focus:border-primary"
              aria-label="AUTO cooldown in seconds after a real execution attempt"
              title="Seconds AUTO waits after a real execution attempt before firing again. Pre-flight rejections don't start a cooldown."
            /> s
          </span>
        </CardTitle>
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
          {isLoading && <RefreshCw className="h-3 w-3 animate-spin" />}
          {data && (
            <span>{data.assetsScanned} assets · {data.routesEvaluated} routes evaluated · {viable.length} viable</span>
          )}
          <Button
            size="sm"
            variant={liveMode ? "destructive" : "outline"}
            className="h-6 px-2 text-[10px] font-mono font-bold"
            disabled={!canExecute}
            onClick={executeTopRoute}
            title={topRoute ? `Pre-flight + execute ${topRoute.description} at $${tradeSize}${liveMode ? " (LIVE ORDERS)" : " (dry run)"}` : "No route available"}
          >
            {executeMutation.isPending ? "EXECUTING…" : `🔴 EXECUTE TOP ROUTE${liveMode ? "" : " (DRY)"}`}
          </Button>
        </div>
      </CardHeader>

      {legStatus && (
        <div className="px-3 py-2 border-b border-primary/50 bg-primary/5 text-[10px] font-mono flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-bold text-primary animate-pulse">⚡ LIVE EXECUTION</span>
          <span>{legStatus.route}</span>
          <span className="font-bold">Leg {legStatus.leg}/3</span>
          <span>{legStatus.legLabel}</span>
          <span className="text-muted-foreground">order {legStatus.orderId ?? "—"}</span>
          <span>
            {legStatus.elapsedMs != null && legStatus.timeoutMs != null
              ? `${(legStatus.elapsedMs / 1000).toFixed(1)}s / ${(legStatus.timeoutMs / 1000).toFixed(0)}s fill timer`
              : "—"}
          </span>
          <span className={cn("font-bold", (legStatus.filledPct ?? 0) >= 99.9 ? "text-success" : "text-amber-500")}>
            filled {(legStatus.filledPct ?? 0).toFixed(1)}%
          </span>
          <span className="text-muted-foreground">attempt {legStatus.attempt}/{legStatus.maxAttempts}</span>
          {legStatus.orderPrice != null && (
            <span data-testid="text-maker-quote">
              our {legStatus.orderPrice} | bid {legStatus.bestBid ?? "—"} / ask {legStatus.bestAsk ?? "—"}
            </span>
          )}
          {legStatus.queueAheadVol != null && (
            <span className={cn("font-bold", legStatus.queueAheadVol === 0 ? "text-success" : "text-amber-500")} data-testid="text-queue-position">
              {legStatus.queueAheadVol === 0 ? "front of queue" : `queue ahead ${legStatus.queueAheadVol.toFixed(4)}`}
            </span>
          )}
          {legStatus.reprices != null && legStatus.reprices > 0 && (
            <span className="text-muted-foreground">reprices {legStatus.reprices}</span>
          )}
          <span className="text-muted-foreground italic">{legStatus.phase}</span>
        </div>
      )}

      {thinEdgePending && topRoute && (
        <div className="px-3 py-3 border-b-2 border-amber-500 bg-amber-500/10 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-amber-500 font-bold text-[11px] font-mono uppercase">
            ⚠ Thin Edge — Confirm Live Execution
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-[10px] font-mono">
            <span className="text-muted-foreground">Expected profit</span>
            <span className="text-muted-foreground">Trade size</span>
            <span className="text-muted-foreground">Break-even move</span>
            <span className="font-bold text-amber-500">${topRoute.netProfitUsd.toFixed(4)}</span>
            <span className="font-bold">${tradeSize.toFixed(2)}</span>
            <span className="font-bold text-destructive">
              {((topRoute.netProfitUsd / tradeSize) * 100).toFixed(3)}% of price
            </span>
          </div>
          <p className="text-[10px] font-mono text-muted-foreground">
            A {((topRoute.netProfitUsd / tradeSize) * 100).toFixed(3)}% adverse price move or worse fill will erase this profit before orders settle.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-3 text-[10px] font-mono font-bold"
              onClick={doExecuteGraphRoute}
              disabled={executeMutation.isPending}
            >
              {executeMutation.isPending ? "EXECUTING…" : "⚡ CONFIRM LIVE EXECUTE"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-3 text-[10px] font-mono"
              onClick={() => setThinEdgePending(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {execResult && (
        <div className={cn("px-3 py-2 text-[11px] font-mono border-b border-border/50", execResult.startsWith("✅") ? "text-success" : "text-destructive")}>
          {execResult}
          {topRoute && !execResult.startsWith("✅") && ` · Current best: ${topRoute.description} | $${topRoute.netProfitUsd.toFixed(4)}`}
        </div>
      )}
      {!execResult && topRoute && topRoute.netProfitUsd <= minProfit && (
        <div className="px-3 py-1.5 text-[10px] font-mono text-muted-foreground border-b border-border/50">
          ⚠ Top route net profit ${topRoute.netProfitUsd.toFixed(4)} is below your ${minProfit.toFixed(2)} minimum — pre-flight will reject unless the edge improves.
        </div>
      )}

      {/* AUTO status: always shows WHY the bot is idle instead of leaving you guessing */}
      {autoArmed && (
        <div className={cn("px-3 py-1.5 text-[10px] font-mono border-b border-border/50",
          autoSkipReason ? "text-yellow-500" : "text-success")}>
          {autoSkipReason
            ? `⏸ AUTO idle — ${autoSkipReason}`
            : "▶ AUTO clear to fire — top route edge exceeds your floor; firing on next evaluation"}
        </div>
      )}

      {/* Fee diagnostic */}
      {data && topRoute && (
        <div className="px-3 py-2 text-[10px] font-mono border-b border-border/50 bg-muted/30 grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-0.5">
          <span className="col-span-2 sm:col-span-5 font-bold uppercase text-muted-foreground">Fee Diagnostic</span>
          <span className="text-muted-foreground">Kraken/leg: <span className="text-foreground">{data.krakenFeesPct.toFixed(2)}%</span>{actualFee != null && <span className="text-success"> ·actual {data.executionStyle} tier</span>}</span>
          <span className="text-muted-foreground">Slippage (top): <span className="text-foreground">{topRoute.slippagePct.toFixed(3)}%{data.executionStyle === "maker" ? " (n/a maker)" : " depth-walked"}</span></span>
          <span className="text-muted-foreground">Coinbase/leg: <span className="text-foreground">{data.coinbaseFeesPct.toFixed(2)}%</span></span>
          <span className="text-muted-foreground">Break-even: <span className="text-foreground">{breakEvenPct}%</span></span>
          <span className="text-muted-foreground">Best raw edge: <span className={topRoute.grossProfitUsd > 0 ? "text-success" : "text-destructive"}>${topRoute.grossProfitUsd.toFixed(4)}</span></span>
          <span className={cn("font-bold", viable.length > 0 ? "text-success" : "text-destructive")}>
            {viable.length > 0 ? `✅ ${viable.length} EXECUTABLE` : "✕ NO EXECUTABLE ROUTE"}
          </span>
        </div>
      )}

      <CardContent className="p-0">
        {routes.length === 0 ? (
          <div className="p-8 text-center text-sm font-mono text-muted-foreground">
            {isLoading ? "Building graph and searching routes…" : "No routes found — check exchange connectivity."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="border-b-2 border-border bg-muted/50">
                  {["#", "Route", "Hops", "Raw Edge", "Fees", "Net Profit", "Profit %", "Status"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {routes.map((r, i) => (
                  <tr key={r.description} className={cn(
                    "border-b border-border/50",
                    r.status === "VIABLE" ? "bg-success/10" : i % 2 === 0 ? "" : "bg-muted/20",
                  )}>
                    <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-1.5 font-bold text-foreground whitespace-nowrap max-w-[240px] truncate" title={r.description}>
                      {r.description}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex gap-0.5 items-center">
                        {r.hops.filter(h => h.exchange !== "bridge").map((h, j) => (
                          <HopBadge key={j} hop={h} />
                        ))}
                      </span>
                    </td>
                    <td className={cn("px-3 py-1.5", r.grossProfitUsd > 0 ? "text-success" : "text-destructive")}>
                      ${r.grossProfitUsd.toFixed(4)}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      -${r.feeUsd.toFixed(4)}
                    </td>
                    <td className={cn("px-3 py-1.5 font-bold", r.netProfitUsd > 0 ? "text-success" : "text-destructive")}>
                      ${r.netProfitUsd.toFixed(4)}
                    </td>
                    <td className={cn("px-3 py-1.5", r.profitPct > 0 ? "text-success" : "text-destructive")}>
                      {r.profitPct.toFixed(3)}%
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={cn("text-[9px] font-bold px-1 border whitespace-nowrap",
                        !r.executable
                          ? "text-muted-foreground border-border/50 border-dashed"
                          : r.status === "VIABLE"
                            ? "text-success border-success"
                            : "text-muted-foreground border-border"
                      )} title={routeRejectReason(r) ?? "Clears every pre-execution check — eligible for AUTO / Execute Top Route."}>
                        {!r.executable ? "◌ SCAN ONLY" : r.status === "VIABLE" ? "✅ VIABLE" : "✕ REJECTED"}
                      </span>
                      {routeRejectReason(r) && (
                        <div className="text-[8px] text-muted-foreground mt-0.5 whitespace-nowrap">{routeRejectReason(r)}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <div className="px-3 py-1.5 text-[9px] font-mono text-muted-foreground border-t border-border/50">
            Kraken {data.krakenFeesPct}%/leg (post-only maker) · Coinbase {data.coinbaseFeesPct}%/leg · Bridge edges: inventory model, no transfer fee · Scanned {format(new Date(data.scannedAt), "HH:mm:ss")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Realized P&L (balance-based, ground truth) ────────────────────────────────
// Reads ACTUAL Kraken account value (cash + holdings at live tickers) — every
// poll and every completed live trade records a snapshot server-side. Nothing
// here comes from scanner estimates.
function RealizedPnlCard() {
  const { credentials } = useBotContext();
  const hasCreds = !!credentials.krakenKey && !!credentials.krakenSecret;
  const hasCoinbase = !!credentials.coinbaseKey && !!credentials.coinbaseSecret;
  const body = {
    krakenKey: credentials.krakenKey,
    krakenSecret: credentials.krakenSecret,
    ...(hasCoinbase ? { coinbaseKey: credentials.coinbaseKey, coinbaseSecret: credentials.coinbaseSecret } : {}),
  };
  const { data, isLoading, error } = useGetAccountPnl(body, {
    query: {
      queryKey: getGetAccountPnlQueryKey(body),
      enabled: hasCreds,
      refetchInterval: 60_000,
      staleTime: 55_000,
    },
  });
  const money = (v: number, signed = false) =>
    `${signed && v > 0 ? "+" : ""}$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pnlClass = (v: number) => v > 0 ? "text-success" : v < 0 ? "text-destructive" : "text-muted-foreground";
  return (
    <Card className="mt-6">
      <CardHeader className="py-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-primary" />
          Realized P&L
          <span className="text-[10px] font-mono text-muted-foreground font-normal">
            from actual {data?.includesCoinbase ? "Kraken + Coinbase" : "Kraken"} balances · not scanner estimates
          </span>
          {data && data.unpricedAssets.length > 0 && (
            <span className="text-[10px] font-mono text-yellow-500 font-normal" title="These assets couldn't be priced — totals under-count them.">
              ⚠ unpriced: {data.unpricedAssets.join(", ")}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!hasCreds ? (
          <div className="text-sm font-mono text-muted-foreground py-4 text-center">Add Kraken credentials in Config to track balance-based P&L.</div>
        ) : error ? (
          <div className="text-sm font-mono text-destructive py-4 text-center">Could not value the account — check credentials / connectivity.</div>
        ) : isLoading || !data ? (
          <div className="text-sm font-mono text-muted-foreground py-4 text-center">Valuing account from live balances…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 font-mono">
              <div className="border border-border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Starting Value</div>
                <div className="text-lg font-bold">{money(data.startingValueUsd)}</div>
                <div className="text-[9px] text-muted-foreground">{format(new Date(data.startedAt), "MMM d HH:mm")}</div>
              </div>
              <div className="border border-border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Current Value</div>
                <div className="text-lg font-bold">{money(data.currentValueUsd)}</div>
                <div className="text-[9px] text-muted-foreground">cash {money(data.usdBalance)}</div>
              </div>
              <div className="border border-border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Realized Today</div>
                <div className={cn("text-lg font-bold", pnlClass(data.realizedTodayUsd))}>{money(data.realizedTodayUsd, true)}</div>
                <div className={cn("text-[9px]", data.cashFlowAdjusted ? "text-muted-foreground" : "text-yellow-500")}>
                  {data.cashFlowAdjusted ? "excl. deposits/withdrawals" : "incl. deposits/withdrawals (ledger unverified)"}
                </div>
              </div>
              <div className="border border-border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Unrealized Holdings</div>
                <div className="text-lg font-bold">{money(data.unrealizedHoldingsUsd)}</div>
                <div className="text-[9px] text-muted-foreground">non-USD, at live tickers</div>
              </div>
              <div className="border border-border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Lifetime P&L</div>
                <div className={cn("text-lg font-bold", pnlClass(data.lifetimePnlUsd))}>{money(data.lifetimePnlUsd, true)}</div>
                <div className={cn("text-[9px]", data.cashFlowAdjusted ? "text-muted-foreground" : "text-yellow-500")}>
                  {data.cashFlowAdjusted ? "excl. deposits/withdrawals" : "incl. deposits/withdrawals (ledger unverified)"}
                </div>
              </div>
            </div>

            {/* Three-way attribution: equity change = cash flows + trading + drift */}
            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 font-mono">
              <div className="border border-primary/40 p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Account Equity Change</div>
                <div className={cn("text-lg font-bold", pnlClass(data.equityChangeUsd))}>{money(data.equityChangeUsd, true)}</div>
                <div className="text-[9px] text-muted-foreground">everything owned vs. baseline{data.netCashFlowUsd != null && Math.abs(data.netCashFlowUsd) >= 0.01 ? ` · incl. ${money(data.netCashFlowUsd, true)} deposits/withdrawals` : ""}</div>
              </div>
              <div className="border border-primary/40 p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Trading P&L</div>
                <div className={cn("text-lg font-bold", pnlClass(data.tradingPnlUsd))}>{money(data.tradingPnlUsd, true)}</div>
                <div className="text-[9px] text-muted-foreground">from {data.tradedFillCount} completed live fill{data.tradedFillCount === 1 ? "" : "s"} only</div>
              </div>
              <div className="border border-primary/40 p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Unrealized P&L</div>
                {data.unrealizedPnlUsd != null ? (
                  <>
                    <div className={cn("text-lg font-bold", pnlClass(data.unrealizedPnlUsd))}>{money(data.unrealizedPnlUsd, true)}</div>
                    <div className="text-[9px] text-muted-foreground">price drift on held coins (equity − cash flows − trading)</div>
                  </>
                ) : (
                  <>
                    <div className="text-lg font-bold text-muted-foreground">n/a</div>
                    <div className="text-[9px] text-yellow-500">withheld — cash flows can't be verified (see note below)</div>
                  </>
                )}
              </div>
            </div>

            <div className="mt-2 text-[9px] font-mono text-muted-foreground">
              {data.snapshotCount} balance snapshots recorded · a snapshot is taken on every live trade and every 60s poll · deposits/withdrawals are subtracted via Kraken Ledgers{data.includesCoinbase ? " · Coinbase balances included" : ""}
              {data.cashFlowNote && <span className="text-yellow-500"> · {data.cashFlowNote}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Execution Quality panel ───────────────────────────────────────────────────
// Per-route feedback loop: fill rate + expected vs realized profit from every
// recorded execution attempt. This is what separates routes that LOOK
// profitable from routes that actually PAY.
function ExecutionQualityCard() {
  const { data } = useGetExecutionQuality({ query: { queryKey: getGetExecutionQualityQueryKey(), refetchInterval: 30_000, staleTime: 25_000 } });
  const rows = data?.routes ?? [];
  if (rows.length === 0) return null;
  return (
    <Card className="mt-6">
      <CardHeader className="py-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          Execution Quality
          <span className="text-[10px] font-mono text-muted-foreground font-normal">
            expected vs realized · feedback loop gates live execution
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="border-b-2 border-border bg-muted/50">
                {["Route", "Style", "Attempts", "Live", "Expected", "Realized", "Fill Rate", "Slippage", "Net P&L"].map(h => (
                  <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.route}|${r.style}`} className={cn("border-b border-border/50", i % 2 === 0 ? "" : "bg-muted/20")}>
                  <td className="px-3 py-1.5 font-bold whitespace-nowrap max-w-[240px] truncate" title={r.route}>{r.route}</td>
                  <td className="px-3 py-1.5 uppercase text-muted-foreground">{r.style}</td>
                  <td className="px-3 py-1.5">{r.attempts}</td>
                  <td className="px-3 py-1.5">{r.liveAttempts}</td>
                  <td className="px-3 py-1.5">{r.avgExpectedProfitUsd == null ? "—" : `$${r.avgExpectedProfitUsd.toFixed(4)}`}</td>
                  <td className={cn("px-3 py-1.5 font-bold", r.avgRealizedProfitUsd == null ? "text-muted-foreground" : r.avgRealizedProfitUsd > 0 ? "text-success" : "text-destructive")}
                    title={r.avgShortfallUsd == null ? undefined : `Shortfall vs expected: $${r.avgShortfallUsd.toFixed(4)}`}>
                    {r.avgRealizedProfitUsd == null ? "—" : `$${r.avgRealizedProfitUsd.toFixed(4)}`}
                  </td>
                  <td className={cn("px-3 py-1.5 font-bold", r.liveFillRate == null ? "text-muted-foreground" : r.liveFillRate >= 0.8 ? "text-success" : r.liveFillRate >= 0.5 ? "text-yellow-500" : "text-destructive")}>
                    {r.liveFillRate == null ? "—" : `${(r.liveFillRate * 100).toFixed(0)}%`}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {r.avgSlippagePct == null ? "—" : `${r.avgSlippagePct.toFixed(3)}%`}
                  </td>
                  <td className={cn("px-3 py-1.5 font-bold", r.totalRealizedProfitUsd == null ? "text-muted-foreground" : r.totalRealizedProfitUsd > 0 ? "text-success" : "text-destructive")}>
                    {r.totalRealizedProfitUsd == null ? "—" : `$${r.totalRealizedProfitUsd.toFixed(4)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-1.5 text-[9px] font-mono text-muted-foreground border-t border-border/50">
          Shortfall = scanner expectation − realized fills. Routes with ≥10 live attempts and &lt;50% fill rate are blocked from live execution (block decays 1h after the last attempt, earning a fresh probe); persistent shortfalls raise the edge a route must clear. When the top route is gated, AUTO immediately falls through to the next-best viable route.
        </div>
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
                {["Time","Trade ID","Status","Pair","Buy","Sell","Volume","Buy Price","Sell Price","Profit","Order IDs"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[10px] uppercase font-bold text-muted-foreground whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t, i) => {
                const verified = t.status === "verified";
                const failed = t.status === "failed";
                // Failed attempts must never display the scanner estimate as
                // profit: show realized (0 for zero-fill failures) or nothing.
                // Number(): legacy ledger rows can deliver profit as a string —
                // .toFixed on it crashes the whole dashboard.
                const rawProfit = t.realizedProfitUsd != null ? t.realizedProfitUsd
                  : failed ? null : t.estimatedProfitUsd;
                const profit = rawProfit != null ? Number(rawProfit) : null;
                const buyPrice = t.buyExchange === "Kraken" ? t.krakenPrice : t.coinbasePrice;
                const sellPrice = t.sellExchange === "Kraken" ? t.krakenPrice : t.coinbasePrice;
                return (
                  <tr key={t.id} className={cn("border-b border-border/50", i % 2 === 0 ? "" : "bg-muted/20")}>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{format(new Date(t.createdAt), "MM/dd HH:mm:ss")}</td>
                    <td className="px-3 py-1.5 font-bold">#{t.id}</td>
                    <td className="px-3 py-1.5">
                      <span className={cn("text-[9px] font-bold px-1 border",
                        verified ? "border-success text-success" :
                        failed ? "border-destructive text-destructive" :
                        "border-border text-muted-foreground")}>
                        {verified ? "✓ VERIFIED" : failed ? "✗ FAILED" : t.isDryRun || t.status === "simulated" ? "SIM" : "EST"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="text-[9px] font-mono font-bold px-1 border border-border text-muted-foreground">{t.pair ?? "SOL/USD"}</span>
                    </td>
                    <td className="px-3 py-1.5 text-success font-bold">{t.buyExchange}</td>
                    <td className="px-3 py-1.5 text-primary font-bold">{t.sellExchange}</td>
                    <td className="px-3 py-1.5">{Number(t.volume).toFixed(4)} {t.pair ? t.pair.split("/")[0] : "SOL"}</td>
                    <td className="px-3 py-1.5">${Number(buyPrice).toFixed(4)}</td>
                    <td className="px-3 py-1.5">${Number(sellPrice).toFixed(4)}</td>
                    <td className={cn("px-3 py-1.5 font-bold", profit != null && profit >= 0 ? "text-success" : profit != null ? "text-destructive" : "text-muted-foreground")}>
                      {profit == null ? "—" : `${profit >= 0 ? "+" : ""}$${profit.toFixed(4)}${!verified ? " est." : ""}`}
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
