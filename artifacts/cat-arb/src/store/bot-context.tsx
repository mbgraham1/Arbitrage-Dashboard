import React, {
  createContext, useContext, useEffect, useState, useRef, useCallback,
} from "react";
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
  minProfitUsd: number; // v11: minimum estimated net profit in USD
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
  minNetEdge: 0.05,   // v8: limit orders catch smaller spreads
  minProfitUsd: 1.00, // v11: minimum $1.00 estimated net profit to execute
  totalFees: 0.56,    // v8: Kraken maker 0.16% + Coinbase maker 0.40%
  slippage: 0.05,     // v8: limit orders have near-zero slippage
  cooldown: 30,
  pollInterval: 5,
};

// Bump this when defaults change meaningfully — forces a one-time reset for existing users
const SETTINGS_VERSION = 4;

export function BotProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  const [credentials, setCredentials] = useLocalStorage<ExchangeCredentials>("cat_arb_creds", EMPTY_CREDS);

  // Settings versioning: if stored version is old, reset to new defaults once
  const [storedSettingsRaw, setStoredSettingsRaw] = useLocalStorage<BotSettings & { _v?: number }>(
    "cat_arb_settings",
    { ...DEFAULT_SETTINGS, _v: SETTINGS_VERSION },
  );
  const needsMigration = !storedSettingsRaw._v || storedSettingsRaw._v < SETTINGS_VERSION;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _v: _ignored, ...storedSettingsClean } = storedSettingsRaw;
  const settings: BotSettings = needsMigration
    ? DEFAULT_SETTINGS
    : { ...DEFAULT_SETTINGS, ...storedSettingsClean };
  const setSettings = (s: BotSettings) => setStoredSettingsRaw({ ...s, _v: SETTINGS_VERSION });

  // Run migration once on mount
  const migrationDoneRef = useRef(false);
  useEffect(() => {
    if (migrationDoneRef.current) return;
    migrationDoneRef.current = true;
    if (needsMigration) {
      setStoredSettingsRaw({ ...DEFAULT_SETTINGS, _v: SETTINGS_VERSION });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [isRunning, setIsRunning] = useState(false);
  const [liveMode, setLiveMode] = useLocalStorage("cat_arb_live_mode", false);
  const [latestPriceData, setLatestPriceData] = useState<PriceData | null>(null);
  const [activityLog, setActivityLog] = useState<LogEntry[]>([]);
  const [sessionProfitUsd, setSessionProfitUsd] = useState(0);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [isForcingTrade, setIsForcingTrade] = useState(false);

  // ── Refs that give poll() always-current values without re-triggering effects ──
  const credentialsRef = useRef(credentials);
  const settingsRef = useRef(settings);
  const liveModeRef = useRef(liveMode);
  const latestPriceDataRef = useRef<PriceData | null>(null);

  useEffect(() => { credentialsRef.current = credentials; }, [credentials]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { liveModeRef.current = liveMode; }, [liveMode]);

  const lastTradeTimeRef = useRef<number>(0);
  const isExecutingRef = useRef<boolean>(false);

  const fetchPricesMutation = useFetchPrices();
  const executeTradeMutation = useExecuteTrade();

  // ── Preloaded credentials (run once) ─────────────────────────────────────────
  const preloadAppliedRef = useRef(false);
  const { data: preloaded } = useGetPreloadedCredentials();

  useEffect(() => {
    if (preloadAppliedRef.current || !preloaded?.anyLoaded) return;
    preloadAppliedRef.current = true;
    setSecretsLoaded(true);
    // Only fill in fields that are currently blank
    setCredentials({
      krakenKey: credentials.krakenKey || preloaded.krakenKey,
      krakenSecret: credentials.krakenSecret || preloaded.krakenSecret,
      coinbaseKey: credentials.coinbaseKey || preloaded.coinbaseKey,
      coinbaseSecret: credentials.coinbaseSecret || preloaded.coinbaseSecret,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloaded]);

  // ── Stable log helper ─────────────────────────────────────────────────────────
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
  }, []); // no deps — setActivityLog is stable

  const clearLog = useCallback(() => setActivityLog([]), []);

  // ── Shared execution (reads from refs, not closure) ───────────────────────────
  const runExecuteTrade = useCallback(
    async (data: PriceData, forced: boolean) => {
      const live = forced ? true : liveModeRef.current;
      const s = settingsRef.current;
      const creds = credentialsRef.current;
      // Force Trade always uses market orders; auto-loop uses limit (post-only, lower fees)
      const orderType = forced ? "market" : "limit";
      const tag = forced ? "[FORCE·MKT]" : live ? "[LIVE·LMT]" : "[DRY RUN]";
      const netEdge = data.grossSpreadPct - s.totalFees - s.slippage;

      const expectedProfit = Math.abs(data.sellPrice - data.buyPrice) * 1.0; // volume fixed at 1.0 SOL
      addLog("trade",
        `${tag} ${data.bestBuyExchange} → ${data.bestSellExchange} | ` +
        `1.0000 SOL | ` +
        `Buy $${data.buyPrice.toFixed(4)} | ` +
        `Sell $${data.sellPrice.toFixed(4)} | ` +
        `Net ${netEdge.toFixed(3)}%`
      );
      addLog("info", `${tag} Expected spread: $${expectedProfit.toFixed(2)}`);
      try {
        const res = await executeTradeMutation.mutateAsync({
          data: {
            krakenKey: creds.krakenKey,
            krakenSecret: creds.krakenSecret,
            coinbaseKey: creds.coinbaseKey,
            coinbaseSecret: creds.coinbaseSecret,
            buyExchange: data.bestBuyExchange,
            sellExchange: data.bestSellExchange,
            volume: 1.0,
            krakenPrice: data.krakenPrice,
            coinbasePrice: data.coinbasePrice,
            liveMode: live,
            netEdgePct: netEdge,
            orderType,
          },
        });
        if (res.success) {
          addLog("success", `${tag} Done — est. profit $${res.estimatedProfitUsd.toFixed(2)}`);
          setSessionProfitUsd((p) => p + res.estimatedProfitUsd);
          queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
        } else if (res.skipped) {
          addLog("warning", `${tag} ${res.error ?? "Trade skipped: insufficient balance."}`);
        } else {
          addLog("error", `${tag} Failed: ${res.error}`);
        }
      } catch (err) {
        addLog("error", `${tag} Exception: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    },
    // executeTradeMutation and queryClient are stable (React Query guarantees)
    [addLog, executeTradeMutation, queryClient],
  );

  // ── Force Trade ───────────────────────────────────────────────────────────────
  // Always executes on Kraken/Coinbase only — uses cached prices when available,
  // falls back to a fresh fetch, then buys on the cheaper side and sells on the
  // more expensive side (mirroring: k_price or kraken_rest(), c_price or coinbase_rest()).
  const forceTrade = useCallback(async () => {
    if (isExecutingRef.current) return;
    setIsForcingTrade(true);
    try {
      // Use cached prices if present (from latest WS snapshot), else fetch fresh
      let kPrice = latestPriceDataRef.current?.krakenPrice;
      let cPrice = latestPriceDataRef.current?.coinbasePrice;
      let priceData = latestPriceDataRef.current;

      if (!kPrice || !cPrice) {
        addLog("info", "[FORCE] Fetching prices...");
        priceData = await fetchPricesMutation.mutateAsync({ data: credentialsRef.current });
        latestPriceDataRef.current = priceData;
        setLatestPriceData(priceData);
        kPrice = priceData.krakenPrice;
        cPrice = priceData.coinbasePrice;
      }

      if (!kPrice || !cPrice || !priceData) {
        addLog("error", "[FORCE] Could not get Kraken/Coinbase prices");
        return;
      }

      // Determine direction: buy on cheaper exchange, sell on more expensive
      const buyEx  = kPrice < cPrice ? "Kraken"   : "Coinbase";
      const sellEx = kPrice < cPrice ? "Coinbase"  : "Kraken";
      const buyPrice      = Math.min(kPrice, cPrice);
      const sellPrice     = Math.max(kPrice, cPrice);
      const grossSpreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

      // Build a price-data object forced to the Kraken/Coinbase route
      const forcedData: PriceData = {
        ...priceData,
        bestBuyExchange: buyEx,
        bestSellExchange: sellEx,
        buyExchange: buyEx,
        sellExchange: sellEx,
        buyPrice,
        sellPrice,
        grossSpreadPct,
        route: `Buy ${buyEx} → Sell ${sellEx}`,
        executable: true,
      };

      await runExecuteTrade(forcedData, true);
    } catch (err) {
      addLog("error", `[FORCE] Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setIsForcingTrade(false);
    }
  }, [addLog, fetchPricesMutation, runExecuteTrade]);

  // ── Polling loop — only re-runs when isRunning changes ───────────────────────
  useEffect(() => {
    if (!isRunning) return;

    const creds = credentialsRef.current;
    if (!creds.krakenKey || !creds.coinbaseKey) {
      addLog("error", "Cannot start: missing API credentials.");
      setIsRunning(false);
      return;
    }

    addLog("info", "Bot engine started. Connecting to data streams...");

    let cancelled = false;

    const poll = async () => {
      if (cancelled || isExecutingRef.current) return;

      const c = credentialsRef.current;
      const s = settingsRef.current;
      const live = liveModeRef.current;

      try {
        const data = await fetchPricesMutation.mutateAsync({ data: c });
        if (cancelled) return;

        latestPriceDataRef.current = data;
        setLatestPriceData(data);

        const now = Date.now();
        const netEdge = data.grossSpreadPct - s.totalFees - s.slippage;
        const wsInfo = `[K:${data.wsStatus.kraken ? "WS" : "REST"} C:${data.wsStatus.coinbase ? "WS" : "REST"}]`;

        if (netEdge < s.minNetEdge) {
          addLog("info", `No trade — net ${netEdge.toFixed(3)}% < ${s.minNetEdge.toFixed(2)}% ${wsInfo}`);
          return;
        }

        const estimatedNetProfit = (netEdge / 100) * (data.buyPrice ?? 0) * 1.0;
        if (estimatedNetProfit < s.minProfitUsd) {
          addLog("info", `No trade — est. profit $${estimatedNetProfit.toFixed(2)} < $${s.minProfitUsd.toFixed(2)} minimum ${wsInfo}`);
          return;
        }

        const cooldownMs = s.cooldown * 1000;
        const elapsed = now - lastTradeTimeRef.current;
        if (elapsed < cooldownMs) {
          const remaining = Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000));
          addLog("warning", `Opportunity (${netEdge.toFixed(3)}%) — COOLDOWN ${remaining}s remaining`);
          return;
        }

        isExecutingRef.current = true;
        lastTradeTimeRef.current = now;
        try {
          await runExecuteTrade(data, false);
        } finally {
          isExecutingRef.current = false;
        }
      } catch (err) {
        if (!cancelled) {
          addLog("error", `Price fetch failed: ${err instanceof Error ? err.message : "Network error"}`);
        }
      }
    };

    // First poll immediately, then on interval
    void poll();
    const intervalMs = Math.max(2, settingsRef.current.pollInterval) * 1000;
    const id = setInterval(() => { void poll(); }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Intentionally only [isRunning] — refs give us live values without re-triggering
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

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
  const ctx = useContext(BotContext);
  if (!ctx) throw new Error("useBotContext must be used within a BotProvider");
  return ctx;
}
