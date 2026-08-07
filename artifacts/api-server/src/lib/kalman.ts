/**
 * kalman.ts — 1D Kalman filter for dynamic hedge ratio estimation in pairs trading
 *
 * Tracks the hedge ratio β between two cointegrated assets using a random-walk
 * state model. The spread is defined as:
 *   spread_t = price1_t − β_t · price2_t
 *
 * Standard Kalman update (scalar case):
 *   Predict:  x⁻ = x̂,  P⁻ = P + Q
 *   Gain:     K  = P⁻ · H / (H² · P⁻ + R)   where H = price2
 *   Update:   x̂ = x⁻ + K · (price1 − H · x⁻)
 *             P  = (1 − K · H) · P⁻
 */

export interface KalmanState {
  /** Current hedge-ratio estimate */
  beta: number;
  /** State-variance estimate */
  variance: number;
  /** Process noise — controls how quickly β can drift */
  processNoise: number;
  /** Observation noise */
  observationNoise: number;
}

/**
 * Create a new Kalman state with sensible defaults for crypto pairs.
 *
 * @param initialBeta   Starting hedge ratio (e.g. price1/price2 ratio)
 * @param processNoise  Q — larger = β adapts faster (default 1e-4)
 * @param observationNoise R — price measurement noise (default 1e-2)
 */
export function createKalmanState(
  initialBeta: number,
  processNoise = 1e-4,
  observationNoise = 1e-2,
): KalmanState {
  return {
    beta: initialBeta,
    variance: 1.0,
    processNoise,
    observationNoise,
  };
}

/**
 * Feed a new (price1, price2) observation and return the updated state
 * plus the current spread value.
 *
 * @returns { state, spread } — updated KalmanState and the residual spread
 */
export function kalmanUpdate(
  state: KalmanState,
  price1: number,
  price2: number,
): { state: KalmanState; spread: number } {
  const { beta, variance, processNoise, observationNoise } = state;

  // ── Predict ────────────────────────────────────────────────────────────────
  const betaMinus = beta;
  const varMinus  = variance + processNoise;

  // ── Update ─────────────────────────────────────────────────────────────────
  // Observation model: H = price2
  const H = price2;
  const innovation = price1 - H * betaMinus;      // residual (spread)
  const S = H * H * varMinus + observationNoise;   // innovation covariance
  const K = (varMinus * H) / S;                    // Kalman gain

  const betaNew  = betaMinus + K * innovation;
  const varNew   = (1 - K * H) * varMinus;

  return {
    state: { ...state, beta: betaNew, variance: varNew },
    spread: innovation,
  };
}

// ── Rolling spread history for z-score computation ─────────────────────────

const MAX_HISTORY = 100;

export interface PairHistory {
  kalman: KalmanState;
  spreads: number[];  // last MAX_HISTORY spread values
}

/**
 * Update a pair's Kalman state + spread history and return the current z-score.
 * Mutates `history` in place (caller stores the object).
 *
 * @returns z-score of the latest spread (NaN if fewer than 2 observations)
 */
export function updatePairHistory(
  history: PairHistory,
  price1: number,
  price2: number,
): number {
  const { state: newState, spread } = kalmanUpdate(history.kalman, price1, price2);
  history.kalman = newState;

  history.spreads.push(spread);
  if (history.spreads.length > MAX_HISTORY) {
    history.spreads.shift();
  }

  if (history.spreads.length < 2) return NaN;

  const n    = history.spreads.length;
  const mean = history.spreads.reduce((a, b) => a + b, 0) / n;
  const variance = history.spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std  = Math.sqrt(variance);

  return std > 0 ? (spread - mean) / std : 0;
}

/**
 * Create a fresh PairHistory, bootstrapped with a sensible initial beta
 * (price1 / price2 as a naive starting point).
 */
export function createPairHistory(price1: number, price2: number): PairHistory {
  const initialBeta = price2 > 0 ? price1 / price2 : 1;
  return {
    kalman: createKalmanState(initialBeta),
    spreads: [],
  };
}
