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
