import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapWorkerPoolConfig } from "../db/client.js";

test("bootstrap worker selects its group role on every fresh pool connection", async () => {
  const pool = bootstrapWorkerPoolConfig(
    "postgresql://tenant_bootstrap_worker:secret@db.example:5432/greenguard_control?sslmode=verify-full&options=-c%20statement_timeout%3D5000",
  );
  const url = new URL(pool.connectionString!);
  assert.equal(url.username, "tenant_bootstrap_worker");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.match(
    url.searchParams.get("options") ?? "",
    /-c statement_timeout=5000/,
  );
  const statements: string[] = [];
  const onConnect = pool.onConnect as unknown as (client: {
    query(sql: string): Promise<void>;
  }) => Promise<void>;
  await onConnect({
    async query(sql) {
      statements.push(sql);
    },
  });
  assert.deepEqual(statements, ["SET ROLE control_bootstrap_worker_role"]);
});

test("bootstrap worker rejects a caller-selected session role and non-Postgres URL", () => {
  assert.throws(
    () =>
      bootstrapWorkerPoolConfig(
        "postgresql://worker:secret@db.example/greenguard_control?options=-c%20role%3Dcontrol_app",
      ),
    /cannot override its session role/,
  );
  assert.throws(
    () => bootstrapWorkerPoolConfig("https://example.com"),
    /must use PostgreSQL/,
  );
});
