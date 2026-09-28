import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  recordPostgresQueryDuration,
  registerPostgresPool,
  renderPostgresPoolMetrics,
} from "./postgres-metrics.js";

test("exports bounded local pool saturation gauges", () => {
  const pool = new pg.Pool({ max: 7 });
  Object.defineProperties(pool, {
    totalCount: { configurable: true, value: 4 },
    idleCount: { configurable: true, value: 2 },
    waitingCount: { configurable: true, value: 3 },
  });
  const unregister = registerPostgresPool(pool, "device_service");
  try {
    const output = renderPostgresPoolMetrics();
    assert.match(output, /postgres_pool_size\{pool="device_service"\} 7/);
    assert.match(
      output,
      /postgres_pool_total_connections\{pool="device_service"\} 4/,
    );
    assert.match(
      output,
      /postgres_pool_idle_connections\{pool="device_service"\} 2/,
    );
    assert.match(
      output,
      /postgres_pool_waiting_requests\{pool="device_service"\} 3/,
    );
    assert.doesNotMatch(
      output,
      /\{[^}]*tenant_id|\{[^}]*device_id|\{[^}]*request_id/i,
    );
  } finally {
    unregister();
    void pool.end();
  }
});

test("rejects dynamic pool labels", () => {
  const pool = new pg.Pool();
  assert.throws(() => registerPostgresPool(pool, "tenant_123"));
  void pool.end();
});

test("records query latency and the slow threshold without query labels", () => {
  recordPostgresQueryDuration(650);
  const output = renderPostgresPoolMetrics();
  assert.match(output, /postgres_queries_total 1/);
  assert.match(output, /postgres_slow_queries_total 1/);
  assert.match(output, /postgres_query_duration_seconds_count 1/);
  assert.match(output, /postgres_query_duration_seconds_bucket\{le="1"\} 1/);
  assert.doesNotMatch(output, /query="|sql=|params=/i);
});

test("aggregates every shard pool and unregisters members independently", async () => {
  const first = new pg.Pool({ max: 3 });
  const second = new pg.Pool({ max: 5 });
  Object.defineProperties(first, {
    totalCount: { value: 2 },
    idleCount: { value: 1 },
    waitingCount: { value: 2 },
  });
  Object.defineProperties(second, {
    totalCount: { value: 4 },
    idleCount: { value: 2 },
    waitingCount: { value: 3 },
  });
  const removeFirst = registerPostgresPool(first, "workflow_alerts");
  const removeSecond = registerPostgresPool(second, "workflow_alerts");
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_size\{pool="workflow_alerts"\} 8/,
  );
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_total_connections\{pool="workflow_alerts"\} 6/,
  );
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_idle_connections\{pool="workflow_alerts"\} 3/,
  );
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_waiting_requests\{pool="workflow_alerts"\} 5/,
  );
  removeFirst();
  removeFirst();
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_size\{pool="workflow_alerts"\} 5/,
  );
  removeSecond();
  assert.doesNotMatch(renderPostgresPoolMetrics(), /pool="workflow_alerts"/);
  const replacement = new pg.Pool({ max: 7 });
  const removeReplacement = registerPostgresPool(
    replacement,
    "workflow_alerts",
  );
  removeSecond();
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_size\{pool="workflow_alerts"\} 7/,
  );
  removeReplacement();
  await Promise.all([first.end(), second.end(), replacement.end()]);
});

test("pool end removes its metrics registration", async () => {
  const pool = new pg.Pool({ max: 4 });
  registerPostgresPool(pool, "notification_service");
  assert.match(renderPostgresPoolMetrics(), /pool="notification_service"/);
  await pool.end();
  assert.doesNotMatch(
    renderPostgresPoolMetrics(),
    /pool="notification_service"/,
  );
});

test("callback pool shutdown also unregisters its metrics", async () => {
  const pool = new pg.Pool({ max: 2 });
  registerPostgresPool(pool, "notification_service");
  await new Promise<void>((resolve) => pool.end(resolve));
  assert.doesNotMatch(
    renderPostgresPoolMetrics(),
    /pool="notification_service"/,
  );
});

test("repeated registration retains a pool until the last handle unregisters", async () => {
  const pool = new pg.Pool({ max: 6 });
  const first = registerPostgresPool(pool, "workflow_alerts");
  const second = registerPostgresPool(pool, "workflow_alerts");
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_size\{pool="workflow_alerts"\} 6/,
  );
  first();
  first();
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_size\{pool="workflow_alerts"\} 6/,
  );
  second();
  assert.doesNotMatch(renderPostgresPoolMetrics(), /pool="workflow_alerts"/);
  await pool.end();
});

test("failed pool shutdown preserves saturation gauges and the error", async () => {
  const pool = new pg.Pool({ max: 9 });
  const actualEnd = pool.end.bind(pool);
  const error = new Error("shutdown failed");
  pool.end = (() => Promise.reject(error)) as pg.Pool["end"];
  const unregister = registerPostgresPool(pool, "notification_service");
  await assert.rejects(pool.end(), error);
  assert.match(
    renderPostgresPoolMetrics(),
    /postgres_pool_size\{pool="notification_service"\} 9/,
  );
  unregister();
  await actualEnd();
});
