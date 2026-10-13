// Live RabbitMQ + PostgreSQL tests; run only through `make rabbitmq-test`.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { ConsumeMessage } from "amqplib";
import { LocalTestAdapter } from "../adapters.js";
import {
  ConfirmBroker,
  connectBroker,
  settle,
  toIncoming,
  type Connection,
} from "../broker.js";
import { withTenant } from "../tenant.js";
import {
  DEAD_QUEUE,
  RECEIPT_QUEUE,
  RETRY_QUEUE,
  TASK_KEY,
  TASK_QUEUE,
} from "../topology.js";
import { handleTask, type Deps } from "../worker.js";
import { makeDeps, makeTask, testPool } from "./fixtures.js";
import type { Task } from "../task.js";

const url = process.env.RABBITMQ_URL ?? "";
const pool = testPool();
const skip =
  url && pool
    ? false
    : "RABBITMQ_URL and NOTIFICATIONS_DIRECT_URL are required";
const open: Connection[] = [];

before(async () => {
  if (skip) return;
  const c = await connectBroker(url);
  for (const q of [TASK_QUEUE, RETRY_QUEUE, DEAD_QUEUE, RECEIPT_QUEUE])
    await c.channel.purgeQueue(q);
  await c.close();
});
// Each test's consumers must stop before the next test publishes to the shared queue.
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined);
});
after(() => pool?.end());

async function connect(): Promise<Connection> {
  const c = await connectBroker(url);
  open.push(c);
  return c;
}

async function consumer(
  deps: Deps,
): Promise<{ waitForIdle: () => Promise<void> }> {
  const c = await connect();
  deps.broker = new ConfirmBroker(c.channel);
  await c.channel.prefetch(4);
  const pending = new Set<Promise<void>>();
  let settlementError: unknown;
  await c.channel.consume(
    TASK_QUEUE,
    (msg) => {
      if (!msg) return;
      let operation: Promise<void>;
      operation = settle(c.channel, msg, (t) => handleTask(deps, t))
        .catch((error: unknown) => {
          settlementError = error;
        })
        .finally(() => pending.delete(operation));
      pending.add(operation);
    },
    { noAck: false },
  );
  return {
    waitForIdle: async () => {
      await waitFor(
        () => Promise.resolve(pending.size === 0),
        "consumer settlement",
      );
      if (settlementError) throw settlementError;
    },
  };
}

async function publishTask(task: Task): Promise<void> {
  const c = await connect();
  await new ConfirmBroker(c.channel).publish({
    key: TASK_KEY,
    messageId: task.intent_id,
    body: Buffer.from(JSON.stringify(task)),
  });
}

async function status(task: Task): Promise<string | undefined> {
  return withTenant(pool!, task.tenant_id, async (c) => {
    const { rows } = await c.query(
      "SELECT status FROM deliveries WHERE intent_id = $1",
      [task.intent_id],
    );
    return rows[0]?.status as string | undefined;
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  ms = 15000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function drainIds(queue: string): Promise<string[]> {
  const c = await connect();
  const ids: string[] = [];
  for (;;) {
    const m = await c.channel.get(queue, { noAck: true });
    if (!m) return ids;
    ids.push(String(m.properties.messageId));
  }
}

test(
  "consumer crash before ack redelivers and records ONE delivery",
  { skip },
  async () => {
    const adapter = new LocalTestAdapter();
    const { deps } = makeDeps(pool!, adapter);
    const task = makeTask();
    const crashing = await connect();
    deps.broker = new ConfirmBroker(crashing.channel);
    let crashed = false;
    await crashing.channel.prefetch(1);
    await crashing.channel.consume(
      TASK_QUEUE,
      (msg: ConsumeMessage | null) => {
        if (!msg || crashed) return;
        crashed = true;
        // Durable outcome commits, then the process "dies" before basic.ack.
        void handleTask(deps, toIncoming(msg)).then(() => crashing.close());
      },
      { noAck: false },
    );
    await publishTask(task);
    await waitFor(
      async () => crashed && (await status(task)) === "sent",
      "first delivery",
    );
    const worker = await consumer(deps);
    await waitFor(
      async () => deps.metrics.get("duplicates") === 1,
      "redelivery",
    );
    await worker.waitForIdle();
    assert.equal(adapter.sendCalls.length, 1);
    assert.equal(adapter.delivered.size, 1);
    assert.equal(await status(task), "sent");
  },
);

test(
  "provider timeout leaves unknown, then the retry queue drives reconciliation",
  { skip },
  async () => {
    const adapter = new LocalTestAdapter();
    adapter.queue("timeout-after-accept");
    const { deps } = makeDeps(pool!, adapter);
    const task = makeTask();
    const seen: string[] = [];
    const worker = await consumer(deps);
    await publishTask(task);
    await waitFor(async () => {
      const s = await status(task);
      if (s && seen.at(-1) !== s) seen.push(s);
      return s === "sent";
    }, "reconciled delivery");
    await worker.waitForIdle();
    assert.ok(
      seen.includes("unknown") || deps.metrics.get("outcome_unknown") === 1,
      `statuses ${seen}`,
    );
    assert.equal(adapter.sendCalls.length, 1, "reconcile must not re-send");
  },
);

test(
  "transient failures dead-letter after max attempts; replay keeps the intent id",
  { skip },
  async () => {
    const adapter = new LocalTestAdapter();
    adapter.queue("transient", "transient", "transient");
    const { deps } = makeDeps(pool!, adapter);
    const task = makeTask();
    const worker = await consumer(deps);
    await publishTask(task);
    await waitFor(
      async () => (await status(task)) === "dead",
      "dead-lettered delivery",
    );
    let dead: string[] = [];
    await waitFor(
      async () => (dead = await drainIds(DEAD_QUEUE)).length > 0,
      "DLQ message",
    );
    assert.deepEqual(dead, [task.intent_id]);
    await publishTask(task); // operator replay with the same message id
    await waitFor(
      async () => (await status(task)) === "sent",
      "replayed delivery",
    );
    assert.equal(adapter.delivered.size, 1);
    const receipts = await drainIds(RECEIPT_QUEUE);
    assert.ok(
      receipts.includes(`${task.intent_id}:dead`) &&
        receipts.includes(`${task.intent_id}:sent`),
      `${receipts}`,
    );
    await worker.waitForIdle();
  },
);
