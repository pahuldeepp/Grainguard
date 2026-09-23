import { mock, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { DatabaseProbe } from "./app.js";
test("ping runs a trivial query and shutdown ends the pool", async () => {
  const query = mock.method(pg.Pool.prototype, "query", async () => ({}));
  const end = mock.method(pg.Pool.prototype, "end", async () => undefined);
  try {
    const probe = new DatabaseProbe("postgres://u:p@127.0.0.1:1/db");
    await probe.ping();
    assert.deepEqual(query.mock.calls[0].arguments, ["SELECT 1"]);
    await probe.onModuleDestroy();
    assert.equal(end.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
  }
});
test("ping rejects when the database is unreachable", async () => {
  const probe = new DatabaseProbe("postgres://u:p@127.0.0.1:1/db");
  try {
    await assert.rejects(probe.ping());
  } finally {
    await probe.onModuleDestroy();
  }
});
test("idle connection errors are logged without leaking details", async () => {
  const errors: unknown[][] = [];
  const log = mock.method(console, "error", (...args: unknown[]) => {
    errors.push(args);
  });
  const probe = new DatabaseProbe("postgres://u:secret@127.0.0.1:1/db");
  try {
    (probe as unknown as { pool: pg.Pool }).pool.emit(
      "error",
      new Error("postgres://u:secret@host"),
    );
  } finally {
    log.mock.restore();
    await probe.onModuleDestroy();
  }
  assert.deepEqual(errors, [
    ["device-service: idle database connection failed"],
  ]);
});
