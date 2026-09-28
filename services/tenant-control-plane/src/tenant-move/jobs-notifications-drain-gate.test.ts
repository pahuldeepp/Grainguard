import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  inspectJobsMoveDrain,
  inspectNotificationsMoveDrain,
} from "./jobs-notifications-drain-gate.js";

const tenant = "33333333-3333-4333-8333-333333333333";
const source = {
  shardId: "s1",
  incarnation: "11111111-1111-4111-8111-111111111111",
  epoch: "5",
};
const jobsTables = [
  "dead_letter_outbox",
  "dispatch_outbox",
  "inbox",
  "intent_redrives",
  "notification_intents",
];
const notificationTables = [
  "deliveries",
  "delivery_attempts",
  "notification_preferences",
];

class FakePool {
  calls: string[] = [];
  tables = [] as { table_name: string; relkind: string; is_partition: boolean }[];
  ownership = {
    shard_id: source.shardId,
    incarnation: source.incarnation,
    epoch: source.epoch,
    state: "fenced",
  };
  counts: Record<string, string | number> = {};

  async query(sql: string) {
    this.calls.push(sql);
    if (sql.includes("FROM pg_class")) return { rows: this.tables };
    if (sql.includes("FROM greenguard_internal.tenant_ownership"))
      return { rows: [this.ownership] };
    return { rows: [this.counts] };
  }
}

function pool(
  tables: string[],
  counts: Record<string, string | number>,
): FakePool {
  const result = new FakePool();
  result.tables = tables.map((table_name) => ({
    table_name,
    relkind: "r",
    is_partition: false,
  }));
  result.counts = counts;
  return result;
}

test("jobs drain gate accepts only fenced, schema-pinned, empty outboxes", async () => {
  const db = pool(jobsTables, {
    live_rows: "0",
    pending_dispatch: "0",
    pending_dead_letter: "0",
  });
  const proof = await inspectJobsMoveDrain(db as unknown as Pool, tenant, source);
  assert.equal(proof.owner, "jobs");
  assert.equal(proof.liveRows, 0);
  assert.equal(db.calls.length, 3);
  assert.match(db.calls[2]!, /dispatched_at IS NULL/);
  assert.match(db.calls[2]!, /published_at IS NULL/);
});

test("jobs drain gate blocks queued intents and unconfirmed DLQ publication", async () => {
  const db = pool(jobsTables, {
    live_rows: "1",
    pending_dispatch: "1",
    pending_dead_letter: "1",
  });
  await assert.rejects(
    inspectJobsMoveDrain(db as unknown as Pool, tenant, source),
    /jobs tenant work is not drained: live=1, pendingDispatch=1, pendingDeadLetter=1/,
  );
});

test("jobs drain gate rejects source placements which are not exactly fenced", async () => {
  const db = pool(jobsTables, {
    live_rows: 0,
    pending_dispatch: 0,
    pending_dead_letter: 0,
  });
  db.ownership.state = "active";
  await assert.rejects(
    inspectJobsMoveDrain(db as unknown as Pool, tenant, source),
    /requires the exact source placement to be durably fenced/,
  );
  assert.equal(db.calls.length, 2);
});

test("notification drain gate blocks provider uncertainty, retry, and dead states", async () => {
  const db = pool(notificationTables, { live_rows: "2" });
  await assert.rejects(
    inspectNotificationsMoveDrain(db as unknown as Pool, tenant, source),
    /notifications tenant work is not drained: live=2/,
  );
  assert.match(db.calls[2]!, /status NOT IN \('sent','failed','suppressed'\)/);
});

test("notification drain gate accepts terminal delivery history after fence", async () => {
  const db = pool(notificationTables, { live_rows: 0 });
  const proof = await inspectNotificationsMoveDrain(
    db as unknown as Pool,
    tenant,
    source,
  );
  assert.equal(proof.owner, "notifications");
  assert.equal(proof.liveRows, 0);
});

test("both gates refuse unknown tenant-owned schema or partition drift", async () => {
  const db = pool([...jobsTables, "future_owner_table"], {
    live_rows: 0,
    pending_dispatch: 0,
    pending_dead_letter: 0,
  });
  await assert.rejects(
    inspectJobsMoveDrain(db as unknown as Pool, tenant, source),
    /schema differs from the reviewed table inventory/,
  );
  assert.equal(db.calls.length, 1);
});
