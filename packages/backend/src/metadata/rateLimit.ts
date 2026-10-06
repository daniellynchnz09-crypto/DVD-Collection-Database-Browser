/**
 * Minimal sliding-window rate limiter shared by every metadata fetch in this process, so the
 * scan-confirm hook and a backfill running in the same process can't jointly burst past a
 * provider's limit. Callers `await limiter()` before each request.
 */
export function createRateLimiter(maxPerWindow: number, windowMs: number): () => Promise<void> {
  const stamps: number[] = [];
  // Serialises waiters so concurrent callers queue up instead of all reading the same window.
  let chain: Promise<void> = Promise.resolve();

  const acquire = async () => {
    for (;;) {
      const now = Date.now();
      while (stamps.length > 0 && now - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < maxPerWindow) {
        stamps.push(now);
        return;
      }
      await sleep(windowMs - (now - stamps[0]) + 5);
    }
  };

  return () => {
    const next = chain.then(acquire);
    chain = next.catch(() => undefined);
    return next;
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
