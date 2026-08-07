import { useQuery } from "@tanstack/react-query";
import type { UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export interface TriScanRecord {
  id: number;
  createdAt: string;
  exchange: string;
  loop: string;
  profitPct: number;
  solUsd: number;
  /** Holds BTC/USD mid for the "btc" variant */
  ethUsd: number;
  /** Holds SOL/BTC mid for the "btc" variant */
  ethSol: number;
  variant: string | null;
  scannedAt: string;
}

export interface TriScanHistoryResult {
  items: TriScanRecord[];
  total: number;
}

export const getTriangularHistoryUrl = (params?: {
  limit?: number;
  offset?: number;
}) => {
  const sp = new URLSearchParams();
  if (params?.limit !== undefined) sp.set("limit", String(params.limit));
  if (params?.offset !== undefined) sp.set("offset", String(params.offset));
  const qs = sp.toString();
  return `/api/arb/triangular/history${qs ? `?${qs}` : ""}`;
};

export const getTriangularHistory = (params?: {
  limit?: number;
  offset?: number;
}): Promise<TriScanHistoryResult> =>
  customFetch<TriScanHistoryResult>(getTriangularHistoryUrl(params), {
    method: "GET",
  });

export const getGetTriangularHistoryQueryKey = (params?: {
  limit?: number;
  offset?: number;
}) => [getTriangularHistoryUrl(params)] as const;

// ── Summary hook ──────────────────────────────────────────────────────────────

export interface TriScanHistorySummary {
  total: number;
  avgProfitPct: number;
  bestProfitPct: number;
  counterfactualPnlUsd: number;
  tradeSizeUsd: number;
}

export const getTriangularHistorySummaryUrl = (params?: { tradeSizeUsd?: number }) => {
  const sp = new URLSearchParams();
  if (params?.tradeSizeUsd !== undefined) sp.set("tradeSizeUsd", String(params.tradeSizeUsd));
  const qs = sp.toString();
  return `/api/arb/triangular/history/summary${qs ? `?${qs}` : ""}`;
};

export const getTriangularHistorySummary = (params?: {
  tradeSizeUsd?: number;
}): Promise<TriScanHistorySummary> =>
  customFetch<TriScanHistorySummary>(getTriangularHistorySummaryUrl(params), {
    method: "GET",
  });

export const getGetTriangularHistorySummaryQueryKey = (params?: { tradeSizeUsd?: number }) =>
  [getTriangularHistorySummaryUrl(params)] as const;

export const useGetTriangularHistorySummary = (
  params?: { tradeSizeUsd?: number },
  options?: Omit<
    UseQueryOptions<
      TriScanHistorySummary,
      Error,
      TriScanHistorySummary,
      readonly [string]
    >,
    "queryKey" | "queryFn"
  >,
): UseQueryResult<TriScanHistorySummary, Error> =>
  useQuery({
    queryKey: getGetTriangularHistorySummaryQueryKey(params),
    queryFn: () => getTriangularHistorySummary(params),
    ...options,
  });

// ── Fresh-quote — cache-bypassing live bid/ask for a single pair ──────────────

export interface FreshQuoteResult {
  pair: string;
  krakenBid: number;
  krakenAsk: number;
  coinbaseBid: number;
  coinbaseAsk: number;
  grossSpreadPct: number;
  buyExchange: "Kraken" | "Coinbase";
  sellExchange: "Kraken" | "Coinbase";
  buyPrice: number;
  sellPrice: number;
  /** ISO timestamp of when the REST quotes were fetched — use to measure true quote age */
  quotedAt: string;
}

export const getFreshQuote = (pair: string): Promise<FreshQuoteResult> =>
  customFetch<FreshQuoteResult>(`/api/arb/fresh-quote?pair=${encodeURIComponent(pair)}`, {
    method: "GET",
  });

export const useGetTriangularHistory = (
  params?: { limit?: number; offset?: number },
  options?: Omit<
    UseQueryOptions<
      TriScanHistoryResult,
      Error,
      TriScanHistoryResult,
      readonly [string]
    >,
    "queryKey" | "queryFn"
  >,
): UseQueryResult<TriScanHistoryResult, Error> =>
  useQuery({
    queryKey: getGetTriangularHistoryQueryKey(params),
    queryFn: () => getTriangularHistory(params),
    ...options,
  });
