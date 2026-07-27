import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import {
  Activity, Play, Square, DollarSign, TrendingUp, Zap, ShieldAlert,
  FileText, ArrowRight, Radio, Wifi, WifiOff, Siren,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useFetchBalances } from "@workspace/api-client-react";

// ── Small helpers ──────────────────────────────────────────────────────────────

function PriceTile({
  label,
  price,
  isWs,
  wsLive,
  highlight,
  tag,
}: {
  label: string;
  price: number | null | undefined;
  isWs?: boolean;
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
          {isWs ? (
            wsLive
              ? <Wifi className="h-3 w-3 text-success" />
              : <WifiOff className="h-3 w-3 text-yellow-500" />
          ) : (
            <span className="text-[9px] font-mono text-muted-foreground">REST</span>
          )}
        </div>
      </div>
      <span className={cn(
        "font-mono text-lg font-bold leading-none",
        highlight === "buy" && "text-success",
        highlight === "sell" && "text-primary",
        !highlight && "text-foreground",
      )}>
        {price != null ? `$${price.toFixed(2)}` : "—"}
      </span>
    </div>
  );
}

// ── Main Dashboard ─────────────────────────────────────────────────────────────

export default function Dashboard() {
  const {
    isRunning, setIsRunning, liveMode,
    latestPriceData, activityLog, sessionProfitUsd,
    settings, credentials, addLog,
    forceTrade, isForcingTrade,
  } = useBotContext();

  const fetchBalancesMutation = useFetchBalances();
  const [balances, setBalances] = React.useState<{
    solOnKraken?: number; solOnCoinbase?: number; usdOnCoinbase?: number;
  } | null>(null);

  React.useEffect(() => {
    if (credentials.krakenKey && credentials.coinbaseKey) {
      fetchBalancesMutation.mutateAsync({ data: credentials })
        .then(res => setBalances(res))
        .catch(err => console.error("Failed to fetch balances", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials.krakenKey, credentials.coinbaseKey]);

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
            4-Exchange Scanner · WebSocket + REST
          </p>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto flex-wrap">
          <div className="bg-muted px-4 py-2 border-2 border-border flex flex-col items-end flex-1 md:flex-none">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">Session P&L</span>
            <span className={cn("text-xl font-mono font-bold leading-none", sessionProfitUsd > 0 ? "text-success" : sessionProfitUsd < 0 ? "text-destructive" : "")}>
              {sessionProfitUsd >= 0 ? "+" : "-"}${Math.abs(sessionProfitUsd).toFixed(2)}
            </span>
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
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left Column */}
        <div className="flex flex-col gap-6">

          {/* 4-Exchange Price Grid */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Radio className="h-4 w-4" /> Market Scan
                {latestPriceData && (
                  <span className={cn(
                    "ml-auto text-[10px] font-mono font-bold px-2 py-0.5 border",
                    latestPriceData.executable
                      ? "border-success text-success"
                      : "border-yellow-500 text-yellow-500"
                  )}>
                    {latestPriceData.executable ? "EXECUTABLE" : "SIGNAL ONLY"}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 grid grid-cols-2 gap-2">
              <PriceTile
                label="Kraken"
                price={latestPriceData?.krakenPrice}
                isWs
                wsLive={latestPriceData?.wsStatus.kraken}
                highlight={highlightFor("Kraken")}
                tag={tagFor("Kraken")}
              />
              <PriceTile
                label="Coinbase"
                price={latestPriceData?.coinbasePrice}
                isWs
                wsLive={latestPriceData?.wsStatus.coinbase}
                highlight={highlightFor("Coinbase")}
                tag={tagFor("Coinbase")}
              />
              <PriceTile
                label="Binance"
                price={latestPriceData?.binancePrice}
                highlight={highlightFor("Binance")}
                tag={tagFor("Binance")}
              />
              <PriceTile
                label="KuCoin"
                price={latestPriceData?.kuCoinPrice}
                highlight={highlightFor("KuCoin")}
                tag={tagFor("KuCoin")}
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
                  <span className="font-mono text-sm leading-tight">{latestPriceData?.route || "—"}</span>
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
                  <span className="text-muted-foreground uppercase text-[10px]">Fees + Slip</span>
                  <span>{(settings.totalFees + settings.slippage).toFixed(2)}%</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Buy At</span>
                  <span className="text-success">${latestPriceData?.buyPrice.toFixed(2) ?? "—"}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground uppercase text-[10px]">Sell At</span>
                  <span className="text-primary">${latestPriceData?.sellPrice.toFixed(2) ?? "—"}</span>
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
              {fetchBalancesMutation.isPending && !balances ? (
                <div className="p-8 text-center text-sm font-mono text-muted-foreground animate-pulse">Loading...</div>
              ) : balances ? (
                <div className="flex flex-col">
                  <div className="p-4 border-b-2 border-border flex justify-between items-center">
                    <span className="font-bold text-sm">Kraken SOL</span>
                    <span className="font-mono">{balances.solOnKraken?.toFixed(4) ?? "0.0000"}</span>
                  </div>
                  <div className="p-4 border-b-2 border-border flex justify-between items-center bg-muted/20">
                    <span className="font-bold text-sm">Coinbase SOL</span>
                    <span className="font-mono">{balances.solOnCoinbase?.toFixed(4) ?? "0.0000"}</span>
                  </div>
                  <div className="p-4 flex justify-between items-center bg-primary/5">
                    <span className="font-bold text-sm text-primary">Coinbase USD</span>
                    <span className="font-mono text-primary font-bold">${balances.usdOnCoinbase?.toFixed(2) ?? "0.00"}</span>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-sm font-mono text-muted-foreground">Credentials not configured</div>
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
    </div>
  );
}
