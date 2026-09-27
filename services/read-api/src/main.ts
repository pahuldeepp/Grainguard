import pg from "pg";
import cassandra from "cassandra-driver";
import { readFileSync } from "node:fs";
import { startMembershipRuntime } from "@greenguard/membership-client";
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

for (const key of [
  "READ_QUERY_DATABASE_URL",
  "CASSANDRA_HOSTS",
  "ELASTICSEARCH_URL",
]) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}
const pool = new pg.Pool({
  connectionString: process.env.READ_QUERY_DATABASE_URL!,
  max: 10,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
});
const contactPoints = process.env
  .CASSANDRA_HOSTS!.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const client = new cassandra.Client({
  contactPoints,
  localDataCenter: process.env.CASSANDRA_DATACENTER ?? "datacenter1",
  keyspace: process.env.CASSANDRA_KEYSPACE ?? "greenguard_history",
  ...(process.env.CASSANDRA_USERNAME && {
    authProvider: new cassandra.auth.PlainTextAuthProvider(
      process.env.CASSANDRA_USERNAME,
      process.env.CASSANDRA_PASSWORD ?? "",
    ),
  }),
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
const backends = {
  ...postgresReads(pool),
  history,
  search: new ElasticSearch(
    process.env.ELASTICSEARCH_URL!,
    process.env.SEARCH_ALIAS,
  ),
};
const protectedBackends = bulkheadBackends(backends, {
  historyGlobal: Number(process.env.READ_HISTORY_CONCURRENCY ?? 32),
  historyPerTenant: Number(process.env.READ_HISTORY_TENANT_CONCURRENCY ?? 4),
  searchGlobal: Number(process.env.READ_SEARCH_CONCURRENCY ?? 64),
  searchPerTenant: Number(process.env.READ_SEARCH_TENANT_CONCURRENCY ?? 8),
});
const cached = redis ? cacheBackends(protectedBackends, redis) : null;
let stopping = false;
const app = createApp({
  verify,
  backends: cached ?? protectedBackends,
  entitlements: postgresHistoryEntitlements(pool, (tenantId) =>
    console.error("read-api entitlement missing or stale", tenantId),
  ),
  ready: async () => {
    if (stopping) return false;
    cassandraReady.ensureConnected();
    if (!cassandraReady.connected()) return false;
    // The pool's configured query_timeout and connectionTimeoutMillis bound this probe.
    await pool.query("SELECT 1");
    return !stopping;
  },
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
        pool.end(),
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
