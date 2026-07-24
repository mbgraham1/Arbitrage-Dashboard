import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useFetchPrices, useExecuteTrade } from "@workspace/api-client-react";
import { ExchangeCredentials, PriceData } from "@workspace/api-client-react/src/generated/api.schemas";
import { useQueryClient } from "@tanstack/react-query";
import { getListTradesQueryKey, getGetTradeSummaryQueryKey } from "@workspace/api-client-react";

export interface LogEntry {
  id: string;
  timestamp: string;
  type: "info" | "warning" | "success" | "error" | "trade";
  message: string;
}

export interface BotContextType {
  // Settings
  credentials: ExchangeCredentials;
  setCredentials: (creds: ExchangeCredentials) => void;
  settings: { minNetEdge: number; totalFees: number; slippage: number; cooldown: number };
  setSettings: (settings: { minNetEdge: number; totalFees: number; slippage: number; cooldown: number }) => void;
  
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
}

const BotContext = createContext<BotContextType | undefined>(undefined);

export function BotProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useLocalStorage<ExchangeCredentials>("cat_arb_creds", {
    krakenKey: "",
    krakenSecret: "",
    coinbaseKey: "",
    coinbaseSecret: ""
  });
  
  const [settings, setSettings] = useLocalStorage("cat_arb_settings", {
    minNetEdge: 0.15,
    totalFees: 0.60,
    slippage: 0.20,
    cooldown: 60
  });

  const [isRunning, setIsRunning] = useState(false);
  const [liveMode, setLiveMode] = useLocalStorage("cat_arb_live_mode", false);
  const [latestPriceData, setLatestPriceData] = useState<PriceData | null>(null);
  const [activityLog, setActivityLog] = useState<LogEntry[]>([]);
  const [sessionProfitUsd, setSessionProfitUsd] = useState(0);
  
  const lastTradeTimeRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);
  
  const fetchPricesMutation = useFetchPrices();
  const executeTradeMutation = useExecuteTrade();

  const addLog = useCallback((type: LogEntry["type"], message: string) => {
    setActivityLog(prev => {
      const newLog = [{
        id: Math.random().toString(36).substring(7),
        timestamp: new Date().toISOString(),
        type,
        message
      }, ...prev];
      return newLog.slice(0, 200); // Keep last 200
    });
  }, []);

  const clearLog = useCallback(() => {
    setActivityLog([]);
  }, []);

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
      if (isExecutingRef.current) return; // Skip polling if currently executing a trade
      
      try {
        const data = await fetchPricesMutation.mutateAsync({ data: credentials });
        setLatestPriceData(data);
        
        const now = Date.now();
        const cooldownMs = settings.cooldown * 1000;
        const timeSinceLastTrade = now - lastTradeTimeRef.current;
        const cooldownElapsed = timeSinceLastTrade >= cooldownMs;

        // Trade Logic
        if (data.netEdgePct >= settings.minNetEdge) {
          if (!cooldownElapsed) {
            // Found edge but in cooldown
            addLog("warning", `Opportunity found (${data.netEdgePct.toFixed(3)}%) but bot is in COOLDOWN (${Math.ceil((cooldownMs - timeSinceLastTrade)/1000)}s)`);
            return;
          }

          if (liveMode) {
            // LIVE TRADE
            addLog("trade", `[LIVE] Executing trade! Edge: ${data.netEdgePct.toFixed(3)}% Route: ${data.route}`);
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
                  volume: 1.0, // Default volume for now, could be dynamic
                  krakenPrice: data.krakenPrice,
                  coinbasePrice: data.coinbasePrice,
                  liveMode: true,
                  netEdgePct: data.netEdgePct
                }
              });

              if (res.success) {
                addLog("success", `[LIVE] Trade complete. Estimated Profit: $${res.estimatedProfitUsd.toFixed(2)}`);
                setSessionProfitUsd(prev => prev + res.estimatedProfitUsd);
                queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
              } else {
                addLog("error", `[LIVE] Trade failed: ${res.error}`);
              }
            } catch (err: any) {
              addLog("error", `[LIVE] Trade exception: ${err.message || 'Unknown error'}`);
            } finally {
              isExecutingRef.current = false;
            }
          } else {
            // DRY RUN
            addLog("trade", `[DRY RUN] Would trade. Edge: ${data.netEdgePct.toFixed(3)}% Route: ${data.route}`);
            lastTradeTimeRef.current = Date.now();
            
            try {
              // We still call executeTrade but with liveMode: false to record it
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
                  netEdgePct: data.netEdgePct
                }
              });
              
              if (res.success) {
                addLog("success", `[DRY RUN] Trade recorded. Est. Profit: $${res.estimatedProfitUsd.toFixed(2)}`);
                setSessionProfitUsd(prev => prev + res.estimatedProfitUsd);
                queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
              } else {
                 addLog("error", `[DRY RUN] Failed to record: ${res.error}`);
              }
            } catch (err: any) {
              // Ignore network errors in dry run recording
            }
          }
        }
      } catch (error: any) {
        addLog("error", `Price fetch failed: ${error.message || 'Network error'}`);
      }
    };

    // Initial poll
    poll();
    
    // Set up interval
    const intervalId = setInterval(poll, 3000);
    
    return () => clearInterval(intervalId);
  }, [isRunning, credentials, settings, liveMode, addLog, fetchPricesMutation, executeTradeMutation, queryClient]);

  const value = {
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
    clearLog
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
