// Task 9: retry timing for transient send failures.
//
// Ownership: how long the queue waits before the next automatic attempt -
// and ONLY that. The rules come straight from the spec: transient failures
// back off from 5 seconds, doubling each attempt, capped at 15 minutes,
// with a small random jitter on top (一時失敗は5秒から倍増、最大15分間隔で
// 小さなばらつきを加える).
//
// This module never touches a deadline. Automatic retries must NOT extend
// the original 24-hour `expires_at` (自動再試行では期限を延長しない) - the
// caller keeps the stored deadline untouched and only schedules
// `next_attempt_at`, which is exactly what queue.ts does.

/** First retry delay: 5 seconds. */
export const RETRY_BASE_MS = 5_000;

/** Upper bound of the interval: 15 minutes. */
export const RETRY_MAX_MS = 15 * 60 * 1000;

/** Jitter: ±10% of the computed delay (小さなばらつき). */
export const RETRY_JITTER_RATIO = 0.1;

/**
 * Delay before attempt `attempt` (1-based; attempt 1 has just failed).
 * Exponential: 5s, 10s, 20s … capped at 15 minutes, then jittered by
 * ±`RETRY_JITTER_RATIO` and clamped so the cap still holds.
 *
 * `random` is the injected jitter source (tests pass a constant).
 */
export function backoffDelay(attempt: number, random: () => number): number {
  const step = attempt < 1 ? 1 : attempt;
  const exponential = RETRY_BASE_MS * 2 ** (step - 1);
  const capped = Math.min(exponential, RETRY_MAX_MS);
  const raw = Math.min(Math.max(random(), 0), 1) * 2 - 1; // [-1, 1)
  const jittered = Math.round(capped * (1 + raw * RETRY_JITTER_RATIO));
  return Math.min(Math.max(jittered, 1), RETRY_MAX_MS);
}

/** Absolute timestamp of the next automatic attempt. */
export function nextAttemptAt(
  now: number,
  attempt: number,
  random: () => number,
): number {
  return now + backoffDelay(attempt, random);
}
