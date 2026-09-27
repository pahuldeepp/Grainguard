export interface BucketOptions {
  capacity: number;
  refillPerSecond: number;
  /** Upper bound on tracked addresses; the oldest is evicted first. */
  maxEntries: number;
}

interface Entry {
  tokens: number;
  at: number;
}

// Small in-process, per-address token bucket for an unauthenticated route. It is
// a backstop only: a production edge (WAF/CDN/gateway) must still rate limit,
// because this state is per replica and resets on restart.
export class IpTokenBucket {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: BucketOptions) {}

  get size() {
    return this.entries.size;
  }

  /** Returns 0 when allowed, else the whole seconds to wait (Retry-After). */
  take(key: string, nowMs: number): number {
    const { capacity, refillPerSecond } = this.options;
    const seen = this.entries.get(key);
    const tokens = seen
      ? Math.min(
          capacity,
          seen.tokens + ((nowMs - seen.at) / 1000) * refillPerSecond,
        )
      : capacity;
    this.entries.delete(key);
    if (tokens < 1) {
      this.entries.set(key, { tokens, at: nowMs });
      this.evict();
      return Math.max(1, Math.ceil((1 - tokens) / refillPerSecond));
    }
    this.entries.set(key, { tokens: tokens - 1, at: nowMs });
    this.evict();
    return 0;
  }

  private evict() {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

export function discoverBucket(env: NodeJS.ProcessEnv = process.env) {
  const burst = Number(env.IDENTITY_DISCOVER_BURST ?? 20);
  const perMinute = Number(env.IDENTITY_DISCOVER_PER_MINUTE ?? 30);
  if (
    !Number.isFinite(burst) ||
    burst < 1 ||
    !Number.isFinite(perMinute) ||
    perMinute <= 0
  )
    throw new Error(
      "IDENTITY_DISCOVER_BURST and IDENTITY_DISCOVER_PER_MINUTE must be positive",
    );
  return new IpTokenBucket({
    capacity: burst,
    refillPerSecond: perMinute / 60,
    maxEntries: 10_000,
  });
}
