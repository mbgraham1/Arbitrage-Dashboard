// @vitest-environment jsdom
/**
 * Concurrency guard test for the three auto-executors (cross-exchange,
 * triangular, OB Hunter). Renders the real BotProvider with the API client
 * hooks mocked so scan results can be delivered "simultaneously" — in a
 * single React commit, exactly how rapid scan callbacks land in prod when
 * both React Query scans resolve on the same tick — and asserts at most one
 * execute mutation fires while another executor is mid-flight.
 */
import React, { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  TriangularOpportunity,
  ObCycleEntry,
} from "@workspace/api-client-react";

// ── Mutable scan data the mocked hooks read on every render ──────────────────
let triScanData:
  | { opportunities: TriangularOpportunity[]; priceSource?: Record<string, "direct" | "synthetic"> }
  | undefined;
let obScanData: { cycles: ObCycleEntry[] } | undefined;

// ── Mutation spies ────────────────────────────────────────────────────────────
// Neither spy ever invokes onSuccess/onError — the mutation stays "mid-flight"
// so the executor's in-flight lock ref remains held for the rest of the test.
const executeTriangularMutate = vi.fn();
const obExecuteMutate = vi.fn();
const executeTradeMutateAsync = vi.fn(() => new Promise<never>(() => {}));
// scanAllPairs pending forever → forceTrade holds isExecutingRef indefinitely
const scanAllPairsMock = vi.fn(() => new Promise<never>(() => {}));

vi.mock("@workspace/api-client-react", () => ({
  useFetchPrices: () => ({ mutateAsync: vi.fn(() => new Promise(() => {})), isPending: false }),
  useFetchBalances: () => ({ mutateAsync: vi.fn(() => new Promise(() => {})), isPending: false }),
  useExecuteTrade: () => ({ mutateAsync: executeTradeMutateAsync, isPending: false }),
  useExecuteTriangular: () => ({
    mutate: executeTriangularMutate,
    mutateAsync: vi.fn(() => new Promise(() => {})),
    isPending: false,
  }),
  useObExecute: () => ({ mutate: obExecuteMutate, isPending: false }),
  useGetPreloadedCredentials: () => ({ data: undefined }),
  useScanTriangularArb: () => ({ data: triScanData }),
  useScanCointegrationArb: () => ({ data: undefined }),
  useGetObScan: () => ({ data: obScanData }),
  useGetFeeTier: () => ({ data: undefined }),
  getGetFeeTierQueryKey: () => ["fee-tier"],
  getScanTriangularArbQueryKey: () => ["tri"],
  getScanCointegrationArbQueryKey: () => ["coint"],
  getListTradesQueryKey: () => ["trades"],
  getGetTradeSummaryQueryKey: () => ["summary"],
  getGetObScanQueryKey: () => ["ob"],
  scanAllPairs: (...args: unknown[]) => scanAllPairsMock(...(args as [])),
  getFreshQuote: vi.fn(),
}));

// Import AFTER the mock so BotProvider binds to the mocked module.
const { BotProvider, useBotContext } = await import("./bot-context");

// ── Fixtures ──────────────────────────────────────────────────────────────────
const triOpp: TriangularOpportunity = {
  variant: "btc",
  exchange: "Kraken",
  loop: "USD→BTC→SOL→USD",
  profitPct: 1.5, // comfortably above the 0.05% default minNetEdge
  solUsd: 150,
  ethUsd: 60000,
  ethSol: 0.0025,
} as TriangularOpportunity;

const obCycle: ObCycleEntry = {
  route: "USD→BTC→ETH→USD",
  assetA: "BTC",
  assetB: "ETH",
  legs: 3,
  status: "READY",
  estimatedProfitUsd: 0.5, // comfortably above the $0.02 default OB floor
  slippagePct: 0.1,
} as ObCycleEntry;

// Harness exposing the context to the test
let ctx: ReturnType<typeof useBotContext>;
function Harness() {
  ctx = useBotContext();
  const { setIsRunning } = ctx;
  useEffect(() => {
    setIsRunning(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function renderProvider() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Fresh elements each render — reusing the same element reference would let
  // React bail out of re-rendering BotProvider entirely.
  const tree = () => (
    <QueryClientProvider client={qc}>
      <BotProvider>
        <Harness />
      </BotProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  // Deliver fresh scan data and rerender — the mocked scan hooks read the
  // module-level variables on every render, and each effect keys off the
  // (new) data object identity, so setting both at once simulates both scan
  // callbacks arriving in a single React commit.
  const deliverScans = (opts: { tri?: boolean; ob?: boolean }) => {
    act(() => {
      if (opts.tri) triScanData = { opportunities: [triOpp] };
      if (opts.ob) obScanData = { cycles: [obCycle] };
      view.rerender(tree());
    });
  };
  return { view, deliverScans };
}

beforeEach(() => {
  vi.clearAllMocks();
  triScanData = undefined;
  obScanData = undefined;
  window.localStorage.clear();
  // Credentials so the bot can start; live mode so auto-executors arm.
  window.localStorage.setItem(
    "cat_arb_creds",
    JSON.stringify({ krakenKey: "k", krakenSecret: "s", coinbaseKey: "c", coinbaseSecret: "cs" }),
  );
  window.localStorage.setItem("cat_arb_live_mode", "true");
});

describe("auto-executor concurrency guards", () => {
  it("positive control: TRI auto-executor fires when nothing else is in flight", () => {
    const { deliverScans } = renderProvider();
    deliverScans({ tri: true });
    expect(executeTriangularMutate).toHaveBeenCalledTimes(1);
    expect(obExecuteMutate).not.toHaveBeenCalled();
  });

  it("positive control: OB auto-executor fires when nothing else is in flight", () => {
    const { deliverScans } = renderProvider();
    deliverScans({ ob: true });
    expect(obExecuteMutate).toHaveBeenCalledTimes(1);
    expect(executeTriangularMutate).not.toHaveBeenCalled();
  });

  it("fires at most ONE execute mutation when TRI and OB scans land in the same commit", () => {
    const { deliverScans } = renderProvider();
    deliverScans({ tri: true, ob: true });
    const totalFires = executeTriangularMutate.mock.calls.length + obExecuteMutate.mock.calls.length;
    expect(totalFires).toBe(1);
    // The TRI effect is registered first, so it wins the race and the OB gate
    // must observe isAutoExecutingTriRef=true within the same commit.
    expect(executeTriangularMutate).toHaveBeenCalledTimes(1);
    expect(obExecuteMutate).not.toHaveBeenCalled();
  });

  it("blocks an OB scan that arrives while a triangular trade is mid-flight", () => {
    const { deliverScans } = renderProvider();
    // Fire the TRI executor; its mutation never settles → mid-flight.
    deliverScans({ tri: true });
    expect(executeTriangularMutate).toHaveBeenCalledTimes(1);
    // A rapid OB scan callback now arrives — it must be swallowed by the gate.
    deliverScans({ ob: true });
    expect(obExecuteMutate).not.toHaveBeenCalled();
  });

  it("blocks a TRI scan that arrives while an OB trade is mid-flight", () => {
    const { deliverScans } = renderProvider();
    deliverScans({ ob: true });
    expect(obExecuteMutate).toHaveBeenCalledTimes(1);
    deliverScans({ tri: true });
    expect(executeTriangularMutate).not.toHaveBeenCalled();
  });

  it("blocks both TRI and OB while a cross-exchange trade holds isExecutingRef", async () => {
    const { deliverScans } = renderProvider();
    // forceTrade acquires isExecutingRef via withExecutionLock and awaits
    // scanAllPairs, which never resolves → the cross-exchange lock stays held.
    act(() => { void ctx.forceTrade(); });
    // Let the async lock acquisition + scanAllPairs call start.
    await act(async () => { await Promise.resolve(); });
    expect(scanAllPairsMock).toHaveBeenCalledTimes(1);
    // Both scans now burst in simultaneously — neither may fire.
    deliverScans({ tri: true, ob: true });
    expect(executeTriangularMutate).not.toHaveBeenCalled();
    expect(obExecuteMutate).not.toHaveBeenCalled();
  });
});
