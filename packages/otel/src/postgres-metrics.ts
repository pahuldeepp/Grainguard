import type pg from "pg";

const pools = new Map<string, Set<pg.Pool>>();
const closeCallbacks = new WeakMap<pg.Pool, Set<() => void>>();
const registrations = new WeakMap<pg.Pool, Map<string, number>>();
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
  const members = pools.get(poolName) ?? new Set<pg.Pool>();
  members.add(pool);
  pools.set(poolName, members);
  const counts = registrations.get(pool) ?? new Map<string, number>();
  counts.set(poolName, (counts.get(poolName) ?? 0) + 1);
  registrations.set(pool, counts);
  let removed = false;
  const unregister = () => {
    if (removed) return;
    removed = true;
    closeCallbacks.get(pool)?.delete(unregister);
    const remaining = (counts.get(poolName) ?? 1) - 1;
    if (remaining > 0) {
      counts.set(poolName, remaining);
      return;
    }
    counts.delete(poolName);
    members.delete(pool);
    if (members.size === 0 && pools.get(poolName) === members)
      pools.delete(poolName);
  };
  let callbacks = closeCallbacks.get(pool);
  if (!callbacks) {
    callbacks = new Set();
    closeCallbacks.set(pool, callbacks);
    const end = pool.end.bind(pool);
    const cleanup = () => {
      callbacks!.forEach((remove) => remove());
      callbacks!.clear();
    };
    // pg.Pool emits no "end" event. Preserve its Promise and callback overloads
    // while removing metrics after either form of pool shutdown completes.
    pool.end = ((callback?: (error?: Error) => void) => {
      if (callback)
        return end((error?: Error) => {
          if (!error) cleanup();
          callback(error);
        });
      return end().then(cleanup);
    }) as pg.Pool["end"];
  }
  callbacks.add(unregister);
  return unregister;
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
  for (const [name, members] of pools) {
    const labels = `pool="${name}"`;
    const values = [...members].reduce(
      (sum, pool) => ({
        max: sum.max + (pool.options.max ?? 10),
        total: sum.total + pool.totalCount,
        idle: sum.idle + pool.idleCount,
        waiting: sum.waiting + pool.waitingCount,
      }),
      { max: 0, total: 0, idle: 0, waiting: 0 },
    );
    lines.push(
      `postgres_pool_size{${labels}} ${values.max}`,
      `postgres_pool_total_connections{${labels}} ${values.total}`,
      `postgres_pool_idle_connections{${labels}} ${values.idle}`,
      `postgres_pool_waiting_requests{${labels}} ${values.waiting}`,
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
