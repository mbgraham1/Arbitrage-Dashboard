import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useFetchPrices, useExecuteTrade, useGetPreloadedCredentials, getListTradesQueryKey, getGetTradeSummaryQueryKey } from "@workspace/api-client-react";
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
  // Settings
  credentials: ExchangeCredentials;
  setCredentials: (creds: ExchangeCredentials) => void;
  settings: BotSettings;
  setSettings: (settings: BotSettings) => void;

  // State
  isRunning: boolean;
  setIsRunning: (run: boolean) => void;
  liveMode: boolean;
  setLiveMode: (live: boolean) => void;

  // Live Data
  latestPriceData: PriceData | null;
  activityLog: LogEntry[];
  sessionProfitUsd: number;
  addLog: (type: LogEntry["type"], message: string) => void;
  clearLog: () => void;

  // Secrets
  secretsLoaded: boolean;
}

const BotContext = createContext<BotContextType | undefined>(undefined);

const EMPTY_CREDS: ExchangeCredentials = {
  krakenKey: "",
  krakenSecret: "",
  coinbaseKey: "",
  coinbaseSecret: "",
};

const DEFAULT_SETTINGS: BotSettings = {
  minNetEdge: 0.15,
  totalFees: 0.80,
  slippage: 0.20,
  cooldown: 60,
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

  const lastTradeTimeRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);

  const fetchPricesMutation = useFetchPrices();
  const executeTradeMutation = useExecuteTrade();

  // Load credentials from Replit Secrets on mount — only pre-fill if localStorage is blank
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

        // Compute net edge after fees + slippage
        const netEdge = data.grossSpreadPct - settings.totalFees - settings.slippage;

        if (netEdge >= settings.minNetEdge) {
          if (!cooldownElapsed) {
            addLog(
              "warning",
              `Opportunity (${netEdge.toFixed(3)}%) but in COOLDOWN (${Math.ceil((cooldownMs - timeSinceLastTrade) / 1000)}s remaining)`
            );
            return;
          }

          if (liveMode) {
            addLog("trade", `[LIVE] Executing trade! Net edge: ${netEdge.toFixed(3)}% · Route: ${data.route}`);
            isExecutingRef.current = true;
            lastTradeTimeRef.current = Date.now();

            try {
              const res = await executeTradeMutation.mutateAsync({
                data: {
                  krakenKey: credentials.krakenKey,
                  krakenSecret: credentials.krakenSecret,
                  coinbaseKey: credentials.coinbaseKey,
                  coinbaseSecret: credentials.coinbaseSecret,
                  buyExchange: data.buyExchange || "",
                  sellExchange: data.sellExchange || "",
                  volume: 1.0,
                  krakenPrice: data.krakenPrice,
                  coinbasePrice: data.coinbasePrice,
                  liveMode: true,
                  netEdgePct: netEdge,
                },
              });
              if (res.success) {
                addLog("success", `[LIVE] Trade complete — Est. profit: $${res.estimatedProfitUsd.toFixed(2)}`);
                setSessionProfitUsd((p) => p + res.estimatedProfitUsd);
                queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
              } else {
                addLog("error", `[LIVE] Trade failed: ${res.error}`);
              }
            } catch (err: unknown) {
              addLog("error", `[LIVE] Trade exception: ${err instanceof Error ? err.message : "Unknown error"}`);
            } finally {
              isExecutingRef.current = false;
            }
          } else {
            addLog("trade", `[DRY RUN] Would trade — Net edge: ${netEdge.toFixed(3)}% · Route: ${data.route}`);
            lastTradeTimeRef.current = Date.now();

            try {
              const res = await executeTradeMutation.mutateAsync({
                data: {
                  krakenKey: credentials.krakenKey,
                  krakenSecret: credentials.krakenSecret,
                  coinbaseKey: credentials.coinbaseKey,
                  coinbaseSecret: credentials.coinbaseSecret,
                  buyExchange: data.buyExchange || "",
                  sellExchange: data.sellExchange || "",
                  volume: 1.0,
                  krakenPrice: data.krakenPrice,
                  coinbasePrice: data.coinbasePrice,
                  liveMode: false,
                  netEdgePct: netEdge,
                },
              });
              if (res.success) {
                addLog("success", `[DRY RUN] Recorded — Est. profit: $${res.estimatedProfitUsd.toFixed(2)}`);
                setSessionProfitUsd((p) => p + res.estimatedProfitUsd);
                queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
              }
            } catch {
              // Ignore recording errors in dry run
            }
          }
        } else {
          addLog("info", `No trade — net edge ${netEdge.toFixed(3)}% < threshold ${settings.minNetEdge.toFixed(2)}%`);
        }
      } catch (error: unknown) {
        addLog("error", `Price fetch failed: ${error instanceof Error ? error.message : "Network error"}`);
      }
    };

    poll();
    const intervalMs = Math.max(2, settings.pollInterval) * 1000;
    const intervalId = setInterval(poll, intervalMs);

    return () => clearInterval(intervalId);
  }, [isRunning, credentials, settings, liveMode, addLog]); // eslint-disable-line react-hooks/exhaustive-deps

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
