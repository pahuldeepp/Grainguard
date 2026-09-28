import pg from "pg";
import { readContext, assertReadActive } from "./consistency.js";
import { parseWatermark } from "@greenguard/membership-client";
import {
  ReadAdmissionMetrics,
  instrumentReadAuthority,
} from "./read-metrics.js";
import cassandra from "cassandra-driver";
import { readFileSync } from "node:fs";
import {
  startMembershipRuntime,
  httpReadLeaseAuthority,
} from "@greenguard/membership-client";
import {
  createMachineControlPlaneVerifier,
  machineAwareVerifier,
} from "@greenguard/tenant-auth/machine-control-plane";
import { CassandraHistory, ElasticSearch, postgresReads } from "./backends.js";
import { createApp } from "./app.js";
import { postgresHistoryEntitlements } from "./entitlements/postgres.js";
import { cacheBackends } from "./cache.js";
import { createReadRedis } from "./redis.js";
import { connectRedisBounded, redisStartupWaitMs } from "./redis-startup.js";
import { bulkheadBackends } from "./bulkhead.js";
import { createCassandraReadiness } from "./cassandra-readiness.js";
import { cassandraSecurity } from "./cassandra-security.js";
import { createReadReplicas } from "./replicas.js";
import {
  contextualReplicaProvider,
  createShardReadRegistry,
} from "./shards.js";
import { watermarkCacheBackends } from "./watermark-cache.js";
import { postgresCachePolicy } from "./cache-policy.js";

for (const key of ["CASSANDRA_HOSTS", "ELASTICSEARCH_URL"]) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}
if (
  process.env.READ_SHARD_DATABASE_URLS &&
  process.env.READ_SHARD_REGISTRY_FILE
)
  throw new Error("choose one read shard registry source");
const shardConfig = process.env.READ_SHARD_REGISTRY_FILE
  ? readFileSync(process.env.READ_SHARD_REGISTRY_FILE, "utf8")
  : process.env.READ_SHARD_DATABASE_URLS;
if (!shardConfig && !process.env.READ_QUERY_DATABASE_URL)
  throw new Error("read database configuration is required");
if (
  shardConfig &&
  (process.env.READ_REPLICA_DATABASE_URLS || process.env.READ_REPLICA_HOSTS)
)
  throw new Error("shard registry cannot be combined with legacy replicas");
const shards = shardConfig
  ? createShardReadRegistry(shardConfig, {
      allowLoopback: process.env.READ_SHARD_LOCAL_LOOPBACK === "true",
      poolMax: Number(process.env.READ_SHARD_POOL_MAX ?? 5),
    })
  : undefined;
const pool = shards
  ? undefined
  : new pg.Pool({
      connectionString: process.env.READ_QUERY_DATABASE_URL!,
      max: 10,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
const replicas = pool
  ? createReadReplicas(
      process.env.READ_REPLICA_DATABASE_URLS,
      process.env.READ_REPLICA_HOSTS,
      process.env.READ_QUERY_DATABASE_URL!,
      {
        primaryPool: pool,
        allowPrimaryOnly: true,
        requireWatermark: process.env.READ_WATERMARK_ENABLED === "true",
      },
    )
  : undefined;
if (
  shards &&
  (!process.env.CONTROL_PLANE_URL || !process.env.CONTROL_LOOKUP_TOKEN)
)
  throw new Error("sharded reads require placement authority configuration");
const readAdmissionMetrics = new ReadAdmissionMetrics();
const readAuthority = shards
  ? instrumentReadAuthority(
      httpReadLeaseAuthority({
        baseUrl: process.env.CONTROL_PLANE_URL!,
        token: process.env.CONTROL_LOOKUP_TOKEN!,
        meshMtls: process.env.CONTROL_PLANE_MESH_MTLS === "true",
      }),
      readAdmissionMetrics,
    )
  : undefined;
const contactPoints = process.env
  .CASSANDRA_HOSTS!.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const client = new cassandra.Client({
  contactPoints,
  localDataCenter: process.env.CASSANDRA_DATACENTER ?? "datacenter1",
  keyspace: process.env.CASSANDRA_KEYSPACE ?? "greenguard_history",
  ...cassandraSecurity(process.env),
});
const history = new CassandraHistory(client);
const cassandraReady = createCassandraReadiness(client, (error) =>
  console.error("read-api Cassandra connect failed", error),
);
// Cassandra can be unavailable at boot; readiness stays false and retries.
cassandraReady.ensureConnected();

const redis = createReadRedis(process.env);
if (redis) {
  redis.client.on("error", (error) =>
    console.error("read-api Redis error", error.message),
  );
  // Bound optional Redis startup; connection continues while reads use owning stores.
  await connectRedisBounded(
    redis,
    redisStartupWaitMs(process.env.READ_REDIS_STARTUP_WAIT_MS),
    (error) => console.error("read-api Redis connect failed", error),
  );
}
const verifier = await startMembershipRuntime(
  (key) => process.env[key],
  (path) => readFileSync(path, "utf8"),
  "read-api",
);
const machine =
  process.env.CONTROL_PLANE_URL && process.env.CONTROL_LOOKUP_TOKEN
    ? createMachineControlPlaneVerifier({
        endpoint: process.env.CONTROL_PLANE_URL,
        lookupToken: process.env.CONTROL_LOOKUP_TOKEN,
      })
    : undefined;
const verify = machineAwareVerifier(verifier.verify, machine, "read:telemetry");
const readSnapshots = contextualReplicaProvider(shards ?? replicas!);
const postgresBackends = postgresReads(readSnapshots);
const guardedPostgres =
  shards && redis && readAuthority
    ? watermarkCacheBackends(postgresBackends, redis, {
        authority: readAuthority,
        primaryWatermark: async (tenantId) => {
          const context = readContext.getStore();
          assertReadActive(context);
          const snapshot = await readSnapshots.acquire({
            tenantId,
            primaryOnly: true,
            certify: false,
            deadline: context!.deadline,
            signal: context!.signal,
          });
          try {
            if (!snapshot.watermark)
              throw new Error("primary_watermark_unavailable");
            const watermark = parseWatermark(
              JSON.stringify({ v: 1, tenantId, ...snapshot.watermark }),
              tenantId,
            );
            await snapshot.commit();
            return watermark;
          } catch (error) {
            await snapshot.rollback().catch(() => {});
            throw error;
          }
        },
      })
    : postgresBackends;
const backends = {
  ...guardedPostgres,
  history,
  search: new ElasticSearch(
    process.env.ELASTICSEARCH_URL!,
    process.env.SEARCH_ALIAS,
    process.env.OPENSEARCH_USERNAME ||
      process.env.OPENSEARCH_PASSWORD ||
      process.env.OPENSEARCH_CA_FILE
      ? {
          username: process.env.OPENSEARCH_USERNAME ?? "",
          password: process.env.OPENSEARCH_PASSWORD ?? "",
          caFile: process.env.OPENSEARCH_CA_FILE ?? "",
        }
      : undefined,
  ),
};
const protectedBackends = bulkheadBackends(backends, {
  historyGlobal: Number(process.env.READ_HISTORY_CONCURRENCY ?? 32),
  historyPerTenant: Number(process.env.READ_HISTORY_TENANT_CONCURRENCY ?? 4),
  searchGlobal: Number(process.env.READ_SEARCH_CONCURRENCY ?? 64),
  searchPerTenant: Number(process.env.READ_SEARCH_TENANT_CONCURRENCY ?? 8),
});
const cached = redis ? cacheBackends(protectedBackends, redis) : null;
// Unleased legacy replica results bypass Redis. Sharded results use a separate
// placement/watermark guard; shared-store caches retain their own eventual policy.
const effectiveBackends = cached
  ? postgresCachePolicy(
      cached,
      Object.fromEntries(
        Object.keys(postgresBackends).map((name) => [
          name,
          protectedBackends[name as keyof typeof protectedBackends],
        ]),
      ) as typeof postgresBackends,
      Boolean(
        shards ||
        process.env.READ_REPLICA_DATABASE_URLS ||
        process.env.READ_REPLICA_HOSTS ||
        process.env.READ_WATERMARK_ENABLED === "true",
      ),
    )
  : protectedBackends;
let stopping = false;
const app = createApp({
  verify,
  backends: effectiveBackends,
  readAuthority,
  entitlements: postgresHistoryEntitlements(
    shards ? (tenantId) => shards.primary(tenantId) : pool!,
    (tenantId) =>
      console.error("read-api entitlement missing or stale", tenantId),
    readSnapshots,
  ),
  ready: async () => {
    if (stopping) return false;
    cassandraReady.ensureConnected();
    if (!cassandraReady.connected()) return false;
    // The pool's configured query_timeout and connectionTimeoutMillis bound this probe.
    await (shards ?? replicas)?.ready();
    return !stopping;
  },
});
app.get("/metrics/read", (_req, res) => {
  res.type("text/plain").send(readAdmissionMetrics.prometheus());
});
app.get("/metrics/cache", (_req, res) => {
  res.type("text/plain").send(cached?.cache.metrics.prometheus() ?? "");
});
const server = app.listen(
  Number(process.env.READ_API_PORT ?? "4001"),
  process.env.READ_API_HOST ?? "127.0.0.1",
);
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  const parsedDrain = Number(process.env.READ_API_DRAIN_MS ?? 1000);
  const drainMs = Number.isFinite(parsedDrain)
    ? Math.max(0, Math.min(10_000, parsedDrain))
    : 1000;
  const deadline = setTimeout(() => process.exit(1), drainMs + 10_000);
  deadline.unref();
  setTimeout(() => {
    server.close(async (serverError) => {
      const results = await Promise.allSettled([
        pool?.end(),
        replicas?.close(),
        shards?.close(),
        history.close(),
        redis?.close(),
        verifier.close(),
      ]);
      if (serverError)
        console.error("read-api server shutdown failed", serverError);
      for (const result of results)
        if (result.status === "rejected")
          console.error("read-api shutdown failed", result.reason);
      process.exitCode =
        serverError || results.some((result) => result.status === "rejected")
          ? 1
          : 0;
      clearTimeout(deadline);
    });
  }, drainMs).unref();
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, shutdown);
