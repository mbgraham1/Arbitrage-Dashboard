/**
 * Nonce monotonicity, legacy-format continuity, concurrent-use detection, and
 * the single safe retry on "EAPI:Invalid nonce".
 *
 * Background: the legacy nonce format was `Date.now().toString()` + 5 random
 * digits (≈ ms × 100,000). The current generator MUST stay at that magnitude —
 * a smaller scale would leave every call after an upgrade/restart below the
 * key's Kraken-recorded high-water nonce, permanently failing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  nextNonce,
  recordNonceError,
  getKrakenNonceHealth,
  krakenPrivateRequest,
} from "./exchange";

const uniqueKey = (tag: string) => `test-key-${tag}-${Math.random().toString(36).slice(2)}`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("nextNonce", () => {
  it("is strictly increasing per key, even within one millisecond", () => {
    const key = uniqueKey("mono");
    let prev = BigInt(nextNonce(key));
    for (let i = 0; i < 1000; i++) {
      const n = BigInt(nextNonce(key));
      expect(n).toBeGreaterThan(prev);
      prev = n;
    }
  });

  it("keys do not share nonce state (concurrent same-process keys stay independent)", () => {
    const a = uniqueKey("a");
    const b = uniqueKey("b");
    // Interleave calls on two keys — each key's sequence must still be
    // strictly increasing regardless of the other's activity.
    let prevA = 0n, prevB = 0n;
    for (let i = 0; i < 50; i++) {
      const na = BigInt(nextNonce(a));
      const nb = BigInt(nextNonce(b));
      expect(na).toBeGreaterThan(prevA);
      expect(nb).toBeGreaterThan(prevB);
      prevA = na; prevB = nb;
    }
  });

  it("exceeds the legacy nonce format's high-water mark after a restart (>=1ms later)", () => {
    // Legacy format: Date.now() string + 5 random digits. Worst case suffix
    // is 99999 at some past millisecond. Any restart happens at a later
    // millisecond, so the new base (ms × 100,000) must exceed it.
    const pastMs = Date.now() - 1; // restart is always ≥1ms after the last legacy call
    const legacyHighWater = BigInt(`${pastMs}99999`);
    const key = uniqueKey("legacy");
    const fresh = BigInt(nextNonce(key)); // fresh state — same as after process restart
    expect(fresh).toBeGreaterThan(legacyHighWater);
  });

  it("matches the legacy magnitude (ms × 100,000 scale)", () => {
    const key = uniqueKey("scale");
    const n = BigInt(nextNonce(key));
    const nowScaled = BigInt(Date.now()) * 100000n;
    expect(n >= nowScaled - 100000n * 1000n).toBe(true); // within ~1s below
    expect(n <= nowScaled + 100000n * 1000n).toBe(true); // within ~1s above
  });
});

describe("nonce error detection (concurrent-use flag)", () => {
  it("flags concurrent use after 2 errors in the window and clears after it ages out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    const key = uniqueKey("health");

    expect(getKrakenNonceHealth().concurrentUseSuspected).toBe(false);

    recordNonceError(key);
    expect(getKrakenNonceHealth().concurrentUseSuspected).toBe(false); // 1 error — not yet

    recordNonceError(key);
    const h = getKrakenNonceHealth();
    expect(h.concurrentUseSuspected).toBe(true);
    expect(h.recentNonceErrors).toBeGreaterThanOrEqual(2);
    expect(h.hint).toMatch(/same Kraken API key/i);

    // Age past the 10-minute window — the flag must clear on its own.
    vi.setSystemTime(new Date("2026-08-08T12:11:00Z"));
    const later = getKrakenNonceHealth();
    expect(later.concurrentUseSuspected).toBe(false);
    expect(later.totalNonceErrors).toBeGreaterThanOrEqual(2); // lifetime counter persists
  });
});

describe("krakenPrivateRequest nonce-error retry", () => {
  const creds = { krakenKey: uniqueKey("retry"), krakenSecret: Buffer.from("secret").toString("base64") };
  const jsonResp = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("retries exactly once on EAPI:Invalid nonce and succeeds", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResp({ error: ["EAPI:Invalid nonce"] }))
      .mockResolvedValueOnce(jsonResp({ error: [], result: { ok: true } }));

    const out = await krakenPrivateRequest<{ ok: boolean }>("/0/private/Balance", {}, creds);
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry must use a HIGHER nonce than the failed attempt.
    const nonceOf = (call: unknown[]) =>
      BigInt(new URLSearchParams((call[1] as RequestInit).body as string).get("nonce")!);
    expect(nonceOf(fetchMock.mock.calls[1])).toBeGreaterThan(nonceOf(fetchMock.mock.calls[0]));
  });

  it("does not retry more than once — a second nonce failure propagates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResp({ error: ["EAPI:Invalid nonce"] }));

    await expect(krakenPrivateRequest("/0/private/Balance", {}, creds)).rejects.toThrow(/Invalid nonce/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + exactly one retry
  });

  it("does not retry (or double-call) on success or non-nonce errors", async () => {
    const okMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResp({ error: [], result: { fine: 1 } }));
    await krakenPrivateRequest("/0/private/Balance", {}, creds);
    expect(okMock).toHaveBeenCalledTimes(1);
    okMock.mockRestore();

    const errMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResp({ error: ["EGeneral:Invalid arguments"] }));
    await expect(krakenPrivateRequest("/0/private/Balance", {}, creds)).rejects.toThrow(/Invalid arguments/);
    expect(errMock).toHaveBeenCalledTimes(1);
  });
});
