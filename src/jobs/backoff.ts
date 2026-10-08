const RETRYABLE_STATUS = [429, 500, 502, 503, 504, 529];

export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return RETRYABLE_STATUS.includes(status);
  return err instanceof TypeError; // network failure
}

/** attempt is 1-based. Retry-After wins; otherwise 2s * 2^(attempt-1) with +/-20% jitter. */
export function delayFor(attempt: number, retryAfterMs: number | undefined, rand: () => number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = 2000 * Math.pow(2, attempt - 1);
  return Math.round(base * (0.8 + 0.4 * rand()));
}
