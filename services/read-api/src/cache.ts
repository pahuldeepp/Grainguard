import { createHash, randomUUID } from "node:crypto";
import type { ReadBackends, HistoryQuery } from "./backends.js";

/**
 * Read API cache-aside over Redis Cluster (ADR-0015).
 *
 * Correctness never depends on Redis: every Redis call is bounded by a timeout,
 * failures open a short circuit breaker, and the owning store is always the
 * fallback. The per-key lock only reduces duplicate origin loads.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { PX: number; NX?: true },
  ): Promise<string | null>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

export interface CacheOptions {
  ttlMs?: number;
  lockMs?: number;
  waitMs?: number;
  /** Upper bound for any single Redis command. */
  opTimeoutMs?: number;
  /** Serialized entries larger than this are served but not cached. */
  maxValueBytes?: number;
  /** Consecutive Redis failures before the cache is bypassed. */
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  /** How long a fetched global epoch is trusted before it is re-read (ADR-0016). */
  epochRefreshMs?: number;
  random?: () => number;
  now?: () => number;
}

export const CACHE_KEY_VERSION = "v1";
const PREFIX = `gg:read:${CACHE_KEY_VERSION}`;
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
// The lock holder overwrites; a holder whose lock expired mid-load may only fill an
// absent key, so it never replaces a newer fill and waiters are not starved.
const FILL = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) else return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3], 'NX') end`;
const BUMP = `return redis.call('INCR', KEYS[1])`;
// Tenant IDs come from verified tokens; anything that could break the hash tag is not cached.
// Device IDs share the rule because they are embedded in the device version key.
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
/** Global epoch (ADR-0016): bumped after a Redis outage so older entries are never trusted. */
export const EPOCH_KEY = `${PREFIX}:epoch`;

const COUNTERS = [
  "hit",
  "miss",
  "load",
  "fill",
  "fill_rejected",
  "timeout",
  "error",
  "fallback",
  "bypass",
  "lock_acquired",
  "lock_wait_timeout",
  "oversize",
  "mismatch",
  "invalidation",
] as const;
export type CacheCounter = (typeof COUNTERS)[number];

/** Process-wide counters; deliberately no tenant labels. */
export class CacheMetrics {
  private readonly counts = new Map<CacheCounter, number>(
    COUNTERS.map((name) => [name, 0]),
  );
  inc(name: CacheCounter): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  snapshot(): Record<CacheCounter, number> {
    return Object.fromEntries(this.counts) as Record<CacheCounter, number>;
  }
  prometheus(): string {
    return COUNTERS.map(
      (name) =>
        `greenguard_read_cache_events_total{event="${name}"} ${this.counts.get(name)}`,
    ).join("\n");
  }
}

class CacheTimeout extends Error {}
type Outcome<T> = { ok: true; value: T } | { ok: false };
type Lookup<T> =
  { state: "hit"; value: T } | { state: "miss" } | { state: "down" };
interface Envelope<T> {
  t: string;
  k: string;
  v: T;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`invalid_cache_${name}`);
  return value;
}

export function tenantTag(tenant: string): string {
  return `{t:${tenant}}`;
}

/** Tenant generation key; bumped for structural (device/site/bin/alert/config) changes. */
export function generationKey(tenant: string): string {
  return `${PREFIX}:${tenantTag(tenant)}:gen`;
}

/** Per-device version key in the tenant's slot; bumped for telemetry-driven changes. */
export function deviceVersionKey(tenant: string, device: string): string {
  return `${PREFIX}:${tenantTag(tenant)}:d:${device}:ver`;
}

type Stamp = [epoch: string, generation: string | null, device: string | null];

// Epoch 0 and tenant-wide reads keep the original `g<generation>` segment.
function stampPart([epoch, generation, device]: Stamp): string {
  const epochPart = epoch === "0" ? "" : `:e${epoch}`;
  const devicePart = device === null ? "" : `:d${device}`;
  return `g${generation ?? "0"}${epochPart}${devicePart}`;
}

export class ReadCache {
  readonly metrics = new CacheMetrics();
  private readonly ttl: number;
  private readonly lockMs: number;
  private readonly waitMs: number;
  private readonly opTimeoutMs: number;
  private readonly maxValueBytes: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly epochRefreshMs: number;
  private failures = 0;
  private openUntil = 0;
  private epoch: string | null = null;
  private epochReadAt = 0;

  constructor(
    private readonly redis: CacheStore,
    options: CacheOptions = {},
  ) {
    this.ttl = positive(options.ttlMs ?? 15_000, "ttl");
    this.lockMs = positive(options.lockMs ?? 2_000, "lock");
    this.waitMs = positive(options.waitMs ?? 250, "wait");
    this.opTimeoutMs = positive(options.opTimeoutMs ?? 50, "timeout");
    this.maxValueBytes = positive(options.maxValueBytes ?? 262_144, "size");
    this.breakerThreshold = positive(options.breakerThreshold ?? 5, "breaker");
    this.breakerCooldownMs = positive(
      options.breakerCooldownMs ?? 1_000,
      "cooldown",
    );
    this.epochRefreshMs = positive(options.epochRefreshMs ?? 1_000, "epoch");
    if (this.ttl < 1 || this.lockMs < 1 || this.opTimeoutMs < 1)
      throw new Error("invalid_cache_timing");
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  /** Tenant-scoped invalidation: bumps only this tenant's generation key. */
  async invalidateTenant(tenant: string): Promise<boolean> {
    if (!TENANT.test(tenant)) return false;
    return this.bump(generationKey(tenant));
  }

  /** Device-scoped invalidation: other devices of the same tenant keep their entries. */
  async invalidateDevice(tenant: string, device: string): Promise<boolean> {
    if (!TENANT.test(tenant) || !TENANT.test(device)) return false;
    return this.bump(deviceVersionKey(tenant, device));
  }

  private async bump(key: string): Promise<boolean> {
    const result = await this.attempt(() =>
      this.redis.eval(BUMP, { keys: [key], arguments: [] }),
    );
    if (result.ok) this.metrics.inc("invalidation");
    return result.ok;
  }

  /**
   * Cache-aside read. `device` marks a telemetry-driven read (latest reading,
   * recent history): its key also carries that device's version.
   */
  async get<T>(
    tenant: string,
    kind: string,
    args: unknown[],
    load: () => Promise<T>,
    device?: string,
  ): Promise<T> {
    const deviceOk = device === undefined || TENANT.test(device);
    if (!TENANT.test(tenant) || !deviceOk || this.now() < this.openUntil) {
      this.metrics.inc("bypass");
      return this.origin(load);
    }
    const stamp = await this.attempt(() => this.stamp(tenant, device));
    if (!stamp.ok) return this.fallback(load);
    const digest = createHash("sha256")
      .update(JSON.stringify([kind, args]))
      .digest("hex");
    const key = `${PREFIX}:${tenantTag(tenant)}:${stampPart(stamp.value)}:${digest}`;
    const first = await this.lookup<T>(key, tenant, digest);
    if (first.state === "hit") return first.value;
    if (first.state === "down") return this.fallback(load);
    this.metrics.inc("miss");
    return this.singleFlight(key, tenant, digest, load);
  }

  /** Epoch, tenant generation and (optionally) device version, read in parallel. */
  private stamp(tenant: string, device?: string): Promise<Stamp> {
    return Promise.all([
      this.currentEpoch(),
      this.redis.get(generationKey(tenant)),
      device === undefined
        ? Promise.resolve(null)
        : this.redis
            .get(deviceVersionKey(tenant, device))
            .then((version) => version ?? "0"),
    ]);
  }

  private async currentEpoch(): Promise<string> {
    const fresh = this.now() - this.epochReadAt < this.epochRefreshMs;
    if (this.epoch !== null && fresh) return this.epoch;
    const value = (await this.redis.get(EPOCH_KEY)) ?? "0";
    this.epoch = value;
    this.epochReadAt = this.now();
    return value;
  }

  private async singleFlight<T>(
    key: string,
    tenant: string,
    digest: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const lock = `${key}:lock`;
    const deadline = this.now() + this.waitMs;
    for (;;) {
      const token = randomUUID();
      const acquired = await this.attempt(() =>
        this.redis.set(lock, token, { NX: true, PX: this.lockMs }),
      );
      if (!acquired.ok) return this.fallback(load);
      if (acquired.value === "OK")
        return this.loadWithLock(key, lock, token, tenant, digest, load);
      const found = await this.lookup<T>(key, tenant, digest);
      if (found.state === "hit") return found.value;
      if (found.state === "down") return this.fallback(load);
      if (this.now() >= deadline) {
        this.metrics.inc("lock_wait_timeout");
        return this.origin(load);
      }
      await sleep(Math.min(20, Math.max(1, deadline - this.now())));
    }
  }

  private async loadWithLock<T>(
    key: string,
    lock: string,
    token: string,
    tenant: string,
    digest: string,
    load: () => Promise<T>,
  ): Promise<T> {
    this.metrics.inc("lock_acquired");
    try {
      // Double-check: a previous holder may have filled while we waited.
      const found = await this.lookup<T>(key, tenant, digest);
      if (found.state === "hit") return found.value;
      const value = await this.origin(load);
      await this.fill(key, lock, token, { t: tenant, k: digest, v: value });
      return value;
    } finally {
      await this.attempt(() =>
        this.redis.eval(UNLOCK, { keys: [lock], arguments: [token] }),
      );
    }
  }

  private async fill<T>(
    key: string,
    lock: string,
    token: string,
    envelope: Envelope<T>,
  ): Promise<void> {
    if (envelope.v === undefined) return;
    const raw = JSON.stringify(envelope);
    if (Buffer.byteLength(raw) > this.maxValueBytes) {
      this.metrics.inc("oversize");
      return;
    }
    const ttl = this.ttl + Math.floor(this.ttl * 0.2 * this.random());
    const result = await this.attempt(() =>
      this.redis.eval(FILL, {
        keys: [lock, key],
        arguments: [token, raw, String(ttl)],
      }),
    );
    if (result.ok) this.metrics.inc(result.value ? "fill" : "fill_rejected");
  }

  private async lookup<T>(
    key: string,
    tenant: string,
    digest: string,
  ): Promise<Lookup<T>> {
    const raw = await this.attempt(() => this.redis.get(key));
    if (!raw.ok) return { state: "down" };
    if (raw.value === null) return { state: "miss" };
    let envelope: Partial<Envelope<T>> | null;
    try {
      envelope = JSON.parse(raw.value) as Partial<Envelope<T>>;
    } catch {
      envelope = null;
    }
    // Defence in depth: the stored owner must equal the requesting tenant and key.
    if (envelope?.t !== tenant || envelope.k !== digest || !("v" in envelope)) {
      this.metrics.inc("mismatch");
      return { state: "miss" };
    }
    this.metrics.inc("hit");
    return { state: "hit", value: envelope.v as T };
  }

  private fallback<T>(load: () => Promise<T>): Promise<T> {
    this.metrics.inc("fallback");
    return this.origin(load);
  }

  private origin<T>(load: () => Promise<T>): Promise<T> {
    this.metrics.inc("load");
    return load();
  }

  private async attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CacheTimeout()), this.opTimeoutMs);
    });
    try {
      const value = await Promise.race([fn(), timeout]);
      this.failures = 0;
      return { ok: true, value };
    } catch (error) {
      this.metrics.inc(error instanceof CacheTimeout ? "timeout" : "error");
      this.failures++;
      if (this.failures >= this.breakerThreshold) {
        this.openUntil = this.now() + this.breakerCooldownMs;
        this.failures = 0;
      }
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

export type CachedReadBackends = ReadBackends & {
  cache: ReadCache;
};

export function cacheBackends(
  backends: ReadBackends,
  redis: CacheStore,
  options: CacheOptions = {},
): CachedReadBackends {
  const cache = new ReadCache(redis, options);
  const historyArgs = (q: HistoryQuery) => [
    q.deviceId,
    q.from.toISOString(),
    q.to.toISOString(),
    q.limit,
    q.after ? [q.after.observedAt.toISOString(), q.after.readingId] : null,
  ];
  return {
    cache,
    devices: backends.devices,
    deviceCurrent: backends.deviceCurrent,
    deviceRisk: backends.deviceRisk,
    sites: (tenant, ids) =>
      cache.get(
        tenant,
        "sites",
        [...ids].sort((a, b) => Number(a > b) - Number(a < b)),
        () => backends.sites(tenant, ids),
      ),
    bins: (tenant, ids) =>
      cache.get(
        tenant,
        "bins",
        [...ids].sort((a, b) => Number(a > b) - Number(a < b)),
        () => backends.bins(tenant, ids),
      ),
    reading: backends.reading,
    device: (tenant, device) =>
      cache.get(tenant, "device", [device], () =>
        backends.device(tenant, device),
      ),
    devicesBySite: (tenant, site, limit, after) =>
      cache.get(tenant, "site", [site, limit, after], () =>
        backends.devicesBySite(tenant, site, limit, after),
      ),
    // Telemetry-driven reads are device-versioned so one busy device never clears
    // the tenant's other entries (ADR-0016).
    latest: (tenant, device) =>
      cache.get(
        tenant,
        "latest",
        [device],
        () => backends.latest(tenant, device),
        device,
      ),
    // Bin payloads carry readings from several independently versioned devices.
    // Until the cache supports a version vector, bypass it to avoid stale telemetry.
    binReadings: backends.binReadings,
    binTrend: backends.binTrend,
    hotReadings: (q) =>
      cache.get(
        q.tenantId,
        "hot",
        historyArgs(q),
        () => backends.hotReadings(q),
        q.deviceId,
      ),
    rollup: (q, bucket) =>
      cache.get(
        q.tenantId,
        "rollup",
        [...historyArgs(q), bucket],
        () => backends.rollup(q, bucket),
        q.deviceId,
      ),
    history: {
      list: (q) =>
        cache.get(
          q.tenantId,
          "history",
          historyArgs(q),
          () => backends.history.list(q),
          q.deviceId,
        ),
    },
    search: {
      search: (tenant, query, limit) =>
        cache.get(tenant, "search", [query, limit], () =>
          backends.search.search(tenant, query, limit),
        ),
    },
  };
}
