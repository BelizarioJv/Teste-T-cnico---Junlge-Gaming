/**
 * Backoff exponencial com teto: base * 2^(attempt-1), limitado a `max`.
 * `jitter` (0..1) espalha retries simultâneos; 0 = determinístico.
 */
export function exponentialBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter = 0.2,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(safeAttempt - 1, 30));
  const spread = exponential * jitter;

  return Math.max(0, Math.round(exponential - spread + random() * spread * 2));
}

/** sleep que acorda imediatamente se o sinal for abortado. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(done, ms);

    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }

    signal?.addEventListener('abort', done, { once: true });
  });
}
