import * as React from "react"
import { Link, useLocation } from "wouter"
import { Activity, Settings, LayoutDashboard, Terminal, Zap, RotateCcw, Skull, Eraser } from "lucide-react"
import { useClearExecLock, useClearRouteHistory } from "@workspace/api-client-react"
import { cn } from "@/lib/utils"
import { BotProvider, useBotContext, ALL_PAIRS } from "@/store/bot-context"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

function NavItem({ href, icon: Icon, label }: { href: string; icon: any; label: string }) {
  const [location] = useLocation()
  const isActive = location === href
  
  return (
    <Link href={href} className={cn(
      "flex items-center gap-2 px-4 py-3 text-sm font-bold uppercase tracking-wider transition-colors border-l-2 lg:border-l-0 lg:border-b-2",
      isActive 
        ? "border-primary text-primary bg-primary/5" 
        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted"
    )}>
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </Link>
  )
}

function ForceModeControls() {
  const { forceMode, setForceMode, addLog, credentials } = useBotContext();
  const clearLock = useClearExecLock();
  const clearHistory = useClearRouteHistory();
  const clearBlacklist = async () => {
    try {
      const r = await clearHistory.mutateAsync();
      addLog("warning", `[CLEAR·BL] Route blacklist wiped — ${r.clearedRoutes} route record(s) reset; all fill-rate streaks back to 0.`);
    } catch (e) {
      addLog("error", `[CLEAR·BL] Failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };
  const hardReset = async (cancelOrders: boolean) => {
    const tag = cancelOrders ? "[KILL·SWITCH]" : "[HARD·RESET]";
    if (!credentials.krakenKey || !credentials.krakenSecret) {
      addLog("warning", `${tag} Add Kraken credentials in Config first — clearing the lock requires proof of account ownership.`);
      return;
    }
    try {
      const r = await clearLock.mutateAsync({ data: { krakenKey: credentials.krakenKey, krakenSecret: credentials.krakenSecret, cancelOrders } });
      const cancelled = cancelOrders ? ` ${r.cancelledOrders ?? 0} open Kraken order(s) cancelled.` : "";
      addLog("warning", `${tag} Execution lock force-cleared${r.wasHeld ? " (a live execution WAS holding it)" : " (lock was already free)"}.${cancelled}`);
    } catch (e) {
      addLog("error", `${tag} Failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };
  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                const next = !forceMode;
                setForceMode(next);
                addLog(next ? "warning" : "info", next
                  ? "[FORCE·MODE] ON — fill-rate gate & blacklist DISABLED; any fresh-profit route ≥ $0.01 executes."
                  : "[FORCE·MODE] OFF — history-based gates re-enabled.");
              }}
              className={cn(
                "flex items-center gap-2 px-2 py-1 border-2 text-xs font-bold uppercase tracking-wider transition-colors",
                forceMode ? "border-destructive text-destructive bg-destructive/10 animate-pulse" : "border-border text-muted-foreground hover:text-foreground",
              )}
              data-testid="button-force-mode"
            >
              <Zap className="h-3 w-3" />
              {forceMode ? "FORCE: ON" : "FORCE: OFF"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            <p className="text-[11px]">FORCE MODE bypasses the fill-rate gate and route blacklist entirely. Fresh pre-flight pricing still gates every trade at ≥ $0.01 net.</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => hardReset(false)}
              disabled={clearLock.isPending}
              className="flex items-center gap-2 px-2 py-1 border-2 border-border text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-destructive hover:border-destructive transition-colors disabled:opacity-50"
              data-testid="button-hard-reset"
            >
              <RotateCcw className="h-3 w-3" />
              {clearLock.isPending ? "…" : "HARD RESET"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            <p className="text-[11px]">Force-clears the live execution lock if a dead route is holding it. If a trade is genuinely mid-flight, clearing allows concurrent execution — use only when stuck.</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={clearBlacklist}
              disabled={clearHistory.isPending}
              className="flex items-center gap-2 px-2 py-1 border-2 border-border text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              data-testid="button-clear-blacklist"
            >
              <Eraser className="h-3 w-3" />
              {clearHistory.isPending ? "…" : "CLEAR BL"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            <p className="text-[11px]">Clears the route blacklist: all consecutive-failure streaks reset to 0, every banned route re-enabled, probe cool-downs wiped.</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => hardReset(true)}
              disabled={clearLock.isPending}
              className="flex items-center gap-2 px-2 py-1 border-2 border-destructive text-xs font-bold uppercase tracking-wider text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
              data-testid="button-kill-switch"
            >
              <Skull className="h-3 w-3" />
              {clearLock.isPending ? "…" : "KILL"}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[220px]">
            <p className="text-[11px]">KILL SWITCH: cancels ALL open Kraken orders on the account, then force-clears the execution lock. One click, full stop.</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </>
  );
}

function StatusIndicator() {
  const { isRunning, liveMode, settings } = useBotContext();
  const filtered = settings.enabledPairs.length < ALL_PAIRS.length;

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-2 border-border bg-card">
      <div className="flex items-center gap-2">
        <div className={cn("h-3 w-3 rounded-full animate-pulse", isRunning ? "bg-success" : "bg-muted-foreground")} />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {isRunning ? "Engine: RUNNING" : "Engine: IDLE"}
        </span>
      </div>
      <div className="h-4 w-px bg-border" />
      <ForceModeControls />
      <div className="h-4 w-px bg-border" />
      <div className="flex items-center gap-2">
        <div className={cn("h-3 w-3 rounded-none", liveMode ? "bg-destructive animate-pulse" : "bg-primary")} />
        <span className={cn("text-xs font-bold uppercase tracking-wider", liveMode ? "text-destructive" : "text-primary")}>
          {liveMode ? "MODE: LIVE" : "MODE: DRY RUN"}
        </span>
      </div>
      <div className="h-4 w-px bg-border" />
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn(
              "text-xs font-mono font-bold uppercase cursor-default",
              filtered ? "text-yellow-600" : "text-muted-foreground",
            )}>
              {settings.enabledPairs.length}/{ALL_PAIRS.length} pairs
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[180px]">
            <p className="font-bold mb-1 text-[10px] uppercase tracking-wide">Watching pairs</p>
            <ul className="flex flex-col gap-0.5">
              {settings.enabledPairs.map((p) => (
                <li key={p} className="font-mono text-[11px]">{p}</li>
              ))}
            </ul>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <BotProvider>
      <div className="min-h-[100dvh] flex flex-col terminal-grid relative">
        {/* Header */}
        <header className="sticky top-0 z-50 w-full border-b-2 border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container max-w-7xl mx-auto flex h-16 items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <div className="bg-primary text-primary-foreground p-1.5 border-2 border-primary-foreground shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)]">
                <Terminal className="h-5 w-5" />
              </div>
              <div className="flex flex-col">
                <span className="font-bold text-lg leading-none uppercase tracking-tighter">CAT_ARB</span>
                <span className="text-[10px] font-mono leading-none text-muted-foreground">BUTTER_PROTOCOL_v1.0</span>
              </div>
            </div>
            
            <nav className="hidden lg:flex items-center self-end h-full">
              <NavItem href="/" icon={LayoutDashboard} label="Dashboard" />
              <NavItem href="/trades" icon={Activity} label="Ledger" />
              <NavItem href="/settings" icon={Settings} label="Config" />
            </nav>
            
            <div className="hidden md:flex">
              <StatusIndicator />
            </div>
          </div>
        </header>

        {/* Mobile Nav */}
        <div className="lg:hidden border-b-2 border-border bg-card flex overflow-x-auto">
          <NavItem href="/" icon={LayoutDashboard} label="Dashboard" />
          <NavItem href="/trades" icon={Activity} label="Ledger" />
          <NavItem href="/settings" icon={Settings} label="Config" />
        </div>
        {/* Mobile force-mode controls (StatusIndicator is desktop-only) */}
        <div className="md:hidden border-b-2 border-border bg-card flex items-center gap-3 px-4 py-2">
          <ForceModeControls />
        </div>

        {/* Main Content */}
        <main className="flex-1 container max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </BotProvider>
  )
}
