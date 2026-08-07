import React, {
  createContext, useContext, useEffect, useState, useRef, useCallback,
} from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import {
  useFetchPrices,
  useFetchBalances,
  useExecuteTrade,
  useExecuteTriangular,
  useGetPreloadedCredentials,
  useScanTriangularArb,
  useScanCointegrationArb,
  getScanTriangularArbQueryKey,
  getScanCointegrationArbQueryKey,
  getListTradesQueryKey,
  getGetTradeSummaryQueryKey,
  scanAllPairs,
  useGetObScan,
  useObExecute,
  getGetObScanQueryKey,
} from "@workspace/api-client-react";
import type { ExchangeCredentials, PriceData, BalanceData, TriangularOpportunity, CointegrationSignal, ObCycleEntry } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export interface LogEntry {
  id: string;
  timestamp: string;
  type: "info" | "warning" | "success" | "error" | "trade" | "coint";
  message: string;
}

export const ALL_PAIRS = [
  "BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD", "DOT/USD",
  "POL/USD", "LINK/USD", "UNI/USD", "ATOM/USD", "ADA/USD",
] as const;

export type ScanPair = typeof ALL_PAIRS[number];

export interface BotSettings {
  minNetEdge: number;
  minProfitUsd: number;   // v11: minimum estimated net profit in USD
  maxDailyLoss: number;   // v11: stop bot when cumulative loss exceeds this (USD)
  totalFees: number;
  slippage: number;
  cooldown: number;
  pollInterval: number; // seconds
  // Kelly Criterion position sizing
  winRate: number;       // estimated win rate (default 0.55)
  kellyFraction: number; // fractional Kelly cap (default 0.25 = quarter-Kelly)
  maxPositionSol: number; // hard cap in SOL (default 1.0)
  // Pair selection — which of the 10 pairs the scanner watches
  enabledPairs: string[];
  // Order Book Hunter parameters
  obTradeSize: number;  // v8: trade size in USD for OB scans (default $10)
  obFeesPct: number;    // v8: estimated fee per leg in % for OB scans (default 0.40%)
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
  cachedBalances: BalanceData | null;
  activityLog: LogEntry[];
  sessionProfitUsd: number;
  sessionTradeCount: number;
  apiLatencyMs: number | null;
  dailyLoss: number;
  failedTrades: number;
  startTime: number | null;
  emergencyStop: boolean;
  setEmergencyStop: (v: boolean) => void;
  addLog: (type: LogEntry["type"], message: string) => void;
  clearLog: () => void;
  secretsLoaded: boolean;
  forceTrade: () => Promise<void>;
  isForcingTrade: boolean;
  /** Manually fire the best BTC triangular loop (market orders, $10 test) */
  forceTriangular: () => Promise<void>;
  isForcingTriangular: boolean;
  /**
   * True while any triangular trade (force or auto) is executing.
   * Used by the dashboard TRI card to show EXECUTING state.
   */
  isExecutingTriangular: boolean;
  /** Latest triangular arb opportunities from the server-side scan */
  triOpportunities: TriangularOpportunity[];
  /**
   * Per-exchange ETH/SOL price source from the latest triangular scan.
   * "direct" = live Kraken ETHSOL WS market; "synthetic" = computed cross rate.
   */
  triPriceSource: Record<string, "direct" | "synthetic">;
  /** Latest cointegration mean-reversion signals from the Kalman filter scan */
  cointSignals: CointegrationSignal[];
  /** Latest OB scan cycles from the Order Book Hunter */
  obCycles: ObCycleEntry[];
  /** True while the auto-execute OB trade is in-flight */
  isAutoExecutingOb: boolean;
}

const BotContext = createContext<BotContextType | undefined>(undefined);

const EMPTY_CREDS: ExchangeCredentials = {
  krakenKey: "",
  krakenSecret: "",
  coinbaseKey: "",
  coinbaseSecret: "",
};

const DEFAULT_SETTINGS: BotSettings = {
  minNetEdge: 0.05,    // v8: limit orders catch smaller spreads
  minProfitUsd: 1.00,  // v11: minimum $1.00 estimated net profit to execute
  maxDailyLoss: 25.00, // v11: halt if cumulative loss exceeds $25.00
  totalFees: 0.56,     // v8: Kraken maker 0.16% + Coinbase maker 0.40%
  slippage: 0.05,      // v8: limit orders have near-zero slippage
  cooldown: 30,
  pollInterval: 5,
  winRate: 0.55,        // Kelly: estimated historical win rate
  kellyFraction: 0.25,  // Kelly: quarter-Kelly for conservative sizing
  maxPositionSol: 1.0,  // Kelly: hard cap per trade (SOL)
  enabledPairs: [...ALL_PAIRS], // all 10 pairs enabled by default
  obTradeSize: 10,      // v8: OB Hunter default $10 trade size
  obFeesPct: 0.16,      // v8: OB Hunter default 0.16% fee per leg (Kraken post-only maker rate)
};

// Bump this when defaults change meaningfully — forces a one-time reset for existing users
const SETTINGS_VERSION = 8;

// ── Kelly Criterion position sizer ────────────────────────────────────────────
// Direct port of Python KellySizer.calculate()
// f* = (b·p − q) / b   where b = edge fraction, p = win rate, q = 1−p
// maxPositionUsd is the hard USD cap (= settings.maxPositionSol × SOL reference price).
// Capping in USD keeps BTC/ETH/ATOM positions at the same dollar risk as SOL,
// regardless of the asset's unit price.
function kellySize(
  edgePct: number,
  bankrollUsd: number,
  winRate: number,
  kellyFraction: number,
  buyPrice: number,
  maxPositionUsd: number,
): number {
  if (edgePct <= 0 || bankrollUsd <= 0 || buyPrice <= 0) return 0;
  const b = edgePct / 100;
  const p = winRate;
  const q = 1 - p;
  const fStar = b > 0 ? (b * p - q) / b : 0;
  const f = Math.max(0, Math.min(fStar, kellyFraction));
  const sizeUsd = Math.min(bankrollUsd * f, maxPositionUsd); // cap in USD, not base units
  return Math.max(sizeUsd / buyPrice, 0);
}

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
  const [cachedBalances, setCachedBalances] = useState<BalanceData | null>(null);
  const [activityLog, setActivityLog] = useState<LogEntry[]>([]);
  const [sessionProfitUsd, setSessionProfitUsd] = useState(0);
  const [sessionTradeCount, setSessionTradeCount] = useState(0);
  const [apiLatencyMs, setApiLatencyMs] = useState<number | null>(null);
  const [dailyLoss, setDailyLoss] = useState(0);
  const [failedTrades, setFailedTrades] = useState(0);
  const [emergencyStop, setEmergencyStop] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [isForcingTrade, setIsForcingTrade] = useState(false);
  const [isForcingTriangular, setIsForcingTriangular] = useState(false);
  const [isAutoExecutingTri, setIsAutoExecutingTri] = useState(false);
  const [triOpportunities, setTriOpportunities] = useState<TriangularOpportunity[]>([]);
  const [triPriceSource, setTriPriceSource] = useState<Record<string, "direct" | "synthetic">>({});
  const [cointSignals, setCointSignals] = useState<CointegrationSignal[]>([]);
  const [isAutoExecutingOb, setIsAutoExecutingOb] = useState(false);
  const [obCycles, setObCycles] = useState<ObCycleEntry[]>([]);

  // ── Refs that give poll() always-current values without re-triggering effects ──
  const credentialsRef = useRef(credentials);
  const settingsRef = useRef(settings);
  const liveModeRef = useRef(liveMode);
  const latestPriceDataRef = useRef<PriceData | null>(null);

  useEffect(() => { credentialsRef.current = credentials; }, [credentials]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { liveModeRef.current = liveMode; }, [liveMode]);
  useEffect(() => { emergencyStopRef.current = emergencyStop; }, [emergencyStop]);
  useEffect(() => { cachedBalancesRef.current = cachedBalances; }, [cachedBalances]);

  const lastTradeTimeRef = useRef<number>(0);
  const lastBalanceUpdateRef = useRef<number>(0);
  const dailyLossRef = useRef<number>(0);
  const emergencyStopRef = useRef<boolean>(false);
  const isExecutingRef = useRef<boolean>(false);
  // Execution locks for triangular and OB auto-executors — refs so all three
  // loops can read each other's state without React closure staleness.
  const isAutoExecutingTriRef = useRef<boolean>(false);
  const isAutoExecutingObRef  = useRef<boolean>(false);
  // Track previous WS state so degradation is logged only on transition, not every poll
  const prevWsRef = useRef<{ kraken: boolean; coinbase: boolean }>({ kraken: true, coinbase: true });
  // Always-current balances for Kelly sizing inside poll()
  const cachedBalancesRef = useRef<BalanceData | null>(null);

  const BALANCE_CACHE_TTL_MS = 30_000; // refresh balances at most once per 30 s (mirrors Python)

  const fetchPricesMutation = useFetchPrices();
  const fetchBalancesMutation = useFetchBalances();
  const executeTradeMutation = useExecuteTrade();
  const executeTriangularMutation = useExecuteTriangular();

  // ── Triangular arb scan — runs independently while bot is active ──────────────
  // Polls the /arb/triangular endpoint on the same interval as the cross-exchange
  // scan. Results are stored in state so the dashboard can display them.
  const triScan = useScanTriangularArb({
    query: {
      queryKey: getScanTriangularArbQueryKey(),
      enabled: isRunning,
      refetchInterval: Math.max(2, settingsRef.current.pollInterval) * 1000,
      staleTime: 0,
    },
  });

  const lastTriTradeTimeRef = useRef<number>(0);
  const lastObTradeTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!triScan.data) return;
    const opps = triScan.data.opportunities;
    setTriOpportunities(opps);
    if (triScan.data.priceSource) setTriPriceSource(triScan.data.priceSource);
    if (opps.length > 0) {
      for (const opp of opps) {
        const variant = opp.variant === "btc" ? "BTC" : "ETH";
        addLog(
          "info",
          `[TRI·${variant}] ${opp.exchange} ${opp.loop} | Net +${opp.profitPct.toFixed(3)}% | ` +
          `SOL/USD $${opp.solUsd.toFixed(4)} ` +
          (opp.variant === "btc"
            ? `BTC/USD $${opp.ethUsd.toFixed(2)} SOL/BTC ${opp.ethSol.toFixed(6)}`
            : `ETH/USD $${opp.ethUsd.toFixed(2)} ETH/SOL ${opp.ethSol.toFixed(4)}`)
        );
      }

      // Auto-execute best opportunity when bot is running, live mode, edge clears threshold.
      // Priority: BTC loops first (liquid SOLXBT market), then ETH loops.
      const s = settingsRef.current;
      const creds = credentialsRef.current;
      const now = Date.now();
      const cooldownMs = s.cooldown * 1000;
      if (
        isRunning &&
        liveModeRef.current &&
        !emergencyStopRef.current &&
        !isExecutingRef.current &&
        !isAutoExecutingTriRef.current &&
        !isAutoExecutingObRef.current &&
        now - lastTriTradeTimeRef.current >= cooldownMs
      ) {
        // Pick best opportunity above threshold: prefer BTC variant, then ETH
        const qualified = opps.filter(o => o.profitPct >= s.minNetEdge);
        const bestBtc = qualified.filter(o => o.variant === "btc").sort((a, b) => b.profitPct - a.profitPct)[0];
        const bestEth = qualified.filter(o => o.variant !== "btc").sort((a, b) => b.profitPct - a.profitPct)[0];
        const best = bestBtc ?? bestEth;

        if (best) {
          const tag = best.variant === "btc" ? "TRI·BTC·AUTO" : "TRI·ETH·AUTO";
          lastTriTradeTimeRef.current = now;
          isAutoExecutingTriRef.current = true;
          setIsAutoExecutingTri(true);
          addLog("trade", `[${tag}] ${best.loop} | +${best.profitPct.toFixed(3)}% — firing`);
          executeTriangularMutation.mutate(
            // auto-loop: market orders ensure immediate fills; taker fees already in TRI_TOTAL_FEES_PCT
            { data: { krakenKey: creds.krakenKey, krakenSecret: creds.krakenSecret, loop: best.loop, isDryRun: false, orderType: "market" } },
            {
              onSuccess: (r) => {
                isAutoExecutingTriRef.current = false;
                setIsAutoExecutingTri(false);
                if (r.success) {
                  const synthWarn = r.synthetic ? " ⚠ synthetic ETH/SOL rate" : "";
                  addLog("success", `[${tag}] Done — est. $${r.estimatedProfitUsd.toFixed(2)}${synthWarn}`);
                } else addLog("error", `[${tag}] Failed: ${r.error}`);
              },
              onError: (e) => {
                isAutoExecutingTriRef.current = false;
                setIsAutoExecutingTri(false);
                addLog("error", `[${tag}] Exception: ${e instanceof Error ? e.message : "Unknown"}`);
              },
            }
          );
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triScan.data]);

  // ── Cointegration scan — Kalman-filter mean-reversion signals ────────────────
  // Polls /arb/cointegration every 30 s regardless of bot state (signals are
  // computed from the in-memory Kalman history and require warm-up time).
  const cointScan = useScanCointegrationArb({
    query: {
      queryKey: getScanCointegrationArbQueryKey(),
      refetchInterval: 30_000,
      staleTime: 25_000,
    },
  });

  useEffect(() => {
    if (!cointScan.data) return;
    const sigs = cointScan.data.signals;
    setCointSignals(sigs);
    for (const sig of sigs) {
      addLog(
        "coint",
        `[COINT] ${sig.pair} z=${sig.zScore.toFixed(2)} · ${sig.direction} · edge ${(sig.edgePct * 100).toFixed(2)}%`,
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cointScan.data]);

  // ── Order Book Hunter scan — auto-execute the top READY cycle ────────────────
  // Polls /arb/ob-scan while the bot is running (same interval as cross-exchange
  // scan). Mirrors the Python v14 auto-execute loop: when the top cycle is READY
  // and its net profit exceeds settings.minProfitUsd and the cooldown has elapsed,
  // fires the three Kraken market orders automatically. Dry-run mode records to
  // the trade ledger without placing real orders.
  const obScanParams = { tradeSizeUsd: settingsRef.current.obTradeSize, feesPct: settingsRef.current.obFeesPct, minProfitUsd: 0.02, maxSlippagePct: 0.5, volatilityFilter: true };
  const obScan = useGetObScan(obScanParams, {
    query: {
      queryKey: getGetObScanQueryKey(obScanParams),
      enabled: isRunning,
      refetchInterval: Math.max(2, settingsRef.current.pollInterval) * 1000,
      staleTime: 0,
    },
  });
  const obExecuteMutation = useObExecute();

  useEffect(() => {
    if (!obScan.data) return;
    const cycles = obScan.data.cycles;
    setObCycles(cycles);

    const s = settingsRef.current;
    const creds = credentialsRef.current;
    const now = Date.now();
    const cooldownMs = s.cooldown * 1000;

    // Auto-execute gate: bot running, no other executor in-flight, cooldown elapsed.
    // Use refs (not React state) for all lock checks so the gate never reads stale
    // closure values when multiple scan callbacks arrive in rapid succession.
    if (
      !isRunning ||
      emergencyStopRef.current ||
      isExecutingRef.current ||
      isAutoExecutingTriRef.current ||
      isAutoExecutingObRef.current ||
      now - lastObTradeTimeRef.current < cooldownMs
    ) return;

    // Pick the best READY cycle above the profit floor. cycles[] is sorted by
    // estimatedProfitUsd descending, but the #1 entry may be HIGH_SLIPPAGE or
    // LOW_PROFIT — filter first, then take the highest-profit READY one.
    const top = cycles
      .filter(c => c.status === "READY" && c.estimatedProfitUsd > s.minProfitUsd)
      .sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd)[0];
    if (!top) return;

    const isDryRun = !liveModeRef.current;
    const tag = isDryRun ? "OB·AUTO·DRY" : "OB·AUTO";
    lastObTradeTimeRef.current = now;
    isAutoExecutingObRef.current = true;
    setIsAutoExecutingOb(true);
    addLog(
      "trade",
      `[${tag}] ${top.route} | profit $${top.estimatedProfitUsd.toFixed(4)} | slippage ${top.slippagePct.toFixed(2)}% — firing`,
    );

    obExecuteMutation.mutate(
      {
        data: {
          krakenKey: creds.krakenKey,
          krakenSecret: creds.krakenSecret,
          assetA: top.assetA,
          assetB: top.assetB,
          tradeSizeUsd: s.obTradeSize,
          feesPct: s.obFeesPct,
          minProfitUsd: s.minProfitUsd,
          isDryRun,
        },
      },
      {
        onSuccess: (r) => {
          isAutoExecutingObRef.current = false;
          setIsAutoExecutingOb(false);
          if (r.success && r.executed) {
            const profit = r.preflightProfitUsd ?? 0;
            addLog(
              "success",
              `[${tag}] ✅ ${r.route} | $${profit.toFixed(4)}${r.isDryRun ? " (dry run)" : ` | orders ${[r.leg1OrderId, r.leg2OrderId, r.leg3OrderId].filter(Boolean).join(", ")}`}`,
            );
            queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
            queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
          } else {
            addLog("warning", `[${tag}] ❌ ${r.error ?? "Pre-flight failed — edge disappeared."}`);
          }
        },
        onError: (e) => {
          isAutoExecutingObRef.current = false;
          setIsAutoExecutingOb(false);
          addLog("error", `[${tag}] Exception: ${e instanceof Error ? e.message : "Unknown"}`);
        },
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obScan.data]);

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
  // solRefPrice: SOL/USD price used to anchor the USD position cap. For SOL/USD
  // trades this equals data.buyPrice (no change). For BTC/ETH/etc. pass the
  // live SOL price so the cap stays at "maxPositionSol SOL-worth of USD" rather
  // than "maxPositionSol base units of the traded asset".
  const runExecuteTrade = useCallback(
    async (data: PriceData, forced: boolean, solRefPrice?: number) => {
      const live = forced ? true : liveModeRef.current;
      const s = settingsRef.current;
      const creds = credentialsRef.current;
      // Force Trade always uses market orders; auto-loop uses limit (post-only, lower fees)
      const orderType = forced ? "market" : "limit";
      const tag = forced ? "[FORCE·MKT]" : live ? "[LIVE·LMT]" : "[DRY RUN]";
      const netEdge = data.grossSpreadPct - s.totalFees - s.slippage;

      // Derive the base asset symbol from the active pair (e.g. "BTC" from "BTC/USD")
      const baseAsset = data.pair ? data.pair.split("/")[0] : "SOL";

      // USD cap = maxPositionSol × SOL reference price.
      // For SOL/USD: solRefPrice === data.buyPrice → same cap as before.
      // For BTC/ETH/etc.: anchors the cap to SOL-equivalent USD risk, not BTC units.
      const maxPositionUsd = s.maxPositionSol * (solRefPrice ?? data.buyPrice);

      let volume = kellySize(
        netEdge,
        cachedBalancesRef.current?.usdOnCoinbase ?? 0,
        s.winRate,
        s.kellyFraction,
        data.buyPrice,
        maxPositionUsd,
      );
      // Force-trade minimum: $10 USD equivalent in base units (asset-agnostic).
      // Clamp to maxPositionUsd so the minimum never overrides the hard cap.
      const minVolumeUsd = 10;
      if (forced && volume * data.buyPrice < minVolumeUsd) {
        const minVolume = Math.min(minVolumeUsd, maxPositionUsd) / data.buyPrice;
        addLog("info", `${tag} Kelly below $${minVolumeUsd} — using minimum test volume ${minVolume.toFixed(6)} ${baseAsset}`);
        volume = minVolume;
      }
      const expectedProfit = (netEdge / 100) * data.buyPrice * volume;
      addLog("trade",
        `${tag} ${data.bestBuyExchange} → ${data.bestSellExchange} | ` +
        `${volume.toFixed(4)} ${baseAsset} | ` +
        `Buy $${data.buyPrice.toFixed(4)} | ` +
        `Sell $${data.sellPrice.toFixed(4)} | ` +
        `Net Edge ${netEdge.toFixed(3)}%`
      );
      addLog("info", `${tag} Kelly size: ${volume.toFixed(4)} ${baseAsset} | Est. profit: $${expectedProfit.toFixed(2)}`);
      try {
        const res = await executeTradeMutation.mutateAsync({
          data: {
            krakenKey: creds.krakenKey,
            krakenSecret: creds.krakenSecret,
            coinbaseKey: creds.coinbaseKey,
            coinbaseSecret: creds.coinbaseSecret,
            buyExchange: data.bestBuyExchange,
            sellExchange: data.bestSellExchange,
            volume,
            krakenPrice: data.krakenPrice,
            coinbasePrice: data.coinbasePrice,
            liveMode: live,
            netEdgePct: netEdge,
            orderType,
            pair: data.pair ?? "SOL/USD",
          },
        });
        if (res.success) {
          addLog("success", `${tag} Done — est. profit $${res.estimatedProfitUsd.toFixed(2)}`);
          setSessionProfitUsd((p) => p + res.estimatedProfitUsd);
          setSessionTradeCount((n) => n + 1);
          if (res.estimatedProfitUsd < 0) {
            const loss = Math.abs(res.estimatedProfitUsd);
            dailyLossRef.current += loss;
            setDailyLoss((prev) => prev + loss);
          }
          queryClient.invalidateQueries({ queryKey: getGetTradeSummaryQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTradesQueryKey() });
        } else if (res.skipped) {
          addLog("warning", `${tag} ${res.error ?? "Trade skipped: insufficient balance."}`);
        } else {
          addLog("error", `${tag} Failed: ${res.error}`);
          setFailedTrades((n) => n + 1);
        }
      } catch (err) {
        addLog("error", `${tag} Exception: ${err instanceof Error ? err.message : "Unknown"}`);
        setFailedTrades((n) => n + 1);
      }
    },
    // executeTradeMutation and queryClient are stable (React Query guarantees)
    [addLog, executeTradeMutation, queryClient],
  );

  // ── Force Triangular ──────────────────────────────────────────────────────────
  // Port of Python v13 "FORCE TRIANGULAR" button: fires best BTC loop with $10 test.
  const forceTriangular = useCallback(async () => {
    if (executeTriangularMutation.isPending) return;
    setIsForcingTriangular(true);
    try {
      const creds = credentialsRef.current;
      const opps = triOpportunities.filter(o => o.variant === "btc").sort((a, b) => b.profitPct - a.profitPct);
      const best = opps[0];
      const loop = best?.loop ?? "USD→BTC→SOL→USD"; // sensible default

      addLog("trade", `[TRI·FORCE] ${loop} — test $10`);
      const r = await executeTriangularMutation.mutateAsync({
        data: {
          krakenKey: creds.krakenKey,
          krakenSecret: creds.krakenSecret,
          loop,
          tradeUsd: 10,
          isDryRun: !liveModeRef.current,
        },
      });
      if (r.success) {
        const synthWarn = r.synthetic ? " ⚠ synthetic ETH/SOL rate" : "";
        addLog("success", `[TRI·FORCE] Done — est. $${r.estimatedProfitUsd.toFixed(2)}${r.isDryRun ? " (dry)" : ""}${synthWarn}`);
      } else {
        addLog("error", `[TRI·FORCE] Failed: ${r.error}`);
      }
    } catch (err) {
      addLog("error", `[TRI·FORCE] Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setIsForcingTriangular(false);
    }
  }, [addLog, executeTriangularMutation, triOpportunities]);

  // ── Force Trade ───────────────────────────────────────────────────────────────
  // Calls /arb/scan to find the #1-ranked pair by gross spread, then routes
  // execution to that pair. Falls back to the cached/fetched SOL/USD price if
  // the scan returns no valid pairs.
  const forceTrade = useCallback(async () => {
    if (isExecutingRef.current) return;
    setIsForcingTrade(true);
    try {
      // ── Step 1: try the multi-pair ranker ─────────────────────────────────
      let priceData: PriceData | null = null;

      // solRefPrice: SOL/USD price from the scan, used to anchor the USD position
      // cap in runExecuteTrade. For SOL/USD trades this equals buyPrice (unchanged).
      // For BTC/ETH/etc. it ensures the cap stays at "N SOL worth of USD" risk.
      let solRefPrice: number | undefined;

      try {
        addLog("info", "[FORCE] Scanning all pairs for best spread...");
        const entries = await scanAllPairs();

        // Capture SOL reference price from scan before picking the best entry
        const solEntry = entries?.find(e => e.pair === "SOL/USD");
        if (solEntry) {
          solRefPrice = (solEntry.krakenPrice + solEntry.coinbasePrice) / 2;
        }

        const best = entries && entries.length > 0 ? entries[0] : null;

        if (best) {
          // If the best pair is non-SOL and SOL/USD was absent from the scan (data
          // outage), fetch SOL/USD exclusively so the USD cap is always correctly
          // anchored. Pass enabledPairs:["SOL/USD"] so /prices cannot return another
          // asset. Validate the response pair before trusting it; abort if unavailable.
          if (!solRefPrice && best.pair !== "SOL/USD") {
            addLog("info", "[FORCE] SOL/USD missing from scan — fetching SOL/USD reference price...");
            try {
              const solData = await fetchPricesMutation.mutateAsync({
                data: { ...credentialsRef.current, enabledPairs: ["SOL/USD"] },
              });
              if (solData.pair !== "SOL/USD" || !solData.krakenPrice || !solData.coinbasePrice) {
                addLog("error", "[FORCE] SOL/USD reference unavailable — aborting to prevent oversized position");
                return;
              }
              solRefPrice = (solData.krakenPrice + solData.coinbasePrice) / 2;
            } catch {
              addLog("error", "[FORCE] Could not fetch SOL/USD reference — aborting to prevent oversized position");
              return;
            }
          }

          // Use executable ask/bid — the prices a market order actually fills at.
          // Buy side pays the ask; sell side receives the bid.
          const buyPrice  = best.buyExchange  === "Kraken" ? best.krakenAsk  : best.coinbaseAsk;
          const sellPrice = best.sellExchange === "Kraken" ? best.krakenBid  : best.coinbaseBid;
          // Recompute spread from executable prices (matches how the ranker scored it)
          const execSpreadPct = buyPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : best.grossSpreadPct;
          addLog("info", `[FORCE] Best pair: ${best.pair} via ${best.buyExchange}→${best.sellExchange} exec-spread ${execSpreadPct.toFixed(3)}%`);

          // The server uses krakenPrice for Kraken orders and coinbasePrice for Coinbase orders.
          // Populate each with the executable side price so order sizing uses ask/bid, not mid.
          // Kraken is buying  → supply ask; Kraken is selling  → supply bid.
          // Coinbase is buying → supply ask; Coinbase is selling → supply bid.
          const execKrakenPrice   = best.buyExchange === "Kraken" ? best.krakenAsk  : best.krakenBid;
          const execCoinbasePrice = best.buyExchange === "Coinbase" ? best.coinbaseAsk : best.coinbaseBid;

          priceData = {
            pair: best.pair,
            krakenPrice: execKrakenPrice,
            krakenBid: best.krakenBid,
            krakenAsk: best.krakenAsk,
            coinbasePrice: execCoinbasePrice,
            coinbaseBid: best.coinbaseBid,
            coinbaseAsk: best.coinbaseAsk,
            grossSpreadPct: execSpreadPct,
            netEdgePct: 0, // computed in runExecuteTrade
            route: `${best.pair} ${best.buyExchange} → ${best.sellExchange}`,
            buyExchange: best.buyExchange,
            sellExchange: best.sellExchange,
            bestBuyExchange: best.buyExchange,
            bestSellExchange: best.sellExchange,
            buyPrice,
            sellPrice,
            executable: true,
            wsStatus: { kraken: true, coinbase: true },
            timestamp: best.scannedAt,
          };
        }
      } catch (scanErr) {
        addLog("warning", `[FORCE] Scan failed (${scanErr instanceof Error ? scanErr.message : "unknown"}), falling back to /prices`);
      }

      // ── Step 2: fall back to a fresh SOL/USD-only fetch if scan gave nothing ──
      // Always request SOL/USD explicitly (enabledPairs:["SOL/USD"]) so /prices
      // cannot return a non-SOL pair whose price would be mistaken for solRefPrice.
      if (!priceData) {
        addLog("info", "[FORCE] Fetching SOL/USD prices (fallback)...");
        let fetched: PriceData;
        try {
          fetched = await fetchPricesMutation.mutateAsync({
            data: { ...credentialsRef.current, enabledPairs: ["SOL/USD"] },
          });
        } catch (err) {
          addLog("error", `[FORCE] Could not fetch SOL/USD: ${err instanceof Error ? err.message : "Unknown"}`);
          return;
        }

        if (fetched.pair !== "SOL/USD" || !fetched.krakenPrice || !fetched.coinbasePrice) {
          addLog("error", "[FORCE] SOL/USD prices unavailable — cannot proceed safely");
          return;
        }

        latestPriceDataRef.current = fetched;
        setLatestPriceData(fetched);

        const kPrice = fetched.krakenPrice;
        const cPrice = fetched.coinbasePrice;
        const buyEx       = kPrice < cPrice ? "Kraken" : "Coinbase";
        const sellEx      = kPrice < cPrice ? "Coinbase" : "Kraken";
        const buyPrice    = Math.min(kPrice, cPrice);
        const sellPrice   = Math.max(kPrice, cPrice);
        const grossSpreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;

        priceData = {
          ...fetched,
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
        // Pair is confirmed SOL/USD — solRefPrice = buyPrice (same asset)
        solRefPrice = buyPrice;
      }

      // Pass solRefPrice so Kelly cap is always USD-denominated at SOL-equivalent risk
      await runExecuteTrade(priceData, true, solRefPrice);
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
    setStartTime(Date.now());

    let cancelled = false;

    const poll = async () => {
      if (cancelled || isExecutingRef.current || isAutoExecutingTriRef.current || isAutoExecutingObRef.current) return;

      const c = credentialsRef.current;
      const s = settingsRef.current;
      const live = liveModeRef.current;

      // Refresh balances if cache is stale — fire-and-forget, never blocks price/trade logic
      if (Date.now() - lastBalanceUpdateRef.current > BALANCE_CACHE_TTL_MS) {
        lastBalanceUpdateRef.current = Date.now(); // optimistic — prevents concurrent fetches
        // Pass the active pair so the backend returns the correct base-asset balance.
        // latestPriceDataRef holds the most recently fetched pair; null before the first tick.
        const activePair = latestPriceDataRef.current?.pair;
        fetchBalancesMutation.mutateAsync({ data: { ...c, ...(activePair ? { pair: activePair } : {}) } })
          .then((bal) => { if (!cancelled) setCachedBalances(bal); })
          .catch(() => { /* keep stale cache */ });
      }

      try {
        const fetchStart = Date.now();
        const data = await fetchPricesMutation.mutateAsync({
          data: { ...c, enabledPairs: s.enabledPairs },
        });
        if (cancelled) return;
        setApiLatencyMs(Date.now() - fetchStart);

        latestPriceDataRef.current = data;
        setLatestPriceData(data);

        // Log only on transition into degraded/recovered state, not every poll
        const prev = prevWsRef.current;
        if (!data.wsStatus.kraken  && prev.kraken)   addLog("warning", "Kraken price feed degraded (REST fallback).");
        if ( data.wsStatus.kraken  && !prev.kraken)  addLog("info",    "Kraken price feed restored (WS live).");
        if (!data.wsStatus.coinbase && prev.coinbase) addLog("warning", "Coinbase price feed degraded (REST fallback).");
        if ( data.wsStatus.coinbase && !prev.coinbase) addLog("info",   "Coinbase price feed restored (WS live).");
        prevWsRef.current = { kraken: data.wsStatus.kraken, coinbase: data.wsStatus.coinbase };

        const now = Date.now();
        const netEdge = data.grossSpreadPct - s.totalFees - s.slippage;
        const wsInfo = `[K:${data.wsStatus.kraken ? "WS" : "REST"} C:${data.wsStatus.coinbase ? "WS" : "REST"}]`;

        addLog("info", `[${data.pair ?? "SOL/USD"}] K Bid:${data.krakenBid?.toFixed(4) ?? "—"} Ask:${data.krakenAsk?.toFixed(4) ?? "—"} | C Bid:${data.coinbaseBid?.toFixed(4) ?? "—"} Ask:${data.coinbaseAsk?.toFixed(4) ?? "—"}`);
        addLog("info", `[${data.pair ?? "SOL/USD"}] Gross:${data.grossSpreadPct.toFixed(3)}% | Net:${netEdge.toFixed(3)}%`);

        if (emergencyStopRef.current) {
          addLog("error", "🛑 Emergency stop activated.");
          setIsRunning(false);
          return;
        }

        if (dailyLossRef.current >= s.maxDailyLoss) {
          addLog("error", `Daily loss limit reached ($${dailyLossRef.current.toFixed(2)} >= $${s.maxDailyLoss.toFixed(2)}). Bot halted.`);
          setIsRunning(false);
          return;
        }

        if (netEdge < s.minNetEdge) {
          addLog("info", `No trade — net ${netEdge.toFixed(3)}% < ${s.minNetEdge.toFixed(2)}% ${wsInfo}`);
          return;
        }

        const kellyVol = kellySize(netEdge, cachedBalancesRef.current?.usdOnCoinbase ?? 0, s.winRate, s.kellyFraction, data.buyPrice ?? 0, s.maxPositionSol);
        const estimatedNetProfit = (netEdge / 100) * (data.buyPrice ?? 0) * kellyVol;
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
          addLog("warning", "Waiting for fresh Kraken and Coinbase bid/ask data.");
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
      setStartTime(null);
    };
    // Intentionally only [isRunning] — refs give us live values without re-triggering
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  const isExecutingTriangular = isForcingTriangular || isAutoExecutingTri || executeTriangularMutation.isPending;

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
    cachedBalances,
    activityLog,
    sessionProfitUsd,
    sessionTradeCount,
    apiLatencyMs,
    dailyLoss,
    failedTrades,
    startTime,
    emergencyStop,
    setEmergencyStop,
    addLog,
    clearLog,
    secretsLoaded,
    forceTrade,
    isForcingTrade,
    forceTriangular,
    isForcingTriangular,
    isExecutingTriangular,
    triOpportunities,
    triPriceSource,
    cointSignals,
    obCycles,
    isAutoExecutingOb,
  };

  return <BotContext.Provider value={value}>{children}</BotContext.Provider>;
}

export function useBotContext() {
  const ctx = useContext(BotContext);
  if (!ctx) throw new Error("useBotContext must be used within a BotProvider");
  return ctx;
}
