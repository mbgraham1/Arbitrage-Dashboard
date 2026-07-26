import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import {
  useFetchPrices,
  useExecuteTrade,
  useGetPreloadedCredentials,
  getListTradesQueryKey,
  getGetTradeSummaryQueryKey,
} from "@workspace/api-client-react";
import type { ExchangeCredentials, PriceData } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export interface LogEntry {
  id: string;
  timestamp: string;
  type: "info" | "warning" | "success" | "error" | "trade";
  message: string;
}

export interface BotSettings {
  minNetEdge: number;
  totalFees: number;
  slippage: number;
  cooldown: number;
  pollInterval: number; // seconds
}

export interface BotContextType {
  credentials: ExchangeCredentials;
  setCredentials: (creds: ExchangeCredentials) => void;
  settings: BotSettings;
  setSettings: (settings: BotSettings) => void;
  isRunning: boolean;
  setIsRunning: (run: boolean) => void;
  liveMode: boolean;
  setLiveMode: (live: boolean) => void;
  latestPriceData: PriceData | null;
  activityLog: LogEntry[];
  sessionProfitUsd: number;
  addLog: (type: LogEntry["type"], message: string) => void;
  clearLog: () => void;
  secretsLoaded: boolean;
  forceTrade: () => Promise<void>;
  isForcingTrade: boolean;
}

const BotContext = createContext<BotContextType | undefined>(undefined);

const EMPTY_CREDS: ExchangeCredentials = {
  krakenKey: "",
  krakenSecret: "",
  coinbaseKey: "",
  coinbaseSecret: "",
};

const DEFAULT_SETTINGS: BotSettings = {
  minNetEdge: 0.10,
  totalFees: 0.80,
  slippage: 0.20,
  cooldown: 30,
  pollInterval: 5,
};

export function BotProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const [credentials, setCredentials] = useLocalStorage<ExchangeCredentials>("cat_arb_creds", EMPTY_CREDS);
  const [settings, setSettings] = useLocalStorage<BotSettings>("cat_arb_settings", DEFAULT_SETTINGS);
  const [isRunning, setIsRunning] = useState(false);
  const [liveMode, setLiveMode] = useLocalStorage("cat_arb_live_mode", false);
  const [latestPriceData, setLatestPriceData] = useState<PriceData | null>(null);
  const [activityLog, setActivityLog] = useState<LogEntry[]>([]);
  const [sessionProfitUsd, setSessionProfitUsd] = useState(0);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [isForcingTrade, setIsForcingTrade] = useState(false);

  const lastTradeTimeRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);

  const fetchPricesMutation = useFetchPrices();
  const executeTradeMutation = useExecuteTrade();

  // Auto-load credentials from Replit Secrets on mount
  const { data: preloaded } = useGetPreloadedCredentials();
  useEffect(() => {
    if (!preloaded?.anyLoaded) return;
    setSecretsLoaded(true);
    setCredentials((prev: ExchangeCredentials) => ({
      krakenKey: prev.krakenKey || preloaded.krakenKey,
      krakenSecret: prev.krakenSecret || preloaded.krakenSecret,
      coinbaseKey: prev.coinbaseKey || preloaded.coinbaseKey,
      coinbaseSecret: prev.coinbaseSecret || preloaded.coinbaseSecret,
    }));
  }, [preloaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const addLog = useCallback((type: LogEntry["type"], message: string) => {
    setActivityLog((prev) => {
      const entry: LogEntry = {
        id: Math.random().toString(36).substring(7),
        timestamp: new Date().toISOString(),
        type,
        message,
      };
      return [entry, ...prev].slice(0, 200);
    });
  }, []);

  const clearLog = useCallback(() => setActivityLog([]), []);

  // ── Shared execution helper ────────────────────────────────────────────────
  const executeTrade = useCallback(async (data: PriceData, isForced = false) => {
    const tag = isForced ? "[FORCE]" : liveMode ? "[LIVE]" : "[DRY RUN]";
    const netEdge = data.grossSpreadPct - settings.totalFees - settings.slippage;

    addLog("trade", `${tag} Executing — Net edge: ${netEdge.toFixed(3)}% · Route: ${data.route}`);

    try {
      const res = await executeTradeMutation.mutateAsync({
        data: {
          krakenKey: credentials.krakenKey,
          krakenSecret: credentials.krakenSecret,
          coinbaseKey: credentials.coinbaseKey,
          coinbaseSecret: credentials.coinbaseSecret,
          buyExchange: data.bestBuyExchange,
          sellExchange: data.bestSellExchange,
          volume: 1.0,
          krakenPrice: data.krakenPrice,
          coinbasePrice: data.coinbasePrice,
          liveMode: isForced ? true : liveMode,
          netEdgePct: netEdge,
        },
      });
      if (res.success) {
        addLog("success", `${tag} Done — Est. profit: $${res.estimatedProfitUsd.toFixed(2)}`);
        setSessionProfitUsd((p) => p + res.estimatedProfitUsd);
        queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
      } else {
        addLog("error", `${tag} Failed: ${res.error}`);
      }
    } catch (err: unknown) {
      addLog("error", `${tag} Exception: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }, [credentials, liveMode, settings, addLog, executeTradeMutation, queryClient]);

  // ── Force Trade ────────────────────────────────────────────────────────────
  const forceTrade = useCallback(async () => {
    if (isForcingTrade) return;
    setIsForcingTrade(true);
    try {
      let data = latestPriceData;
      // Fetch fresh prices if we don't have any
      if (!data) {
        addLog("info", "[FORCE] Fetching fresh prices...");
        data = await fetchPricesMutation.mutateAsync({ data: credentials });
        setLatestPriceData(data);
      }
      if (!data.executable) {
        addLog("warning", "[FORCE] Best route is not executable (signal on Binance/KuCoin only — no keys for those exchanges)");
        return;
      }
      await executeTrade(data, true);
    } catch (err: unknown) {
      addLog("error", `[FORCE] Price fetch failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsForcingTrade(false);
    }
  }, [isForcingTrade, latestPriceData, credentials, addLog, fetchPricesMutation, executeTrade]);

  // ── Bot polling loop ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRunning) return;

    const hasCreds = credentials.krakenKey && credentials.coinbaseKey;
    if (!hasCreds) {
      addLog("error", "Cannot start bot: Missing API credentials.");
      setIsRunning(false);
      return;
    }

    addLog("info", "Bot engine started. Connecting to data streams...");

    const poll = async () => {
      if (isExecutingRef.current) return;

      try {
        const data = await fetchPricesMutation.mutateAsync({ data: credentials });
        setLatestPriceData(data);

        const now = Date.now();
        const cooldownMs = settings.cooldown * 1000;
        const timeSinceLastTrade = now - lastTradeTimeRef.current;
        const cooldownElapsed = timeSinceLastTrade >= cooldownMs;

        const netEdge = data.grossSpreadPct - settings.totalFees - settings.slippage;

        // Log WS status on first few polls
        const wsInfo = `[Kraken WS: ${data.wsStatus.kraken ? "live" : "REST"} | Coinbase WS: ${data.wsStatus.coinbase ? "live" : "REST"}]`;

        if (!data.executable) {
          // Signal exists on a non-executable exchange pair
          addLog("info", `Signal: ${data.route} (net ${netEdge.toFixed(3)}%) — not executable with current keys ${wsInfo}`);
          return;
        }

        if (netEdge >= settings.minNetEdge) {
          if (!cooldownElapsed) {
            addLog("warning", `Opportunity (${netEdge.toFixed(3)}%) but in COOLDOWN (${Math.ceil((cooldownMs - timeSinceLastTrade) / 1000)}s remaining)`);
            return;
          }
          isExecutingRef.current = true;
          lastTradeTimeRef.current = Date.now();
          try {
            await executeTrade(data);
          } finally {
            isExecutingRef.current = false;
          }
        } else {
          addLog("info", `No trade — net edge ${netEdge.toFixed(3)}% < threshold ${settings.minNetEdge.toFixed(2)}% ${wsInfo}`);
        }
      } catch (error: unknown) {
        addLog("error", `Price fetch failed: ${error instanceof Error ? error.message : "Network error"}`);
      }
    };

    poll();
    const intervalMs = Math.max(2, settings.pollInterval) * 1000;
    const intervalId = setInterval(poll, intervalMs);

    return () => clearInterval(intervalId);
  }, [isRunning, credentials, settings, liveMode, addLog, executeTrade]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: BotContextType = {
    credentials,
    setCredentials,
    settings,
    setSettings,
    isRunning,
    setIsRunning,
    liveMode,
    setLiveMode,
    latestPriceData,
    activityLog,
    sessionProfitUsd,
    addLog,
    clearLog,
    secretsLoaded,
    forceTrade,
    isForcingTrade,
  };

  return <BotContext.Provider value={value}>{children}</BotContext.Provider>;
}

export function useBotContext() {
  const context = useContext(BotContext);
  if (context === undefined) {
    throw new Error("useBotContext must be used within a BotProvider");
  }
  return context;
}
