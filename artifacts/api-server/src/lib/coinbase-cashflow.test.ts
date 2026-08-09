import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { coinbaseNetCashFlowUsd } from "./exchange";

// Coinbase external cash-flow tracking (v2 transactions ledger): only external
// deposit/withdrawal/send flows count, valued at Coinbase's own transaction-time
// native_amount USD; anything unverifiable fails CLOSED (complete=false).

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Real ES256 key — coinbaseRequest signs a CDP JWT with it before every call.
const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
let keyCounter = 0;
const freshCreds = () => ({ coinbaseKey: `organizations/test/apiKeys/cf-${keyCounter++}-${Math.random()}`, coinbaseSecret: pem });

const sinceUnix = 1_700_000_000;
const afterBaseline = new Date((sinceUnix + 3_600) * 1000).toISOString();
const beforeBaseline = new Date((sinceUnix - 3_600) * 1000).toISOString();

let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => vi.unstubAllGlobals());

function mockCoinbase(handlers: {
  accounts?: unknown;
  transactions?: (accountId: string, url: string) => unknown;
  ticker?: (product: string) => unknown;
}): void {
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v2/accounts") && url.includes("/transactions")) {
      const id = url.match(/\/v2\/accounts\/([^/]+)\/transactions/)![1]!;
      return jsonResponse(handlers.transactions?.(id, url) ?? { data: [], pagination: {} });
    }
    if (url.includes("/v2/accounts")) {
      // Auth construction: every private v2 call must carry a Bearer JWT.
      const auth = (init?.headers as Record<string, string>)?.["Authorization"] ?? "";
      expect(auth.startsWith("Bearer ")).toBe(true);
      expect(auth.split("Bearer ")[1]!.split(".").length).toBe(3); // JWT shape
      return jsonResponse(handlers.accounts ?? { data: [], pagination: {} });
    }
    if (url.includes("api.exchange.coinbase.com/products/")) {
      const product = url.match(/products\/([^/]+)\/ticker/)![1]!;
      const t = handlers.ticker?.(product);
      return t instanceof Response ? t : jsonResponse(t ?? {});
    }
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("coinbaseNetCashFlowUsd", () => {
  it("sums only external flows at transaction-time native USD, with correct signs", async () => {
    mockCoinbase({
      accounts: { data: [{ id: "acct-btc", currency: { code: "BTC" } }, { id: "acct-usd", currency: { code: "USD" } }], pagination: {} },
      transactions: (id) => id === "acct-btc"
        ? { data: [
            // On-chain deposit: +0.01 BTC valued by Coinbase at $500 at the time
            { type: "send", status: "completed", created_at: afterBaseline, amount: { amount: "0.01", currency: "BTC" }, native_amount: { amount: "500.00", currency: "USD" } },
            // On-chain withdrawal: negative native amount
            { type: "send", status: "completed", created_at: afterBaseline, amount: { amount: "-0.005", currency: "BTC" }, native_amount: { amount: "-260.00", currency: "USD" } },
            // Trades and rewards are NOT external cash flows
            { type: "advanced_trade_fill", status: "completed", created_at: afterBaseline, amount: { amount: "0.02", currency: "BTC" }, native_amount: { amount: "1000.00", currency: "USD" } },
            { type: "buy", status: "completed", created_at: afterBaseline, amount: { amount: "0.02", currency: "BTC" }, native_amount: { amount: "1000.00", currency: "USD" } },
            { type: "staking_reward", status: "completed", created_at: afterBaseline, amount: { amount: "0.001", currency: "BTC" }, native_amount: { amount: "50.00", currency: "USD" } },
            // Pending flows haven't moved balance-affecting funds yet
            { type: "send", status: "pending", created_at: afterBaseline, amount: { amount: "1.0", currency: "BTC" }, native_amount: { amount: "52000.00", currency: "USD" } },
          ], pagination: {} }
        : { data: [
            { type: "fiat_deposit", status: "completed", created_at: afterBaseline, amount: { amount: "100.00", currency: "USD" }, native_amount: { amount: "100.00", currency: "USD" } },
            { type: "fiat_withdrawal", status: "completed", created_at: afterBaseline, amount: { amount: "-40.00", currency: "USD" }, native_amount: { amount: "-40.00", currency: "USD" } },
          ], pagination: {} },
    });
    const cf = await coinbaseNetCashFlowUsd(freshCreds(), sinceUnix);
    expect(cf.netUsd).toBeCloseTo(500 - 260 + 100 - 40, 6);
    expect(cf.entries).toBe(4);
    expect(cf.approximated).toBe(false);
    expect(cf.complete).toBe(true);
  });

  it("stops at the baseline and walks account + transaction pagination", async () => {
    const txCalls: string[] = [];
    mockCoinbase({
      accounts: { data: [{ id: "a1", currency: { code: "USD" } }], pagination: { next_uri: "/v2/accounts?limit=100&starting_after=a1" } },
      transactions: (id, url) => {
        txCalls.push(url);
        if (id === "a1" && !url.includes("starting_after")) {
          return {
            data: [{ type: "fiat_deposit", status: "completed", created_at: afterBaseline, amount: { amount: "10", currency: "USD" }, native_amount: { amount: "10", currency: "USD" } }],
            pagination: { next_uri: `/v2/accounts/a1/transactions?limit=100&starting_after=t1` },
          };
        }
        if (id === "a1") {
          // Second page: first entry predates the baseline → stop, never count it
          return { data: [{ type: "fiat_deposit", status: "completed", created_at: beforeBaseline, amount: { amount: "999", currency: "USD" }, native_amount: { amount: "999", currency: "USD" } }], pagination: {} };
        }
        return { data: [{ type: "fiat_deposit", status: "completed", created_at: afterBaseline, amount: { amount: "5", currency: "USD" }, native_amount: { amount: "5", currency: "USD" } }], pagination: {} };
      },
    });
    // Second account page
    const orig = fetchMock.getMockImplementation()! as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v2/accounts?limit=100&starting_after=a1")) {
        return jsonResponse({ data: [{ id: "a2", currency: { code: "USD" } }], pagination: {} });
      }
      return orig(input, init);
    });
    const cf = await coinbaseNetCashFlowUsd(freshCreds(), sinceUnix);
    expect(cf.netUsd).toBeCloseTo(15, 6); // 10 (a1 page 1) + 5 (a2); pre-baseline 999 excluded
    expect(cf.complete).toBe(true);
    expect(txCalls.some(u => u.includes("/v2/accounts/a1/transactions") && u.includes("starting_after"))).toBe(true);
  });

  it("falls back to current spot (flagged approximated) when native USD is missing", async () => {
    mockCoinbase({
      accounts: { data: [{ id: "a1", currency: { code: "SOL" } }], pagination: {} },
      transactions: () => ({ data: [
        { type: "send", status: "completed", created_at: afterBaseline, amount: { amount: "2", currency: "SOL" }, native_amount: { amount: "3.1", currency: "EUR" } },
      ], pagination: {} }),
      ticker: (product) => { expect(product).toBe("SOL-USD"); return { price: "150" }; },
    });
    const cf = await coinbaseNetCashFlowUsd(freshCreds(), sinceUnix);
    expect(cf.netUsd).toBeCloseTo(300, 6);
    expect(cf.approximated).toBe(true);
    expect(cf.complete).toBe(true);
  });

  it("fails closed (complete=false) when an external flow cannot be priced", async () => {
    mockCoinbase({
      accounts: { data: [{ id: "a1", currency: { code: "OBSCURE" } }], pagination: {} },
      transactions: () => ({ data: [
        { type: "send", status: "completed", created_at: afterBaseline, amount: { amount: "5", currency: "OBSCURE" }, native_amount: { amount: "1", currency: "EUR" } },
      ], pagination: {} }),
      ticker: () => new Response("not found", { status: 404 }),
    });
    const cf = await coinbaseNetCashFlowUsd(freshCreds(), sinceUnix);
    expect(cf.complete).toBe(false);
  });

  it("fails closed when transaction history exceeds the pagination cap", async () => {
    let page = 0;
    mockCoinbase({
      accounts: { data: [{ id: "a1", currency: { code: "USD" } }], pagination: {} },
      transactions: (_id, _url) => ({
        data: [{ type: "fiat_deposit", status: "completed", created_at: afterBaseline, amount: { amount: "1", currency: "USD" }, native_amount: { amount: "1", currency: "USD" } }],
        pagination: { next_uri: `/v2/accounts/a1/transactions?limit=100&starting_after=p${++page}` }, // never ends
      }),
    });
    const cf = await coinbaseNetCashFlowUsd(freshCreds(), sinceUnix);
    expect(cf.complete).toBe(false);
  });
});
