import * as React from "react"
import { Link, useLocation } from "wouter"
import { Activity, Settings, LayoutDashboard, Terminal } from "lucide-react"
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

        {/* Main Content */}
        <main className="flex-1 container max-w-7xl mx-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </BotProvider>
  )
}
