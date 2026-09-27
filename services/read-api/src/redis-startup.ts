import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_REDIS_STARTUP_WAIT_MS = 2000;

/** Reads READ_REDIS_STARTUP_WAIT_MS; invalid or negative values use the default. */
export function redisStartupWaitMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_REDIS_STARTUP_WAIT_MS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_REDIS_STARTUP_WAIT_MS;
}

/**
 * Starts the optional Redis connection and waits at most `waitMs` for it.
 * The connection keeps going in the background; a failure is only reported,
 * because reads fall back to their owning stores.
 */
export async function connectRedisBounded(
  store: { connect(): Promise<void> },
  waitMs: number,
  report: (error: unknown) => void,
): Promise<void> {
  const connecting = store.connect().catch(report);
  const timer = new AbortController();
  try {
    await Promise.race([
      connecting,
      delay(waitMs, undefined, { signal: timer.signal }),
    ]);
  } finally {
    timer.abort();
  }
}
