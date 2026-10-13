import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import {
  createReadReplicas,
  FreshnessUnavailable,
  ReadPoolBusy,
  type MinimumSequence,
  type ReplicaOptions,
} from "./replicas.js";
import { postgresReads, withoutPostgresCache } from "./backends.js";
import { cacheBackends } from "./cache.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const minimum: MinimumSequence = {
  shardIncarnation: "shard-2-incarnation-1",
  placementEpoch: "4",
  sequence: "9007199254740993",
};
const url = (host: string) =>
  `postgres://read_query:secret@${host}:5432/greenguard_read?sslmode=verify-full&sslrootcert=%2Fca.pem`;
class FakePool {
  connections = 0;
  ends = 0;
  unavailable = false;
  pending = false;
  finishConnect?: (client: PoolClient) => void;
  queries: Array<{ sql: string; values: unknown[] }> = [];
  queryTimeouts: number[] = [];
  releases: Array<boolean> = [];
  watermark: Record<string, string> | null = {
    shard_incarnation: minimum.shardIncarnation,
    placement_epoch: minimum.placementEpoch,
    sequence: minimum.sequence,
  };
  businessError = false;
  onQuery?: (sql: string, values: unknown[]) => void | Promise<void>;
  idleError?: () => void;
  on(_event: string, fn: () => void) {
    this.idleError = fn;
    return this;
  }
  async end() {
    this.ends++;
  }
  async connect(): Promise<PoolClient> {
    this.connections++;
    if (this.unavailable) throw new Error("connection failed");
    const client = {
      query: async (
        config: string | { text: string; values?: unknown[] },
        args: unknown[] = [],
      ) => {
        const sql = typeof config === "string" ? config : config.text;
        const values =
          typeof config === "string" ? args : (config.values ?? []);
        this.queries.push({ sql, values });
        this.queryTimeouts.push(
          typeof config === "string"
            ? 0
            : ((config as { query_timeout?: number }).query_timeout ?? 0),
        );
        await this.onQuery?.(sql, values);
        if (sql.includes("projection_ownership_snapshot"))
          return {
            rows: [
              {
                shard_id: "s2",
                shard_incarnation: minimum.shardIncarnation,
                placement_epoch: minimum.placementEpoch,
                state: "active",
              },
            ],
          };
        if (sql.includes("projection_watermarks"))
          return { rows: this.watermark ? [this.watermark] : [] };
        if (sql === "BUSINESS" && this.businessError)
          throw new Error("business failed");
        return {
          rows: sql.includes("latest_readings")
            ? [{ tenant_id: values[0], stream_version: "7" }]
            : [],
        };
      },
      release: (discard?: boolean | Error) => {
        this.releases.push(Boolean(discard));
      },
    } as unknown as PoolClient;
    if (this.pending)
      return new Promise((resolve) => {
        this.finishConnect = resolve;
      });
    return client;
  }
}
function provider(pools: FakePool[], extra: ReplicaOptions = {}) {
  let index = 0;
  return createReadReplicas(
    JSON.stringify(pools.map((_, i) => url(`replica-${i + 1}`))),
    undefined,
    url("primary"),
    { poolFactory: () => pools[index++], ...extra },
  )!;
}

test("aborted request never checks out a connection or quarantines a replica", async () => {
  const pool = new FakePool();
  const reads = provider([pool]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reads.acquire({
      tenantId: TENANT,
      deadline: Date.now() + 1000,
      signal: controller.signal,
    }),
    FreshnessUnavailable,
  );
  assert.equal(pool.connections, 0);
  assert.equal((await reads.health())[0].healthy, true);
  await reads.close();
});

test("disconnect during pool checkout returns the late connection without starting SQL", async () => {
  const pool = new FakePool();
  pool.pending = true;
  const reads = provider([pool]);
  const controller = new AbortController();
  const work = reads.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 1000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(work, FreshnessUnavailable);
  const releases: boolean[] = [];
  pool.finishConnect!({
    release: (discard?: boolean) => releases.push(Boolean(discard)),
  } as unknown as PoolClient);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, [false]);
  assert.equal(pool.queries.length, 0);
  pool.pending = false;
  assert.equal((await reads.health())[0].healthy, true);
  await reads.close();
});

test("disconnect closes an admitted snapshot once and prevents further SQL or commit", async () => {
  const pool = new FakePool();
  const reads = provider([pool]);
  const controller = new AbortController();
  const lease = await reads.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 1000,
    signal: controller.signal,
  });
  controller.abort();
  assert.throws(() => lease.tx.query("BUSINESS"), FreshnessUnavailable);
  await assert.rejects(lease.commit(), FreshnessUnavailable);
  await lease.rollback();
  assert.deepEqual(pool.releases, [true]);
  assert.equal(
    pool.queries.some((q) => q.sql === "BUSINESS" || q.sql === "COMMIT"),
    false,
  );
  assert.equal((await reads.health())[0].healthy, true);
  await reads.close();
});

test("one failed replica does not fail readiness; only healthy endpoints are selected", async () => {
  const bad = new FakePool();
  bad.unavailable = true;
  const good = new FakePool();
  const reads = provider([bad, good]);
  await reads.ready();
  assert.deepEqual(
    (await reads.health()).map((h) => h.healthy),
    [false, true],
  );
  const lease = await reads.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 5000,
  });
  assert.equal(lease.endpoint, "replica-2");
  await lease.commit();
  assert.equal(bad.connections, 1);
  await reads.close();
});
test("all replicas failed is unavailable unless the allowed primary path is healthy", async () => {
  const bad = new FakePool();
  bad.unavailable = true;
  const alone = provider([bad]);
  await assert.rejects(alone.ready(), FreshnessUnavailable);
  await assert.rejects(
    alone.acquire({ tenantId: TENANT, deadline: Date.now() + 5000 }),
    FreshnessUnavailable,
  );
  await alone.close();
  const primary = new FakePool();
  const fallback = provider([bad], { primaryPool: primary });
  await fallback.ready();
  const lease = await fallback.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 5000,
  });
  assert.equal(lease.endpoint, "primary");
  await lease.commit();
  await fallback.close();
  assert.equal(primary.ends, 0);
});
test("primary recovery immediately restores readiness despite its prior failure backoff", async () => {
  let time = 1000;
  const replica = new FakePool();
  replica.unavailable = true;
  const primary = new FakePool();
  primary.unavailable = true;
  const reads = provider([replica], { primaryPool: primary, now: () => time });
  await assert.rejects(reads.ready(), FreshnessUnavailable);
  primary.unavailable = false;
  time = 1001;
  await assert.rejects(reads.ready(), FreshnessUnavailable);
  assert.equal(primary.connections, 1);
  time = 1100;
  await reads.ready();
  assert.equal(primary.connections, 2);
  assert.equal(replica.connections, 1);
  await reads.close();
});
test("failed endpoint probes respect exponential backoff and recover independently", async () => {
  let time = 1000;
  const bad = new FakePool();
  bad.unavailable = true;
  const reads = provider([bad], { now: () => time });
  await reads.health();
  assert.equal(bad.connections, 1);
  await reads.health();
  assert.equal(bad.connections, 1);
  time = 1500;
  await reads.health();
  assert.equal(bad.connections, 2);
  bad.unavailable = false;
  time = 2499;
  await reads.health();
  assert.equal(bad.connections, 2);
  time = 2500;
  assert.equal((await reads.health())[0].healthy, true);
  await reads.close();
});
test("idle errors evict their endpoint and concurrent health checks share one probe", async () => {
  const pool = new FakePool();
  const reads = provider([pool]);
  await Promise.all([reads.health(), reads.health(), reads.health()]);
  assert.equal(pool.connections, 1);
  pool.idleError!();
  assert.equal((await reads.health())[0].healthy, false);
  await reads.close();
});
test("a due recovery probe runs independently while the current read uses a healthy endpoint", async () => {
  let time = 1000;
  const bad = new FakePool();
  bad.unavailable = true;
  const good = new FakePool();
  const reads = provider([bad, good], { now: () => time });
  await reads.health();
  time = 1500;
  bad.unavailable = false;
  bad.pending = true;
  const lease = await reads.acquire({ tenantId: TENANT, deadline: 1510 });
  assert.equal(lease.endpoint, "replica-2");
  assert.equal(bad.connections, 2);
  await lease.commit();
  bad.finishConnect!({
    query: async () => ({ rows: [] }),
    release: () => {},
  } as unknown as PoolClient);
  await new Promise((resolve) => setImmediate(resolve));
  bad.pending = false;
  assert.equal((await reads.health())[0].healthy, true);
  await reads.close();
});
test("deadline rejects a pending connect and returns a late unused connection", async () => {
  const pool = new FakePool();
  pool.pending = true;
  const reads = provider([pool], { attemptTimeoutMs: 10 });
  await assert.rejects(
    reads.acquire({ tenantId: TENANT, deadline: Date.now() + 10 }),
    FreshnessUnavailable,
  );
  const discarded: boolean[] = [];
  pool.finishConnect!({
    release: (v: boolean) => discarded.push(v),
  } as unknown as PoolClient);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(discarded, [false]);
  await reads.close();
});

test("a local full-pool wait does not quarantine a healthy replica", async () => {
  const full = new FakePool(),
    good = new FakePool();
  Object.assign(full, {
    waitingCount: 1,
    totalCount: 1,
    idleCount: 0,
    options: { max: 1 },
  });
  full.pending = true;
  const reads = provider([full, good], { attemptTimeoutMs: 10 });
  const lease = await reads.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 100,
  });
  assert.equal(lease.endpoint, "replica-2");
  await lease.commit();
  let discarded = false;
  full.finishConnect!({
    release: (value: boolean) => {
      discarded = value;
    },
  } as unknown as PoolClient);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discarded, false);
  full.pending = false;
  const health = await reads.health();
  assert.equal(health[0].healthy, true);
  assert.equal(health[0].retryAt, 0);
  await reads.close();
});
test("shutdown closes every replica exactly once, rejects admission and preserves primary ownership", async () => {
  const pools = [new FakePool(), new FakePool()];
  const primary = new FakePool();
  const reads = provider(pools, { primaryPool: primary });
  await Promise.all([reads.close(), reads.close()]);
  assert.deepEqual(
    pools.map((p) => p.ends),
    [1, 1],
  );
  assert.equal(primary.ends, 0);
  await assert.rejects(
    reads.acquire({ tenantId: TENANT, deadline: Date.now() + 5000 }),
    FreshnessUnavailable,
  );
});
test("an admitted lease can roll back during shutdown using a bounded cleanup query", async () => {
  const pool = new FakePool();
  const reads = provider([pool]);
  const lease = await reads.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 5000,
  });
  const closing = reads.close();
  await lease.rollback();
  await closing;
  assert.equal(pool.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(pool.releases.at(-1), false);
});
test("a finished lease cannot query a released pool connection", async () => {
  const pool = new FakePool();
  const reads = provider([pool]);
  const lease = await reads.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 5000,
  });
  await lease.commit();
  assert.throws(() => lease.tx.query("BUSINESS"), FreshnessUnavailable);
  await lease.rollback();
  assert.equal(pool.releases.length, 1);
  assert.equal(
    pool.queries.some((q) => q.sql === "BUSINESS"),
    false,
  );
  await reads.close();
});
test("a lagging snapshot ends before business SQL and fresh primary snapshot checks identical identity", async () => {
  const replica = new FakePool();
  replica.watermark!.sequence = "9007199254740992";
  const primary = new FakePool();
  const reads = provider([replica], { primaryPool: primary });
  let runs = 0;
  await reads.withTenant(
    TENANT,
    async (tx) => {
      runs++;
      await tx.query("BUSINESS");
    },
    minimum,
  );
  assert.equal(runs, 1);
  assert.equal(
    replica.queries.some((q) => q.sql === "BUSINESS"),
    false,
  );
  assert.equal(replica.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(
    primary.queries[0].sql,
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  assert.equal(primary.queries[1].values[0], TENANT);
  assert.ok(
    primary.queries.findIndex((q) => q.sql.includes("projection_watermarks")) <
      primary.queries.findIndex((q) => q.sql === "BUSINESS"),
  );
  assert.equal(primary.queries.at(-1)?.sql, "COMMIT");
  await reads.close();
});
test("missing watermark, different incarnation, epoch or insufficient sequence never downgrades consistency", async () => {
  for (const watermark of [
    null,
    {
      shard_incarnation: "old",
      placement_epoch: "4",
      sequence: minimum.sequence,
    },
    {
      shard_incarnation: minimum.shardIncarnation,
      placement_epoch: "3",
      sequence: minimum.sequence,
    },
    {
      shard_incarnation: minimum.shardIncarnation,
      placement_epoch: "4",
      sequence: "0",
    },
  ]) {
    const replica = new FakePool();
    replica.watermark = watermark;
    const primary = new FakePool();
    primary.watermark = watermark;
    const reads = provider([replica], { primaryPool: primary });
    let runs = 0;
    await assert.rejects(
      reads.withTenant(
        TENANT,
        async () => {
          runs++;
        },
        minimum,
      ),
      FreshnessUnavailable,
    );
    assert.equal(runs, 0);
    assert.equal(primary.connections, 1);
    await reads.close();
  }
});
test("business query failure rolls back on its selected endpoint and is never replayed", async () => {
  const first = new FakePool();
  first.businessError = true;
  const other = new FakePool();
  const primary = new FakePool();
  const reads = provider([first, other], { primaryPool: primary });
  await assert.rejects(
    reads.withTenant(TENANT, (tx) => tx.query("BUSINESS")),
    /business failed/,
  );
  assert.equal(first.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(other.connections, 0);
  assert.equal(primary.connections, 0);
  await reads.close();
});
test("a commit failure discards its connection and never replays business SQL", async () => {
  const replica = new FakePool();
  const primary = new FakePool();
  replica.onQuery = (sql) => {
    if (sql === "COMMIT") throw new Error("commit connection lost");
  };
  const reads = provider([replica], { primaryPool: primary });
  await assert.rejects(
    reads.withTenant(TENANT, (tx) => tx.query("BUSINESS")),
    /commit connection lost/,
  );
  assert.equal(replica.releases.length, 1);
  assert.equal(replica.releases[0], true);
  assert.equal(primary.connections, 0);
  await reads.close();
});
test("a business statement after the original deadline is rejected without replay", async () => {
  let time = 1000;
  const replica = new FakePool();
  const primary = new FakePool();
  const reads = provider([replica], { now: () => time, primaryPool: primary });
  await assert.rejects(
    reads.withTenant(
      TENANT,
      async (tx) => {
        time = 2000;
        await tx.query("BUSINESS");
      },
      undefined,
      1500,
    ),
    FreshnessUnavailable,
  );
  assert.equal(
    replica.queries.some((q) => q.sql === "BUSINESS"),
    false,
  );
  assert.equal(primary.connections, 0);
  assert.equal(replica.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(replica.releases.at(-1), false);
  await reads.close();
});
test("tenant filters and transaction context match even when minimum consistency uses a replica", async () => {
  const replica = new FakePool();
  const reads = provider([replica]);
  const backend = postgresReads(reads, {
    minimumSequence: async (tenant) => {
      assert.equal(tenant, TENANT);
      return minimum;
    },
  });
  const data = await backend.latest(TENANT, "device-1");
  assert.equal(data?.tenant_id, TENANT);
  assert.equal(
    replica.queries.find((q) => q.sql.includes("projection_watermarks"))
      ?.values[0],
    TENANT,
  );
  assert.equal(
    replica.queries.find((q) => q.sql.includes("latest_readings"))?.values[0],
    TENANT,
  );
  replica.onQuery = (sql, values) => {
    if (sql.includes("latest_readings")) assert.equal(values[0], OTHER);
  };
  await postgresReads(reads).latest(OTHER, "device-1");
  await assert.rejects(
    reads.acquire({ tenantId: "invalid", deadline: Date.now() + 5000 }),
    /tenant/,
  );
  await reads.close();
});
test("connection configuration rejects unsafe roles, TLS, duplicates and conflicting inputs", () => {
  assert.equal(
    createReadReplicas(undefined, undefined, url("primary")),
    undefined,
  );
  for (const raw of [
    JSON.stringify([]),
    JSON.stringify([1]),
    JSON.stringify([url("r"), url("r")]),
    JSON.stringify([url("r").replace("read_query", "postgres")]),
    JSON.stringify([url("r").replace("verify-full", "disable")]),
  ])
    assert.throws(() => createReadReplicas(raw, undefined, url("primary")));
  assert.throws(
    () => createReadReplicas(JSON.stringify([url("r")]), "r", url("primary")),
    /not both/,
  );
  assert.throws(
    () => createReadReplicas(undefined, "r/unsafe", url("primary")),
    /host/,
  );
});
test("configuration parse errors never disclose credential-bearing input", () => {
  const secret = "sensitive-password-do-not-log";
  for (const [raw, hosts, primary] of [
    [`[postgres://read_query:${secret}@r]`, undefined, url("primary")],
    [JSON.stringify([`not-a-url:${secret}%%`]), undefined, url("primary")],
    [undefined, "r", `invalid-${secret}`],
  ]) {
    assert.throws(
      () => createReadReplicas(raw, hosts, primary!),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        assert.equal("input" in error, false);
        return true;
      },
    );
  }
});

test("replica-backed PostgreSQL bypasses cache hit and fill even after invalidation", async () => {
  const replica = new FakePool();
  const reads = provider([replica]);
  const postgres = postgresReads(reads);
  let redisCommands = 0;
  const redis = {
    async get() {
      redisCommands++;
      return null;
    },
    async set() {
      redisCommands++;
      return "OK";
    },
    async eval() {
      redisCommands++;
      return "OK";
    },
  };
  const cached = cacheBackends(
    {
      ...postgres,
      history: { list: async () => [] },
      search: { search: async () => [] },
    },
    redis,
  );
  await cached.cache.invalidateDevice(TENANT, "device-1");
  assert.equal(redisCommands, 1);
  const safe = withoutPostgresCache(cached, postgres);
  const result = await safe.latest(TENANT, "device-1");
  assert.equal((result as { stream_version: string }).stream_version, "7");
  assert.equal(
    redisCommands,
    1,
    "a stale eventual replica result must not refill the invalidated cache key",
  );
  assert.equal(cached.cache.metrics.snapshot().fill, 0);
  assert.equal(safe.history, cached.history);
  assert.equal(safe.search, cached.search);
  await reads.close();
});

test("disconnect interrupts a pending watermark admission query without failing the replica", async () => {
  const pool = new FakePool();
  const controller = new AbortController();
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  pool.onQuery = async (sql) => {
    if (sql.includes("FROM read.projection_watermarks")) {
      notify();
      await new Promise<void>(() => {});
    }
  };
  const reads = provider([pool]);
  const work = reads.acquire({
    tenantId: TENANT,
    minimumSequence: minimum,
    deadline: Date.now() + 1000,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(work, FreshnessUnavailable);
  assert.deepEqual(pool.releases, [true]);
  pool.onQuery = undefined;
  assert.equal((await reads.health())[0].healthy, true);
  await reads.close();
});

test("business SQL uses remaining request budget while admission retains its shorter cap", async () => {
  const pool = new FakePool();
  let now = 1000;
  const reads = provider([pool], { now: () => now, attemptTimeoutMs: 1000 });
  const lease = await reads.acquire({ tenantId: TENANT, deadline: 5000 });
  assert.ok(pool.queryTimeouts.every((value) => value <= 1000));
  assert.equal(
    pool.queries.find((q) => q.sql.includes("statement_timeout"))?.values[0],
    "4000",
  );
  now = 1500;
  await lease.tx.query("BUSINESS");
  assert.equal(pool.queryTimeouts.at(-1), 3500);
  await lease.commit();
  await reads.close();
});

test("expired snapshots cannot commit even when callers suppress a query failure", async () => {
  const pool = new FakePool();
  let now = 1000;
  const reads = provider([pool], { now: () => now });
  const lease = await reads.acquire({ tenantId: TENANT, deadline: 5000 });
  now = 5000;
  await assert.rejects(lease.commit(), FreshnessUnavailable);
  assert.deepEqual(pool.releases, [true]);
  assert.equal(
    pool.queries.some((query) => query.sql === "COMMIT"),
    false,
  );
  await lease.rollback();
  assert.deepEqual(pool.releases, [true]);
  await reads.close();
});

test("finished lease commit after expiry cannot discard a reused client", async () => {
  const pool = new FakePool();
  const reused = await pool.connect();
  pool.connect = async () => reused;
  let now = 1000;
  const reads = provider([pool], { now: () => now });
  const previous = await reads.acquire({ tenantId: TENANT, deadline: 2000 });
  await previous.commit();
  assert.deepEqual(pool.releases, [false]);
  now = 1500;
  const current = await reads.acquire({ tenantId: OTHER, deadline: 5000 });
  now = 2500;
  const queriesBefore = pool.queries.length;
  await previous.commit();
  await previous.rollback();
  assert.equal(pool.queries.length, queriesBefore);
  assert.deepEqual(pool.releases, [false]);
  await current.tx.query("BUSINESS");
  await current.commit();
  assert.deepEqual(pool.releases, [false, false]);
  await reads.close();
});

test("exhausted local checkout capacity reports busy without quarantining the endpoint", async () => {
  const pool = new FakePool();
  pool.connect = async () => {
    throw new Error("timeout exceeded when trying to connect");
  };
  const reads = provider([pool]);
  await assert.rejects(
    reads.acquire({ tenantId: TENANT, deadline: Date.now() + 1000 }),
    ReadPoolBusy,
  );
  assert.deepEqual(pool.queries, []);
  assert.equal((await reads.health())[0].healthy, true);
  pool.connect = FakePool.prototype.connect.bind(pool);
  const next = await reads.acquire({
    tenantId: TENANT,
    deadline: Date.now() + 1000,
  });
  await next.commit();
  await reads.close();
});

test("mixed checkout saturation and endpoint failure is freshness unavailable rather than busy", async () => {
  for (const reverse of [false, true]) {
    const busy = new FakePool(),
      failed = new FakePool();
    busy.connect = async () => {
      throw new Error("timeout exceeded when trying to connect");
    };
    failed.unavailable = true;
    const reads = provider(reverse ? [failed, busy] : [busy, failed]);
    await assert.rejects(
      reads.acquire({ tenantId: TENANT, deadline: Date.now() + 1000 }),
      (error) =>
        error instanceof FreshnessUnavailable &&
        !(error instanceof ReadPoolBusy),
    );
    const health = await reads.health();
    assert.equal(health[reverse ? 1 : 0].healthy, true);
    assert.equal(health[reverse ? 0 : 1].healthy, false);
    await reads.close();
  }
});
