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
