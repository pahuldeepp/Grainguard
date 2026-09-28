import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  ALERTS_MOVE_TABLE_INVENTORY,
  assertAlertsMovePreflight,
} from "./alerts-owner.js";

const tenant = "33333333-3333-4333-8333-333333333333";

class FakePool {
  calls: { sql: string; values?: unknown[] }[] = [];
  tables = ALERTS_MOVE_TABLE_INVENTORY.map((table_name) => ({
    table_name,
    relkind: "r",
    is_partition: false,
  }));
  outboxRows = "0";

  async query(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    if (sql.includes("FROM pg_class")) return { rows: this.tables };
    return { rows: [{ cdcOutboxRows: this.outboxRows }] };
  }
}

test("alerts preflight accepts only the exact nonpartitioned owner inventory", async () => {
  const valid = new FakePool();
  await assertAlertsMovePreflight(valid as unknown as Pool, tenant);
  assert.match(valid.calls[0]!.sql, /attname='tenant_id'/);
  assert.deepEqual(valid.calls[1]!.values, [tenant]);

  const missing = new FakePool();
  missing.tables.pop();
  await assert.rejects(
    assertAlertsMovePreflight(missing as unknown as Pool, tenant),
    /schema differs/,
  );

  const partitioned = new FakePool();
  partitioned.tables[0]!.is_partition = true;
  await assert.rejects(
    assertAlertsMovePreflight(partitioned as unknown as Pool, tenant),
    /schema differs/,
  );
});

test("alerts preflight refuses historical CDC outbox because effect ownership is uncoordinated", async () => {
  const pool = new FakePool();
  pool.outboxRows = "2";
  await assert.rejects(
    assertAlertsMovePreflight(pool as unknown as Pool, tenant),
    /2 CDC outbox row\(s\).*Jobs\/Notifications cutover/,
  );
});

test("alerts preflight rejects malformed tenant identifiers before querying", async () => {
  const pool = new FakePool();
  await assert.rejects(
    assertAlertsMovePreflight(pool as unknown as Pool, "not-a-uuid"),
    /invalid alerts move tenant id/,
  );
  assert.equal(pool.calls.length, 0);
});
