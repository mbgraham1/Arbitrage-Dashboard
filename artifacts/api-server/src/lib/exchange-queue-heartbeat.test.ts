/**
 * Ownership-scoped liveness while a private call waits in the per-key serial
 * limiter queue.
 *
 * Regression under test (task: long-resting trade falsely declared dead):
 * the limiter used to beat the heartbeat only when a call STARTED — a call
 * merely queued behind others on the same key produced >15s of heartbeat
 * silence, letting FORCE-mode stale-lock eviction (15s) kill a healthy run.
 *
 * The fix binds the heartbeat to the lock-owning execution's async scope
 * (AsyncLocalStorage). Requirements proven here:
 *   1. The OWNER's queued call beats its heartbeat every 5s while waiting in
 *      the queue — so a resting leg under heavy private-call load is never
 *      silent long enough to be FORCE-evicted.
 *   2. The queue-beat interval is torn down once the call completes (no
 *      leaked timers keeping a finished run "alive").
 *   3. Calls OUTSIDE the owner's scope beat NOTHING — a separate backed-up
 *      private call can never refresh (and thus shield) a dead execution's
 *      lock, so a dead lock remains FORCE-evictable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withPrivateLimiter, runWithLockHeartbeat } from "./exchange";

const uniqueKey = (tag: string) => `hb-key-${tag}-${Math.random().toString(36).slice(2)}`;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("withPrivateLimiter — ownership-scoped queue heartbeat", () => {

  it("the lock owner's queued call beats its heartbeat every ≤5s while waiting >15s in the queue", async () => {
    const key = uniqueKey("owner");
    const owner = vi.fn();

    // An earlier slow call occupies the per-key serial chain (~20s in flight).
    const slow = deferred<string>();
    const p1 = withPrivateLimiter(key, () => slow.promise, false);

    // The OWNER's call is initiated inside its heartbeat scope and queues
    // behind the slow call — exactly a resting-leg poll under heavy load.
    const fast = deferred<string>();
    let p2!: Promise<string>;
    await runWithLockHeartbeat(owner, async () => {
      p2 = withPrivateLimiter(key, () => fast.promise, false);
    });

    // 16s pass with the owner's call still QUEUED (silence > FORCE_LOCK_STALE_MS=15s
    // would have evicted it before the fix). The queue interval must have
    // beaten at least 3 times (5s cadence).
    await vi.advanceTimersByTimeAsync(16_000);
    expect(owner.mock.calls.length).toBeGreaterThanOrEqual(3);
    const midCount = owner.mock.calls.length;

    // Owner keeps beating while still queued.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(owner.mock.calls.length).toBeGreaterThan(midCount);

    // Let both calls complete (600ms min-gap pacing between them).
    slow.resolve("one");
    await vi.advanceTimersByTimeAsync(1_000);
    fast.resolve("two");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p1).resolves.toBe("one");
    await expect(p2).resolves.toBe("two");

    // 2. Interval torn down: no further beats after completion.
    const finalCount = owner.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(owner.mock.calls.length).toBe(finalCount);
  });

  it("a separate queued private call OUTSIDE the owner's scope never beats the owner's heartbeat (dead lock stays FORCE-evictable)", async () => {
    const key = uniqueKey("stranger");
    // Heartbeat of a (dead) execution that bound a scope but makes no calls.
    const deadOwner = vi.fn();
    await runWithLockHeartbeat(deadOwner, async () => { /* crashed — no calls in flight */ });

    // Unrelated traffic on the SAME key: one slow call plus one queued call,
    // both outside the dead owner's scope.
    const slow = deferred<string>();
    const p1 = withPrivateLimiter(key, () => slow.promise, false);
    const queued = deferred<string>();
    const p2 = withPrivateLimiter(key, () => queued.promise, false);

    // 20s of heavy unrelated load — the dead owner's heartbeat must stay
    // SILENT so FORCE eviction (15s threshold) still sees it as dead.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deadOwner).not.toHaveBeenCalled();

    slow.resolve("a");
    await vi.advanceTimersByTimeAsync(1_000);
    queued.resolve("b");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p1).resolves.toBe("a");
    await expect(p2).resolves.toBe("b");
    expect(deadOwner).not.toHaveBeenCalled();
  });

  it("beats during rate-limit backoff stay scoped to the caller that hit the backoff", async () => {
    const key = uniqueKey("backoff");
    const owner = vi.fn();
    // First call rate-limits → opens a backoff window; the read retries.
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("EAPI:Rate limit exceeded");
      return "ok";
    });
    let p!: Promise<string>;
    await runWithLockHeartbeat(owner, async () => {
      p = withPrivateLimiter(key, fn, true);
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe("ok");
    // Backoff-wait beats went to the owner's heartbeat.
    expect(owner.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
