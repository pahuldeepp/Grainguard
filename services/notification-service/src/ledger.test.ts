import { readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import pg from "pg";
import { LocalTestAdapter } from "./adapters.js";
import {
  beginDelivery,
  expireOptionalHold,
  finishDelivery,
  OPTIONAL_HOLD_EXPIRED,
  setPreference,
} from "./ledger.js";
import { MIGRATIONS_DIR, migrate } from "./migrate.js";
import { runMigrate } from "./migrate.js";
import { InvalidTenantError, withTenant } from "./tenant.js";
import { incoming, makeDeps, makeTask } from "./testing/fixtures.js";
import { testPool } from "./testing/fixtures.js";
import { RECEIPT_KEY, RETRY_KEY, DEAD_KEY } from "./topology.js";
import { handleTask } from "./worker.js";

const pool = testPool();
const skip = pool
  ? false
  : "NOTIFICATIONS_DIRECT_URL is not set; run through make";
after(() => pool?.end());

async function delivery(tenant: string, intent: string) {
  return withTenant(pool!, tenant, async (c) => {
    const { rows } = await c.query(
      "SELECT status, attempts, reconciles FROM deliveries WHERE intent_id = $1",
      [intent],
    );
    return rows[0] as
      { status: string; attempts: number; reconciles: number } | undefined;
  });
}

function receipts(published: { key: string; body: Buffer }[]) {
  return published
    .filter((p) => p.key === RECEIPT_KEY)
    .map((p) => JSON.parse(p.body.toString()).outcome as string);
}

test(
  "a redelivered task produces one logical delivery and one terminal result",
  { skip },
  async () => {
    const { deps, broker, adapter } = makeDeps(pool!);
    const task = makeTask();
    assert.equal(await handleTask(deps, incoming(task)), "ack");
    assert.equal(await handleTask(deps, incoming(task)), "ack");
    assert.equal(adapter.sendCalls.length, 1);
    assert.equal(
      (await delivery(task.tenant_id, task.intent_id))?.status,
      "sent",
    );
    assert.deepEqual(receipts(broker.published), ["sent", "sent"]);
  },
);

test("concurrent duplicates never double-send", { skip }, async () => {
  const { deps, adapter } = makeDeps(pool!);
  const task = makeTask();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => handleTask(deps, incoming(task))),
  );
  assert.deepEqual(new Set(results), new Set(["ack"]));
  assert.equal(adapter.delivered.size, 1);
  assert.equal(new Set(adapter.sendCalls).size, 1);
});

test(
  "optional hold expiry records only a hold attempt and preserves terminal state",
  { skip },
  async () => {
    const task = makeTask({ delivery_generation: 1 });
    assert.deepEqual(await expireOptionalHold(pool!, task), {
      action: "failed",
    });
    assert.deepEqual(await expireOptionalHold(pool!, task), {
      action: "receipt",
      outcome: "failed",
      park: true,
    });
    assert.deepEqual(
      await expireOptionalHold(pool!, { ...task, delivery_generation: 0 }),
      {
        action: "stale",
      },
    );
    const row = await withTenant(pool!, task.tenant_id, async (client) => {
      const delivery = await client.query(
        "SELECT status, attempts, last_error FROM deliveries WHERE tenant_id = $1 AND intent_id = $2",
        [task.tenant_id, task.intent_id],
      );
      const attempts = await client.query(
        "SELECT kind, outcome, detail FROM delivery_attempts WHERE tenant_id = $1 AND intent_id = $2 ORDER BY attempt_no",
        [task.tenant_id, task.intent_id],
      );
      return { delivery: delivery.rows[0], attempts: attempts.rows };
    });
    assert.equal(row.delivery.status, "failed");
    assert.equal(row.delivery.attempts, 0);
    assert.equal(row.delivery.last_error, OPTIONAL_HOLD_EXPIRED);
    assert.deepEqual(row.attempts, [
      { kind: "hold", outcome: "failed", detail: OPTIONAL_HOLD_EXPIRED },
    ]);
  },
);

test(
  "optional hold expiry leaves an in-progress provider claim uncertain",
  { skip },
  async () => {
    const task = makeTask();
    assert.deepEqual(await beginDelivery(pool!, task), {
      action: "send",
      attempt: 1,
    });
    assert.deepEqual(await expireOptionalHold(pool!, task), {
      action: "uncertain",
    });
    const row = await delivery(task.tenant_id, task.intent_id);
    assert.equal(row?.status, "in_progress");
    assert.equal(row?.attempts, 1);
  },
);

test(
  "the terminal guard rejects any change to a finished delivery",
  { skip },
  async () => {
    const { deps } = makeDeps(pool!);
    const task = makeTask();
    await handleTask(deps, incoming(task));
    await assert.rejects(
      withTenant(pool!, task.tenant_id, (c) =>
        c.query(
          "UPDATE deliveries SET status = 'failed', terminal_at = now() WHERE intent_id = $1",
          [task.intent_id],
        ),
      ),
      /terminal result/,
    );
    await assert.rejects(
      withTenant(pool!, task.tenant_id, (c) =>
        c.query(
          "INSERT INTO deliveries (tenant_id, intent_id, channel, severity, correlation_id) VALUES ($1, $2, 'sms', 'critical', $3)",
          [task.tenant_id, task.intent_id, task.correlation_id],
        ),
      ),
      /duplicate key/,
    );
    assert.equal(
      await finishDelivery(pool!, task, { status: "failed", kind: "send" }),
      "sent",
    );
  },
);

test(
  "tenants are isolated and the runtime role cannot delete",
  { skip },
  async () => {
    const { deps } = makeDeps(pool!);
    const task = makeTask();
    await handleTask(deps, incoming(task));
    assert.equal(await delivery(randomUUID(), task.intent_id), undefined);
    const { rows } = await pool!.query(
      "SELECT count(*)::int AS n FROM deliveries",
    );
    assert.equal(rows[0].n, 0);
    await assert.rejects(
      withTenant(pool!, randomUUID(), (c) =>
        c.query(
          "INSERT INTO notification_preferences (tenant_id, channel) VALUES ($1, 'email')",
          [task.tenant_id],
        ),
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "42501" &&
        /row-level security|tenant context does not match row tenant/.test(
          String(error),
        ),
    );
    await assert.rejects(
      withTenant(pool!, task.tenant_id, (c) =>
        c.query("DELETE FROM deliveries"),
      ),
      /permission denied/,
    );
    await assert.rejects(
      withTenant(pool!, "nope", async () => 1),
      InvalidTenantError,
    );
  },
);

test("a crash before commit leaves no delivery row", { skip }, async () => {
  const task = makeTask();
  await assert.rejects(
    withTenant(pool!, task.tenant_id, async (c) => {
      await c.query(
        "INSERT INTO deliveries (tenant_id, intent_id, channel, severity, correlation_id) VALUES ($1, $2, 'email', 'critical', $3)",
        [task.tenant_id, task.intent_id, task.correlation_id],
      );
      throw new Error("simulated crash before commit");
    }),
  );
  assert.equal(await delivery(task.tenant_id, task.intent_id), undefined);
});

test(
  "preferences suppress a channel and use optimistic versions",
  { skip },
  async () => {
    const { deps, adapter, broker } = makeDeps(pool!);
    const task = makeTask({ channel: "sms", severity: "warning" });
    assert.equal(
      await setPreference(pool!, task.tenant_id, "sms", true, "critical", null),
      true,
    );
    assert.equal(
      await setPreference(pool!, task.tenant_id, "sms", true, "critical", null),
      false,
    );
    assert.equal(
      await setPreference(pool!, task.tenant_id, "sms", true, "critical", 1),
      true,
    );
    assert.equal(
      await setPreference(pool!, task.tenant_id, "sms", false, "critical", 1),
      false,
      "stale version must lose",
    );
    await handleTask(deps, incoming(task));
    assert.equal(adapter.sendCalls.length, 0);
    assert.equal(
      (await delivery(task.tenant_id, task.intent_id))?.status,
      "suppressed",
    );
    assert.deepEqual(receipts(broker.published), ["suppressed"]);
  },
);

test(
  "provider timeout records unknown, then reconciles to one delivery",
  { skip },
  async () => {
    const { deps, adapter, broker } = makeDeps(pool!);
    const task = makeTask();
    adapter.queue("timeout-after-accept");
    await handleTask(deps, incoming(task));
    assert.equal(
      (await delivery(task.tenant_id, task.intent_id))?.status,
      "unknown",
    );
    assert.deepEqual(broker.keys(), [RETRY_KEY]);
    await handleTask(deps, incoming(task, 1));
    const row = await delivery(task.tenant_id, task.intent_id);
    assert.equal(row?.status, "sent");
    assert.equal(row?.reconciles, 1);
    assert.equal(adapter.sendCalls.length, 1, "reconcile must not re-send");
    assert.equal(adapter.delivered.size, 1);
  },
);

test(
  "an unreachable provider stays unknown and is parked, never marked failed",
  { skip },
  async () => {
    const { deps, adapter, broker } = makeDeps(pool!);
    const task = makeTask();
    adapter.queue("hang");
    const hang = {
      ...adapter,
      send: adapter.send.bind(adapter),
      reconcile: () => new Promise<never>(() => undefined),
    };
    deps.adapter = () => hang as never;
    for (let i = 0; i < 3; i++) await handleTask(deps, incoming(task, i));
    assert.equal(
      (await delivery(task.tenant_id, task.intent_id))?.status,
      "unknown",
    );
    assert.deepEqual(broker.keys(), [RETRY_KEY, RETRY_KEY, DEAD_KEY]);
    assert.equal(deps.metrics.get("unknown_parked"), 1);
  },
);

test(
  "transient failures back off and dead-letter after max attempts; replay retries",
  { skip },
  async () => {
    const { deps, adapter, broker } = makeDeps(pool!);
    const task = makeTask();
    adapter.queue("transient", "transient", "transient");
    for (let i = 0; i < 3; i++) await handleTask(deps, incoming(task, i));
    assert.equal(
      (await delivery(task.tenant_id, task.intent_id))?.status,
      "dead",
    );
    assert.deepEqual(broker.keys(), [
      RETRY_KEY,
      RETRY_KEY,
      RECEIPT_KEY,
      DEAD_KEY,
    ]);
    assert.deepEqual(
      broker.published.slice(0, 2).map((p) => p.expirationMs),
      [10, 20],
    );
    // DLQ replay keeps the intent id; the next attempt succeeds and becomes terminal.
    await handleTask(deps, incoming(task, 0));
    assert.equal(
      (await delivery(task.tenant_id, task.intent_id))?.status,
      "sent",
    );
    assert.equal(adapter.delivered.size, 1);
  },
);

test("a permanent rejection is a terminal failure", { skip }, async () => {
  const { deps, adapter, broker } = makeDeps(pool!);
  const task = makeTask();
  adapter.queue("reject");
  await handleTask(deps, incoming(task));
  assert.equal(
    (await delivery(task.tenant_id, task.intent_id))?.status,
    "failed",
  );
  assert.deepEqual(receipts(broker.published), ["failed"]);
});

test(
  "a crash during the provider call is reconciled on redelivery",
  { skip },
  async () => {
    const adapter = new LocalTestAdapter();
    const { deps } = makeDeps(pool!, adapter);
    const task = makeTask();
    assert.deepEqual(await beginDelivery(pool!, task), {
      action: "send",
      attempt: 1,
    });
    // Process dies here (provider accepted, nothing recorded). Redelivery must reconcile.
    await adapter.send(
      { idempotencyKey: task.intent_id, task },
      new AbortController().signal,
    );
    await handleTask(deps, incoming(task));
    assert.equal(
      (await delivery(task.tenant_id, task.intent_id))?.status,
      "sent",
    );
    assert.equal(adapter.delivered.size, 1);
  },
);

test(
  "a broker failure after commit requeues and the retry stays idempotent",
  { skip },
  async () => {
    const { deps, broker, adapter } = makeDeps(pool!);
    const task = makeTask();
    broker.failWith = new Error("channel closed");
    await assert.rejects(handleTask(deps, incoming(task)), /channel closed/);
    broker.failWith = null;
    assert.equal(await handleTask(deps, incoming(task)), "ack");
    assert.equal(adapter.sendCalls.length, 1);
    assert.deepEqual(receipts(broker.published), ["sent"]);
  },
);

test(
  "redrive preserves a prior sent result after a lost receipt confirm",
  { skip },
  async () => {
    const { deps, broker, adapter } = makeDeps(pool!);
    const original = makeTask();
    broker.failWith = new Error("confirm lost");
    await assert.rejects(handleTask(deps, incoming(original)), /confirm lost/);
    broker.failWith = null;
    const redrive = { ...original, delivery_generation: 1 };
    assert.equal(await handleTask(deps, incoming(redrive)), "ack");
    assert.equal(
      adapter.sendCalls.length,
      1,
      "sent intent must not send twice",
    );
    const receipt = broker.published.find((p) => p.key === RECEIPT_KEY);
    assert.equal(JSON.parse(receipt!.body.toString()).delivery_generation, 1);
  },
);

test(
  "redrive retries failed delivery and ignores the old generation",
  { skip },
  async () => {
    const { deps, broker, adapter } = makeDeps(pool!);
    const original = makeTask();
    adapter.queue("reject");
    await handleTask(deps, incoming(original));
    assert.equal(
      (await delivery(original.tenant_id, original.intent_id))?.status,
      "failed",
    );
    const retry = { ...original, delivery_generation: 1 };
    await handleTask(deps, incoming(retry));
    assert.equal(
      (await delivery(original.tenant_id, original.intent_id))?.status,
      "sent",
    );
    assert.equal(adapter.sendCalls.length, 2);
    const receiptsBefore = receipts(broker.published).length;
    await handleTask(deps, incoming(original));
    assert.equal(
      receipts(broker.published).length,
      receiptsBefore,
      "stale task emitted a receipt",
    );
  },
);

test(
  "redrive rechecks preference after a suppressed delivery",
  { skip },
  async () => {
    const { deps, adapter } = makeDeps(pool!);
    const original = makeTask();
    await setPreference(
      pool!,
      original.tenant_id,
      original.channel,
      false,
      "warning",
      null,
    );
    await handleTask(deps, incoming(original));
    assert.equal(
      (await delivery(original.tenant_id, original.intent_id))?.status,
      "suppressed",
    );
    await setPreference(
      pool!,
      original.tenant_id,
      original.channel,
      true,
      "warning",
      1,
    );
    await handleTask(deps, incoming({ ...original, delivery_generation: 1 }));
    assert.equal(
      (await delivery(original.tenant_id, original.intent_id))?.status,
      "sent",
    );
    assert.equal(adapter.sendCalls.length, 1);
  },
);

test("migrations apply twice on a fresh database", { skip }, async () => {
  const admin = new pg.Client({
    connectionString: process.env.POSTGRES_ADMIN_URL,
  });
  await admin.connect();
  const name = `notifications_test_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${name} OWNER notifications_migrator`);
  try {
    const url = new URL(process.env.NOTIFICATIONS_MIGRATION_URL!);
    url.pathname = `/${name}`;
    assert.deepEqual(
      await migrate(url.toString()),
      (await readdir(MIGRATIONS_DIR))
        .filter((name) => name.endsWith(".sql"))
        .sort(),
    );
    assert.equal((await migrate(url.toString())).length, 0);
    assert.deepEqual(
      await runMigrate((k) =>
        k === "NOTIFICATIONS_MIGRATION_URL" ? url.toString() : undefined,
      ),
      [],
    );
    await assert.rejects(
      runMigrate(() => undefined),
      /required/,
    );
    const broken = `${process.cwd()}/src/testing`;
    await assert.rejects(migrate(url.toString(), broken));
  } finally {
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});

test(
  "provider effect keeps the real ownership fence until ledger completion",
  { skip },
  async () => {
    const task = makeTask();
    const { deps } = makeDeps(pool!);
    let entered!: () => void, complete!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      complete = resolve;
    });
    deps.policy = { ...deps.policy, providerTimeoutMs: 2000 };
    deps.adapter = () => ({
      send: async () => {
        entered();
        await blocked;
        return { kind: "sent", providerRef: "fenced-effect" };
      },
      reconcile: async () => ({ kind: "not_found" }),
    });
    const url = new URL(process.env.POSTGRES_ADMIN_URL!);
    url.pathname = "/greenguard_notifications";
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const running = handleTask(deps, incoming(task));
    try {
      await active;
      await admin.query("BEGIN");
      await admin.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(
        admin.query(
          "SELECT tenant_id FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1 FOR UPDATE",
          [task.tenant_id],
        ),
        { code: "55P03" },
      );
      await admin.query("ROLLBACK");
      complete();
      assert.equal(await running, "ack");
      assert.equal(
        (await delivery(task.tenant_id, task.intent_id))?.status,
        "sent",
      );
      await admin.query("BEGIN");
      await admin.query("SET LOCAL lock_timeout='100ms'");
      assert.equal(
        (
          await admin.query(
            "SELECT tenant_id FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1 FOR UPDATE",
            [task.tenant_id],
          )
        ).rowCount,
        1,
      );
      await admin.query("ROLLBACK");
    } finally {
      complete();
      await running;
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
    }
  },
);
