/**
 * Shared execution-lock helper for the three executors (cross-exchange,
 * triangular, OB Hunter). Bot-context stores each lock as a React ref
 * (`{ current: boolean }`); this helper acquires/releases a lock around an
 * async execution with guaranteed `finally` cleanup, so a thrown error can
 * never leave the lock stuck and block all future auto-trades.
 */
export interface LockRef {
  current: boolean;
}

/**
 * Runs `fn` while holding `lock`. If the lock is already held (another
 * execution is in flight), `fn` is NOT run and `undefined` is returned.
 * The lock is always released when `fn` settles, even on throw.
 */
export async function withExecutionLock<T>(
  lock: LockRef,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (lock.current) return undefined;
  lock.current = true;
  try {
    return await fn();
  } finally {
    lock.current = false;
  }
}
