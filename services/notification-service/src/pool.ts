/** Bounded concurrency for provider calls, separate from the consumer prefetch window. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("semaphore limit must be a positive integer");
  }

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

export class TimeoutError extends Error {}

/**
 * Runs fn with an AbortSignal that fires after ms, and stops waiting at the deadline even if
 * fn ignores the signal, so a misbehaving provider cannot hold a pool slot forever. A
 * timeout is reported to the caller, never hidden.
 */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`timed out after ${ms} ms`));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
