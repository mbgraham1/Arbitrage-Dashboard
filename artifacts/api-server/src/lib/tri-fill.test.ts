/**
 * Tests for waitForTriLimitFill — the fill-confirmation guard used before
 * each limit-order leg of a triangular arb trade.
 *
 * All exchange calls (krakenOrderInfo, krakenCancelOrder) are mocked so no
 * real network requests are made. setTimeout is replaced with fake timers so
 * tests run in milliseconds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the exchange module BEFORE importing the module under test ──────────
vi.mock("./exchange.js", () => ({
  krakenOrderInfo:   vi.fn(),
  krakenCancelOrder: vi.fn(),
}));

import { waitForTriLimitFill, TriIndeterminateOrderError } from "./tri-fill.js";
import * as exchange from "./exchange.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const CREDS = { krakenKey: "key", krakenSecret: "secret" };
const TXID  = "TXID-TEST-001";

// Silent logger that captures messages for assertions
function makeLog() {
  const messages: string[] = [];
  return {
    log: {
      info:  (m: string) => messages.push(`INFO: ${m}`),
      error: (m: string) => messages.push(`ERROR: ${m}`),
    },
    messages,
  };
}

// Shorthand to build a krakenOrderInfo-compatible result
function orderInfo(status: string, volExec = 0, cost = 0, fee = 0) {
  return { status, volExec, cost, fee };
}

const krakenOrderInfo   = exchange.krakenOrderInfo   as ReturnType<typeof vi.fn>;
const krakenCancelOrder = exchange.krakenCancelOrder as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  krakenCancelOrder.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Run waitForTriLimitFill and advance fake timers concurrently so the
 * promise-based polling loop makes progress.
 */
async function runWithFakeTimers(promise: Promise<unknown>, stepCount = 25) {
  for (let i = 0; i < stepCount; i++) {
    await Promise.resolve(); // flush microtasks
    vi.advanceTimersByTime(500);
    await Promise.resolve();
  }
  return promise;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("waitForTriLimitFill", () => {

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns filled=true immediately when the first poll finds status=closed", async () => {
    krakenOrderInfo.mockResolvedValue(orderInfo("closed", 1.5, 300, 0.05));

    const { log, messages } = makeLog();
    const resultP = waitForTriLimitFill(CREDS, TXID, "leg1 SOL buy", log, 10_000);
    const result  = await runWithFakeTimers(resultP);

    expect(result).toEqual({ filled: true, volExec: 1.5, cost: 300, fee: 0.05 });
    expect(krakenCancelOrder).not.toHaveBeenCalled();
    expect(messages.some(m => m.includes("confirmed filled"))).toBe(true);
  });

  it("returns filled=true after polling open→open→closed", async () => {
    krakenOrderInfo
      .mockResolvedValueOnce(orderInfo("open"))
      .mockResolvedValueOnce(orderInfo("open"))
      .mockResolvedValue(orderInfo("closed", 2.0, 400, 0.06));

    const { log } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg2 ETH buy", log, 10_000)
    );

    expect(result).toMatchObject({ filled: true, volExec: 2.0 });
    expect(krakenCancelOrder).not.toHaveBeenCalled();
    expect(krakenOrderInfo).toHaveBeenCalledTimes(3);
  });

  // ── Already-cancelled externally ───────────────────────────────────────────

  it("returns filled=false with zero volExec when exchange reports canceled immediately", async () => {
    krakenOrderInfo.mockResolvedValue(orderInfo("canceled", 0, 0, 0));

    const { log, messages } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg1 BTC buy", log, 10_000)
    );

    expect(result).toEqual({ filled: false, volExec: 0, cost: 0, fee: 0 });
    expect(krakenCancelOrder).not.toHaveBeenCalled();
    expect(messages.some(m => m.includes("already canceled"))).toBe(true);
  });

  it("returns filled=false with partial volExec when exchange reports canceled after partial fill", async () => {
    krakenOrderInfo.mockResolvedValue(orderInfo("canceled", 0.3, 60, 0.01));

    const { log } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg1 BTC buy", log, 10_000)
    );

    expect(result).toMatchObject({ filled: false, volExec: 0.3, cost: 60, fee: 0.01 });
  });

  // ── Timeout paths ──────────────────────────────────────────────────────────

  it("cancels and returns filled=false with zero volExec when order never fills within timeout", async () => {
    // 1 s timeout → 2 polls (2 × 500 ms). Queue 2 "open" responses so both
    // polls exhaust without the function returning early; post-cancel query
    // (3rd call) returns "canceled" with no fill.
    krakenOrderInfo
      .mockResolvedValueOnce(orderInfo("open"))    // poll 1
      .mockResolvedValueOnce(orderInfo("open"))    // poll 2 → timeout triggers
      .mockResolvedValue(orderInfo("canceled", 0, 0, 0)); // post-cancel query

    const { log, messages } = makeLog();
    const resultP = waitForTriLimitFill(CREDS, TXID, "leg1 SOL buy", log, 1_000);
    const result  = await runWithFakeTimers(resultP, 10);

    expect(result).toMatchObject({ filled: false, volExec: 0 });
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
    expect(krakenCancelOrder).toHaveBeenCalledWith(CREDS, TXID);
    expect(messages.some(m => m.includes("timed out"))).toBe(true);
    expect(messages.some(m => m.includes("cancelled with partial"))).toBe(true);
  });

  it("returns filled=false with actual partial volExec after timeout + partial cancel", async () => {
    // Polls return open; post-cancel query reveals 0.5 SOL was partially filled
    krakenOrderInfo
      .mockImplementation(() => Promise.resolve(orderInfo("open")));
    krakenOrderInfo
      .mockResolvedValueOnce(orderInfo("open"))
      .mockResolvedValueOnce(orderInfo("open"))
      .mockResolvedValue(orderInfo("canceled", 0.5, 75, 0.012));

    const { log } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg2 SOL sell", log, 1_000), 10
    );

    expect(result).toMatchObject({ filled: false, volExec: 0.5, cost: 75, fee: 0.012 });
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
  });

  // ── Cancel-race: order fills concurrently while we cancel ──────────────────

  it("returns filled=true when post-cancel query shows status=closed (cancel-race)", async () => {
    // Polls return open; our cancel is sent, but exchange reports closed after
    krakenOrderInfo
      .mockImplementation(() => Promise.resolve(orderInfo("open")));
    krakenOrderInfo
      .mockResolvedValueOnce(orderInfo("open"))
      .mockResolvedValueOnce(orderInfo("open"))
      .mockResolvedValue(orderInfo("closed", 1.8, 360, 0.058));

    const { log, messages } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg3 ETH sell", log, 1_000), 10
    );

    expect(result).toMatchObject({ filled: true, volExec: 1.8, cost: 360, fee: 0.058 });
    // Cancel was still issued (we don't know it would race until after)
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
    expect(messages.some(m => m.includes("cancel-race"))).toBe(true);
  });

  // ── Transient poll errors ──────────────────────────────────────────────────

  it("retries through transient krakenOrderInfo errors and eventually confirms fill", async () => {
    krakenOrderInfo
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue(orderInfo("closed", 1.0, 200, 0.03));

    const { log } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg1 ETH buy", log, 10_000)
    );

    expect(result).toMatchObject({ filled: true, volExec: 1.0 });
    expect(krakenCancelOrder).not.toHaveBeenCalled();
    expect(krakenOrderInfo).toHaveBeenCalledTimes(3);
  });

  it("throws TriIndeterminateOrderError when post-cancel krakenOrderInfo keeps throwing", async () => {
    // All polls return open; every post-cancel query throws — no terminal
    // status can ever be confirmed. The order may still be resting, so the
    // helper must FAIL CLOSED instead of reporting "cancelled, no fill".
    const openThenThrow = vi
      .fn()
      .mockResolvedValueOnce(orderInfo("open"))
      .mockResolvedValueOnce(orderInfo("open"))
      .mockRejectedValue(new Error("exchange down"));
    krakenOrderInfo.mockImplementation(openThenThrow);

    const { log, messages } = makeLog();
    const resultP = waitForTriLimitFill(CREDS, TXID, "leg2 BTC buy", log, 1_000);
    const guarded = resultP.catch((e: unknown) => e); // attach handler before timers run
    await runWithFakeTimers(guarded, 40);
    const err = await guarded;

    expect(err).toBeInstanceOf(TriIndeterminateOrderError);
    expect((err as TriIndeterminateOrderError).txid).toBe(TXID);
    expect((err as Error).message).toContain(TXID);
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
    expect(messages.some(m => m.includes("INDETERMINATE"))).toBe(true);
  });

  it("throws TriIndeterminateOrderError when the order stays 'open' after cancel (cancel never lands)", async () => {
    // Cancel ACK is not terminal — if Kraken keeps reporting "open" past the
    // confirm window, the order may still rest and fill later. Fail closed.
    krakenOrderInfo.mockResolvedValue(orderInfo("open"));

    const { log } = makeLog();
    const resultP = waitForTriLimitFill(CREDS, TXID, "leg1 SOL buy", log, 1_000);
    const guarded = resultP.catch((e: unknown) => e);
    await runWithFakeTimers(guarded, 40);
    const err = await guarded;

    expect(err).toBeInstanceOf(TriIndeterminateOrderError);
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
  });

  it("polls to terminal after cancel: open→open→closed is a cancel-race fill, not a cancellation", async () => {
    // The first post-cancel reads still show "open" (cancel pending) before
    // Kraken reports the order actually CLOSED — the fill must be returned
    // with actual volumes so the caller continues the cycle.
    krakenOrderInfo
      .mockResolvedValueOnce(orderInfo("open"))            // poll 1
      .mockResolvedValueOnce(orderInfo("open"))            // poll 2 → timeout
      .mockResolvedValueOnce(orderInfo("open"))            // post-cancel read 1 (cancel pending)
      .mockResolvedValueOnce(orderInfo("open"))            // post-cancel read 2 (still pending)
      .mockResolvedValue(orderInfo("closed", 2.2, 440, 0.07)); // terminal: filled in the race

    const { log, messages } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg2 SOL buy", log, 1_000), 15
    );

    expect(result).toEqual({ filled: true, volExec: 2.2, cost: 440, fee: 0.07 });
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
    expect(messages.some(m => m.includes("cancel-race"))).toBe(true);
  });

  it("polls to terminal after cancel: open→canceled returns the actual partial for unwind sizing", async () => {
    krakenOrderInfo
      .mockResolvedValueOnce(orderInfo("open"))            // poll 1
      .mockResolvedValueOnce(orderInfo("open"))            // poll 2 → timeout
      .mockResolvedValueOnce(orderInfo("open"))            // post-cancel read 1 (cancel pending)
      .mockResolvedValue(orderInfo("canceled", 0.4, 80, 0.013)); // terminal with partial

    const { log } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg3 SOL sell", log, 1_000), 15
    );

    expect(result).toMatchObject({ filled: false, volExec: 0.4, cost: 80, fee: 0.013 });
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
  });

  // ── krakenCancelOrder failure doesn't prevent final state read ─────────────

  it("still reads final state and returns correct volExec when krakenCancelOrder throws", async () => {
    krakenCancelOrder.mockRejectedValue(new Error("cancel rejected by exchange"));
    // 1 s timeout → 2 polls. Queue exactly 2 "open" responses so both polls
    // exhaust; post-cancel final query (3rd call) returns partial fill.
    krakenOrderInfo
      .mockResolvedValueOnce(orderInfo("open"))           // poll 1
      .mockResolvedValueOnce(orderInfo("open"))           // poll 2 → timeout
      .mockResolvedValue(orderInfo("canceled", 0.25, 50, 0.008)); // post-cancel

    const { log, messages } = makeLog();
    const result = await runWithFakeTimers(
      waitForTriLimitFill(CREDS, TXID, "leg3 BTC sell", log, 1_000), 10
    );

    expect(result).toMatchObject({ filled: false, volExec: 0.25 });
    // Cancel was attempted (and threw), but execution continued to read final state
    expect(krakenCancelOrder).toHaveBeenCalledOnce();
    expect(messages.some(m => m.includes("cancel failed"))).toBe(true);
    expect(messages.some(m => m.includes("cancelled with partial"))).toBe(true);
  });
});
