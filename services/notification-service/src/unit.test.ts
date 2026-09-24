import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConsumeMessage } from "amqplib";
import { LocalTestAdapter, UnconfiguredAdapter } from "./adapters.js";
import { ConfirmBroker, settle, toIncoming } from "./broker.js";
import { loadConfig } from "./config.js";
import { adapterFor, metricsServer } from "./main.js";
import { Metrics } from "./metrics.js";
import { Semaphore, TimeoutError, withTimeout } from "./pool.js";
import { InvalidTaskError, parseTask } from "./task.js";
import { declareTopology, QUEUES, TASK_QUEUE } from "./topology.js";
import {
  FakeBroker,
  incoming,
  makeDeps,
  makeTask,
  testPolicy,
} from "./testing/fixtures.js";
import {
  attemptReconcile,
  attemptSend,
  backoffMs,
  handleTask,
} from "./worker.js";
import type pg from "pg";

const noPool = {} as pg.Pool;

test("parseTask accepts a task and rejects poison", () => {
  const task = makeTask();
  assert.deepEqual(parseTask(incoming(task).body, task.intent_id), task);
  const bad: [Buffer, string | undefined][] = [
    [Buffer.from("{"), task.intent_id],
    [Buffer.from("null"), task.intent_id],
    [Buffer.from(JSON.stringify({ ...task, tenant_id: "x" })), task.intent_id],
    [Buffer.from(JSON.stringify({ ...task, channel: "fax" })), task.intent_id],
    [Buffer.from(JSON.stringify({ ...task, severity: "" })), task.intent_id],
    [
      Buffer.from(JSON.stringify({ ...task, delivery_generation: -1 })),
      task.intent_id,
    ],
    [incoming(task).body, "another-id"],
  ];
  for (const [body, id] of bad)
    assert.throws(() => parseTask(body, id), InvalidTaskError);
});

test("semaphore bounds concurrency and withTimeout reports timeouts", async () => {
  const sem = new Semaphore(2);
  let peak = 0;
  let active = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      sem.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.equal(sem.inFlight, 0);
  assert.throws(() => new Semaphore(0));
  await assert.rejects(
    withTimeout(
      5,
      (s) =>
        new Promise((_, rej) =>
          s.addEventListener("abort", () => rej(new Error("x"))),
        ),
    ),
    TimeoutError,
  );
  await assert.rejects(
    withTimeout(50, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await withTimeout(50, async () => 7), 7);
});

test("local adapter is idempotent by key and supports every behaviour", async () => {
  const a = new LocalTestAdapter();
  const signal = new AbortController().signal;
  const req = { idempotencyKey: "k", task: makeTask() };
  a.queue("transient", "reject");
  assert.equal((await a.send(req, signal)).kind, "transient");
  assert.equal((await a.send(req, signal)).kind, "rejected");
  const first = await a.send(req, signal);
  const second = await a.send(req, signal);
  assert.deepEqual(first, second);
  assert.equal(a.delivered.size, 1);
  assert.deepEqual(await a.reconcile("k"), first);
  assert.deepEqual(await a.reconcile("none"), { kind: "not_found" });
  const aborted = AbortSignal.abort();
  a.queue("hang");
  await assert.rejects(a.send({ ...req, idempotencyKey: "h" }, aborted));
  const u = new UnconfiguredAdapter("sms");
  assert.equal((await u.send()).kind, "transient");
  assert.equal((await u.reconcile()).kind, "not_found");
});

test("config validates input", () => {
  const env: Record<string, string> = {
    NOTIFICATIONS_DATABASE_URL: "postgres://x",
    RABBITMQ_URL: "amqp://x",
  };
  const c = loadConfig((k) => env[k]);
  assert.equal(c.provider, "local");
  assert.equal(c.prefetch, 16);
  assert.throws(() => loadConfig(() => undefined));
  assert.throws(() =>
    loadConfig((k) => ({ ...env, NOTIFICATIONS_PROVIDER: "smtp" })[k]),
  );
  assert.throws(() =>
    loadConfig((k) => ({ ...env, NOTIFICATIONS_MAX_ATTEMPTS: "0" })[k]),
  );
  assert.equal(
    loadConfig((k) => ({ ...env, NOTIFICATIONS_MAX_ATTEMPTS: "" })[k]).policy
      .maxAttempts,
    5,
  );
  const unconfigured = adapterFor({ ...c, provider: "unconfigured" });
  assert.ok(unconfigured("sms") instanceof UnconfiguredAdapter);
  const local = adapterFor(c);
  assert.equal(local("email"), local("sms"));
});

test("metrics have no tenant labels and report lag", async () => {
  const m = new Metrics();
  m.inc("outcome_sent");
  m.observeLag(100, 105_000);
  m.observeLag(undefined);
  const text = m.render({ provider_in_flight: 0 });
  assert.match(text, /notifications_outcome_sent_total 1/);
  assert.match(text, /notifications_task_lag_seconds 5/);
  assert.doesNotMatch(text, /tenant/);
  const server = metricsServer(m, new Semaphore(1)).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as { port: number };
  for (const [path, status] of [
    ["/healthz", 200],
    ["/metrics", 200],
    ["/other", 404],
  ] as const)
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}${path}`)).status,
      status,
    );
  server.close();
});

test("confirm broker resolves on confirm and rejects on nack", async () => {
  const calls: unknown[][] = [];
  const ok = new ConfirmBroker({
    publish: (...args: unknown[]) => {
      calls.push(args);
      (args[4] as (e: unknown) => void)(null);
      return true;
    },
  } as never);
  await ok.publish({
    key: "task",
    messageId: "m",
    body: Buffer.from("{}"),
    expirationMs: 5,
  });
  const opts = calls[0][3] as {
    messageId: string;
    persistent: boolean;
    expiration: string;
  };
  assert.equal(opts.messageId, "m");
  assert.equal(opts.persistent, true);
  assert.equal(opts.expiration, "5");
  const nack = new ConfirmBroker({
    publish: (...args: unknown[]) => {
      (args[4] as (e: unknown) => void)("nacked");
      return true;
    },
  } as never);
  await assert.rejects(
    nack.publish({ key: "task", messageId: "m", body: Buffer.from("{}") }),
    /nacked/,
  );
});

test("settle acks after success, dead-letters rejects, requeues errors", async () => {
  const log: string[] = [];
  const ch = {
    ack: () => log.push("ack"),
    nack: (_m: unknown, _a: unknown, requeue: unknown) =>
      log.push(requeue ? "requeue" : "dead"),
  };
  const msg = {
    content: Buffer.from("{}"),
    properties: { messageId: "m", headers: undefined },
  } as unknown as ConsumeMessage;
  await settle(ch as never, msg, async () => "ack");
  await settle(ch as never, msg, async () => "reject");
  await settle(ch as never, msg, async () => {
    throw new Error("db down");
  });
  assert.deepEqual(log, ["ack", "dead", "requeue"]);
  assert.deepEqual(toIncoming(msg).headers, {});
});

test("topology declares every exchange, queue and binding", async () => {
  const seen: string[] = [];
  const ch = {
    assertExchange: async (n: string) => {
      seen.push(n);
      return { exchange: n };
    },
    assertQueue: async (n: string) => {
      seen.push(n);
      return { queue: n, messageCount: 0, consumerCount: 0 };
    },
    bindQueue: async () => ({}),
  };
  await declareTopology(ch as never);
  assert.equal(seen.length, 2 + QUEUES.length);
  const task = QUEUES.find((q) => q.name === TASK_QUEUE);
  assert.equal(task?.args["x-queue-type"], "quorum");
  assert.equal(task?.args["x-delivery-limit"], 5);
});

test("backoff is exponential and capped", () => {
  assert.deepEqual(
    [1, 2, 3, 9].map((n) => backoffMs(testPolicy, n)),
    [10, 20, 40, 40],
  );
});

test("provider outcomes map to ledger statuses; timeout is unknown, not failed", async () => {
  const adapter = new LocalTestAdapter();
  const { deps } = makeDeps(noPool, adapter);
  const task = makeTask();
  adapter.queue("transient", "transient", "reject", "timeout-after-accept");
  assert.equal((await attemptSend(deps, task, 1)).status, "retry");
  assert.equal((await attemptSend(deps, task, 3)).status, "dead");
  assert.equal((await attemptSend(deps, task, 1)).status, "failed");
  const timedOut = await attemptSend(deps, task, 1);
  assert.equal(timedOut.status, "unknown");
  assert.match(timedOut.error ?? "", /provider timeout/);
  assert.equal((await attemptReconcile(deps, task)).status, "sent");
  assert.equal((await attemptReconcile(deps, makeTask())).status, "retry");
  const broken = makeDeps(noPool, {
    send: async () => {
      throw new Error("socket");
    },
    reconcile: async () => {
      throw "weird";
    },
  } as never).deps;
  assert.equal((await attemptSend(broken, task, 1)).error, "socket");
  assert.equal((await attemptReconcile(broken, task)).error, "weird");
});

test("an invalid task is dead-lettered without touching the database", async () => {
  const { deps } = makeDeps(noPool);
  const task = makeTask();
  assert.equal(
    await handleTask(deps, { ...incoming(task), messageId: "other" }),
    "reject",
  );
  assert.equal(deps.metrics.get("tasks_rejected"), 1);
  assert.ok(new FakeBroker());
});
