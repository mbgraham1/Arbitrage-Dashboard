import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBotContext } from "@/store/bot-context";
import { Activity, Play, Square, DollarSign, TrendingUp, Zap, Clock, ShieldAlert, FileText, ArrowRight } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useFetchBalances } from "@workspace/api-client-react";

export default function Dashboard() {
  const { 
    isRunning, setIsRunning, liveMode, 
    latestPriceData, activityLog, sessionProfitUsd,
    settings, credentials, addLog
  } = useBotContext();
  
  const fetchBalancesMutation = useFetchBalances();
  const [balances, setBalances] = React.useState<any>(null);

  React.useEffect(() => {
    if (credentials.krakenKey && credentials.coinbaseKey) {
      fetchBalancesMutation.mutateAsync({ data: credentials })
        .then(res => setBalances(res))
        .catch(err => console.error("Failed to fetch balances", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials.krakenKey, credentials.coinbaseKey]);

  const toggleBot = () => {
    const hasCreds = credentials.krakenKey && credentials.coinbaseKey;
    if (!hasCreds && !isRunning) {
      addLog("error", "Cannot start bot without API credentials. Go to Settings.");
      return;
    }
    setIsRunning(!isRunning);
  };

  const hasEdge = latestPriceData && latestPriceData.netEdgePct >= settings.minNetEdge;

  return (
    <div className="flex flex-col gap-6">
      
      {/* Top Action Bar */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-card p-4 border-2 border-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.05)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.05)]">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold uppercase tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            Control Deck
          </h1>
          <p className="text-muted-foreground font-mono text-sm">Main Arbitrage Engine Interface</p>
        </div>
        
        <div className="flex items-center gap-4 w-full md:w-auto">
          <div className="bg-muted px-4 py-2 border-2 border-border flex flex-col items-end flex-1 md:flex-none">
            <span className="text-[10px] uppercase font-bold text-muted-foreground">Session P&L</span>
            <span className={cn("text-xl font-mono font-bold leading-none", sessionProfitUsd > 0 ? "text-success" : sessionProfitUsd < 0 ? "text-destructive" : "")}>
              {sessionProfitUsd >= 0 ? "+" : "-"}${Math.abs(sessionProfitUsd).toFixed(2)}
            </span>
          </div>
          
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
        
        {/* Left Column: Metrics & Balances */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap className="h-4 w-4" /> Live Spread
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 flex flex-col gap-4">
              <div className="flex justify-between items-center">
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-muted-foreground uppercase">Kraken (SOL/USD)</span>
                  <span className="font-mono text-xl font-bold">
                    ${latestPriceData?.krakenPrice.toFixed(2) || "---.--"}
                  </span>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <div className="flex flex-col items-end">
                  <span className="text-xs font-bold text-muted-foreground uppercase">Coinbase (SOL/USD)</span>
                  <span className="font-mono text-xl font-bold">
                    ${latestPriceData?.coinbasePrice.toFixed(2) || "---.--"}
                  </span>
                </div>
              </div>
              
              <div className="h-px bg-border w-full" />
              
              <div className="flex justify-between items-center">
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-muted-foreground uppercase">Route</span>
                  <span className="font-mono text-sm">{latestPriceData?.route || "NONE"}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-xs font-bold text-muted-foreground uppercase">Net Edge</span>
                  <div className={cn(
                    "font-mono text-2xl font-bold px-2 py-0.5 border-2",
                    hasEdge ? "bg-success text-success-foreground border-transparent animate-pulse" : "bg-muted text-muted-foreground border-border"
                  )}>
                    {latestPriceData ? `${latestPriceData.netEdgePct.toFixed(3)}%` : "0.000%"}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <DollarSign className="h-4 w-4" /> Exchange Balances
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {fetchBalancesMutation.isPending && !balances ? (
                <div className="p-8 text-center text-sm font-mono text-muted-foreground animate-pulse">Loading balances...</div>
              ) : balances ? (
                <div className="flex flex-col">
                  <div className="p-4 border-b-2 border-border flex justify-between items-center">
                    <span className="font-bold text-sm">Kraken SOL</span>
                    <span className="font-mono">{balances.solOnKraken?.toFixed(4) || "0.0000"}</span>
                  </div>
                  <div className="p-4 border-b-2 border-border flex justify-between items-center bg-muted/20">
                    <span className="font-bold text-sm">Coinbase SOL</span>
                    <span className="font-mono">{balances.solOnCoinbase?.toFixed(4) || "0.0000"}</span>
                  </div>
                  <div className="p-4 flex justify-between items-center bg-primary/5">
                    <span className="font-bold text-sm text-primary">Coinbase USD</span>
                    <span className="font-mono text-primary font-bold">${balances.usdOnCoinbase?.toFixed(2) || "0.00"}</span>
                  </div>
                </div>
              ) : (
                <div className="p-8 text-center text-sm font-mono text-muted-foreground">Credentials not configured</div>
              )}
            </CardContent>
          </Card>

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
              {isRunning && <span className="flex h-2 w-2 rounded-full bg-success animate-pulse" />}
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
