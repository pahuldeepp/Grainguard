import type pg from "pg";

const pools = new Map<string, pg.Pool>();
const allowedPoolNames = new Set([
  "device_service",
  "workflow_alerts",
  "notification_service",
]);
const queryBounds = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];
const queryBuckets = queryBounds.map(() => 0);
let queryCount = 0;
let querySum = 0;
let slowQueries = 0;

/** Record query event duration without retaining SQL or parameter values. */
export function recordPostgresQueryDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const seconds = durationMs / 1000;
  queryCount += 1;
  querySum += seconds;
  if (seconds >= 0.5) slowQueries += 1;
  queryBounds.forEach((bound, index) => {
    if (seconds <= bound) queryBuckets[index] += 1;
  });
}

/** Register a client-side pg pool for bounded saturation metrics. */
export function registerPostgresPool(pool: pg.Pool, poolName: string) {
  if (!allowedPoolNames.has(poolName))
    throw new Error("Postgres metric poolName must be a bounded identifier");
  pools.set(poolName, pool);
  return () => pools.delete(poolName);
}

export function renderPostgresPoolMetrics() {
  const lines = [
    "# HELP postgres_pool_size Configured maximum connections in the local client pool.",
    "# TYPE postgres_pool_size gauge",
    "# HELP postgres_pool_total_connections Current total connections in the local pool.",
    "# TYPE postgres_pool_total_connections gauge",
    "# HELP postgres_pool_idle_connections Current idle connections in the local pool.",
    "# TYPE postgres_pool_idle_connections gauge",
    "# HELP postgres_pool_waiting_requests Requests waiting for a local pool connection.",
    "# TYPE postgres_pool_waiting_requests gauge",
    "# HELP postgres_queries_total Completed PostgreSQL client queries.",
    "# TYPE postgres_queries_total counter",
    `postgres_queries_total ${queryCount}`,
    "# HELP postgres_slow_queries_total PostgreSQL client queries taking at least 500ms.",
    "# TYPE postgres_slow_queries_total counter",
    `postgres_slow_queries_total ${slowQueries}`,
    "# HELP postgres_query_duration_seconds PostgreSQL client query duration; SQL and parameters are not retained.",
    "# TYPE postgres_query_duration_seconds histogram",
  ];
  for (const [name, pool] of pools) {
    const labels = `pool="${name}"`;
    lines.push(
      `postgres_pool_size{${labels}} ${pool.options.max}`,
      `postgres_pool_total_connections{${labels}} ${pool.totalCount}`,
      `postgres_pool_idle_connections{${labels}} ${pool.idleCount}`,
      `postgres_pool_waiting_requests{${labels}} ${pool.waitingCount}`,
    );
  }
  queryBounds.forEach((bound, index) =>
    lines.push(
      `postgres_query_duration_seconds_bucket{le="${bound}"} ${queryBuckets[index]}`,
    ),
  );
  lines.push(
    `postgres_query_duration_seconds_bucket{le="+Inf"} ${queryCount}`,
    `postgres_query_duration_seconds_sum ${querySum}`,
    `postgres_query_duration_seconds_count ${queryCount}`,
  );
  return `${lines.join("\n")}\n`;
}
