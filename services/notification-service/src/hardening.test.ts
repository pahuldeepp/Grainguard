import assert from "node:assert/strict";
import { test } from "node:test";
import type { Consumer, ProducerRecord } from "kafkajs";
import type pg from "pg";
import { VersionedFlagStore } from "@greenguard/feature-flags";
import { controlPlaneFlagSnapshot, GLOBAL_FLAG_TENANT } from "./flags.js";
import { loadConfig } from "./config.js";
import { optionalSendFor } from "./main.js";
import { startFlagFeed } from "./flag-feed.js";
import { handleTask } from "./worker.js";
import { incoming, makeDeps, makeTask } from "./testing/fixtures.js";
import {
  FIRST_HELD_HEADER,
  OPTIONAL_HOLD_ATTEMPT_HEADER,
  RETRY_KEY,
  RECEIPT_KEY,
  DEAD_KEY,
} from "./topology.js";

const env = {
  NOTIFICATIONS_DATABASE_URL: "postgres://unused",
  RABBITMQ_URL: "amqp://unused",
};

test("snapshot validates bearer transport before any request and rejects redirects", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    request = { url: String(url), init };
    const tenantId = decodeURIComponent(
      new URL(String(url)).pathname.split("/").at(-1)!,
    );
    return Response.json(
      tenantId === GLOBAL_FLAG_TENANT
        ? { scope: "global", version: 1, flags: {} }
        : { scope: "tenant", tenantId, version: 1, flags: {} },
    );
  };
  for (const [url, token] of [
    ["not a URL", "token"],
    ["http://control.test", "token"],
    ["ftp://control.test", "token"],
    ["https://name:secret@control.test", "token"],
    ["https://control.test?secret=x", "token"],
    ["https://control.test#x", "token"],
    ["https://control.test", ""],
    ["https://control.test", "  "],
    ["https://control.test", "token\r\nx"],
  ])
    assert.throws(
      () => controlPlaneFlagSnapshot(url!, token!, { fetch: fetcher }),
      /invalid flag snapshot/,
    );
  assert.equal(request, undefined);
  const get = controlPlaneFlagSnapshot(
    "https://control.test/ignored",
    "token",
    { fetch: fetcher },
  );
  await get("tenant/unsafe");
  assert.equal(
    request!.url,
    "https://control.test/v1/internal/flags/tenant%2Funsafe",
  );
  assert.equal(request!.init!.redirect, "error");
  assert.deepEqual(request!.init!.headers, { authorization: "Bearer token" });
  await controlPlaneFlagSnapshot("http://127.0.0.1:8090", "token", {
    allowInsecureHttp: true,
    fetch: fetcher,
  })("tenant");
  assert.match(request!.url, /^http:\/\/127.0.0.1:8090\//);
});

test("flag snapshots reject mismatched scope, tenant, version, and flags shape", async () => {
  const invalidBodies: unknown[] = [
    { scope: "global", version: 1, flags: {} },
    { scope: "tenant", tenantId: "other", version: 1, flags: {} },
    { scope: "tenant", tenantId: "tenant-a", version: 0, flags: {} },
    {
      scope: "tenant",
      tenantId: "tenant-a",
      version: Number.MAX_SAFE_INTEGER + 1,
      flags: {},
    },
    { scope: "tenant", tenantId: "tenant-a", version: 1, flags: [] },
    { scope: "tenant", tenantId: "tenant-a", version: 1, flags: null },
  ];
  for (const body of invalidBodies) {
    const snapshot = controlPlaneFlagSnapshot("https://control.test", "token", {
      fetch: async () => Response.json(body),
    });
    await assert.rejects(
      snapshot("tenant-a"),
      /invalid flag snapshot response/,
    );
  }
});

test("config propagates local-only insecure opt-in; live remains HTTPS-only", () => {
  const config = loadConfig(
    (key) =>
      ({
        ...env,
        CONTROL_PLANE_URL: "http://localhost:8090",
        CONTROL_LOOKUP_TOKEN: "token",
        NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP: "true",
      })[key],
  );
  assert.equal(config.flagSnapshot?.allowInsecureHttp, true);
  assert.equal(
    config.notificationProviders.controlPlane?.allowInsecureHttp,
    true,
  );
  assert.doesNotThrow(() =>
    optionalSendFor(config, new VersionedFlagStore(60_000)),
  );
  assert.throws(
    () =>
      optionalSendFor(
        { ...config, provider: "live" },
        new VersionedFlagStore(60_000),
      ),
    /invalid flag snapshot/,
  );
  assert.throws(
    () =>
      loadConfig(
        (key) =>
          ({
            ...env,
            NOTIFICATIONS_PROVIDER: "live",
            CONTROL_PLANE_URL: "http://localhost:8090",
            CONTROL_LOOKUP_TOKEN: "token",
            NOTIFICATIONS_ALLOW_INSECURE_CONTACT_LOOKUP: "true",
          })[key],
      ),
    /must use HTTPS/,
  );
  const liveMesh = loadConfig(
    (key) =>
      ({
        ...env,
        NOTIFICATIONS_PROVIDER: "live",
        CONTROL_PLANE_URL:
          "http://tenant-control-plane.greenguard.svc.cluster.local:3010",
        CONTROL_LOOKUP_TOKEN: "token",
        GG_MESH_INTERNAL_HTTP: "1",
        SENDGRID_API_KEY: "sendgrid-key",
        SENDGRID_FROM_EMAIL: "alerts@example.test",
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "twilio-token",
        TWILIO_FROM_NUMBER: "+12045550123",
      })[key],
  );
  assert.equal(liveMesh.controlPlaneMeshHttp, true);
  assert.doesNotThrow(() =>
    optionalSendFor(liveMesh, new VersionedFlagStore(60_000)),
  );
  assert.throws(
    () =>
      optionalSendFor(
        {
          ...config,
          flagSnapshot: { ...config.flagSnapshot!, allowInsecureHttp: false },
        },
        new VersionedFlagStore(60_000),
      ),
    /invalid flag snapshot/,
  );
});

/** Minimal transactional ledger stand-in; provider sends remain local-only. */
function ledgerPool(
  initialStatus = "received",
  audit?: {
    claims: number;
    attempts: Array<{ kind: unknown; outcome: unknown; detail: unknown }>;
  },
): pg.Pool {
  let status = initialStatus;
  let lastError: unknown = null;
  return {
    connect: async () => ({
      release: () => {},
      query: async (sql: string, args?: unknown[]) => {
        if (sql.includes("SELECT status"))
          return {
            rows: [
              {
                status,
                attempts: 0,
                reconciles: 0,
                delivery_generation: 0,
                last_error: lastError,
              },
            ],
          };
        if (sql.includes("FROM notification_preferences")) return { rows: [] };
        if (sql.includes("RETURNING attempt_no")) {
          audit?.attempts.push({
            kind: args?.[2],
            outcome: args?.[3],
            detail: args?.[4],
          });
          return { rows: [{ n: 1 }] };
        }
        if (sql.includes("UPDATE deliveries SET status = 'in_progress'"))
          if (audit) audit.claims += 1;
        if (sql.includes("UPDATE deliveries SET status = $3")) {
          status = String(args?.[2]);
          lastError = args?.[4];
        }
        return { rows: [], rowCount: 1 };
      },
    }),
  } as unknown as pg.Pool;
}

test("no configured flag source delivers warnings directly through normal ledger", async () => {
  const config = loadConfig((key) => env[key as keyof typeof env]);
  const { deps, adapter, broker } = makeDeps(ledgerPool());
  deps.optionalSendEnabled = optionalSendFor(
    config,
    new VersionedFlagStore(60_000),
  );
  assert.equal(deps.optionalSendEnabled, undefined);
  assert.equal(await handleTask(deps, incoming(makeTask())), "ack");
  assert.equal(adapter.delivered.size, 1);
  assert.deepEqual(broker.keys(), [RECEIPT_KEY]);
  assert.equal(deps.metrics.get("optional_held"), 0);
  assert.ok(
    optionalSendFor(
      { ...config, kafkaBrokers: ["unused:9092"] },
      new VersionedFlagStore(60_000),
    ),
  );
});

test("configured disabled gate bounds holds, preserves first-held metadata and parks with stable failed receipt", async () => {
  const task = makeTask();
  const audit = {
    claims: 0,
    attempts: [] as Array<{ kind: unknown; outcome: unknown; detail: unknown }>,
  };
  const { deps, adapter, broker } = makeDeps(ledgerPool("received", audit));
  deps.optionalSendEnabled = async () => false;
  let message = incoming(task);
  const firstHeld = Date.now() - 20_000;
  message.headers[FIRST_HELD_HEADER] = firstHeld;
  for (let attempt = 1; attempt <= deps.policy.maxAttempts; attempt++) {
    assert.equal(await handleTask(deps, message), "ack");
    const published = broker.published.at(-1)!;
    assert.equal(published.headers?.[FIRST_HELD_HEADER], firstHeld);
    assert.equal(published.headers?.[OPTIONAL_HOLD_ATTEMPT_HEADER], attempt);
    if (attempt < deps.policy.maxAttempts) {
      assert.equal(published.key, RETRY_KEY);
      assert.equal(published.headers?.["x-attempt"], 0); // provider retry budget is separate
      message = { ...message, headers: published.headers! };
    }
  }
  assert.deepEqual(broker.keys(), [
    RETRY_KEY,
    RETRY_KEY,
    RECEIPT_KEY,
    DEAD_KEY,
  ]);
  const receipt = broker.published.at(-2)!;
  assert.equal(receipt.messageId, `${task.intent_id}:failed`);
  assert.equal(JSON.parse(receipt.body.toString()).outcome, "failed");
  assert.equal(broker.published.at(-1)!.messageId, task.intent_id);
  assert.equal(adapter.delivered.size, 0);
  assert.equal(audit.claims, 0, "hold expiry must not claim a provider send");
  assert.equal(audit.attempts.length, 1);
  assert.equal(audit.attempts[0]?.kind, "hold");
  assert.equal(audit.attempts[0]?.outcome, "failed");
  assert.equal(deps.metrics.get("optional_held_parked"), 1);
  assert.match(
    deps.metrics.render(),
    /notifications_optional_held_age_seconds (?:2[0-9]|[3-9][0-9])/,
  );
  assert.ok(!deps.metrics.render().includes(task.tenant_id));
});

test("first-held timestamp is initialized once and retry publish failure leaves original unacked", async () => {
  const task = makeTask();
  const { deps, broker } = makeDeps({} as pg.Pool);
  deps.optionalSendEnabled = async () => {
    throw new Error("source down");
  };
  const before = Date.now();
  await handleTask(deps, incoming(task));
  const original = broker.published[0]!.headers!;
  assert.ok(Number(original[FIRST_HELD_HEADER]) >= before);
  assert.ok(Number(original[FIRST_HELD_HEADER]) <= Date.now());
  await handleTask(deps, { ...incoming(task), headers: original });
  assert.equal(
    broker.published[1]!.headers?.[FIRST_HELD_HEADER],
    original[FIRST_HELD_HEADER],
  );
  broker.failWith = new Error("confirm failed");
  await assert.rejects(handleTask(deps, incoming(task)), /confirm failed/);
});

test("exhausted hold persists terminal failure and survives park failure then flag recovery", async () => {
  const task = makeTask();
  const { deps, broker, adapter } = makeDeps(ledgerPool());
  deps.optionalSendEnabled = async () => false;
  const exhausted = {
    ...incoming(task),
    headers: { [OPTIONAL_HOLD_ATTEMPT_HEADER]: deps.policy.maxAttempts - 1 },
  };
  const publish = broker.publish.bind(broker);
  deps.broker = {
    publish: async (record) => {
      if (record.key === DEAD_KEY) throw new Error("park confirm failed");
      await publish(record);
    },
  };
  await assert.rejects(handleTask(deps, exhausted), /park confirm failed/);
  assert.deepEqual(broker.keys(), [RECEIPT_KEY]);
  assert.equal(deps.metrics.get("optional_held_parked"), 0);
  deps.broker = broker;
  deps.optionalSendEnabled = async () => true;
  assert.equal(await handleTask(deps, exhausted), "ack");
  assert.equal(broker.published[0]!.messageId, broker.published[1]!.messageId);
  assert.deepEqual(broker.keys(), [RECEIPT_KEY, RECEIPT_KEY, DEAD_KEY]);
  assert.equal(adapter.sendCalls.length, 0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 2));
  assert.ok(check(), "feed reached expected state");
}

function feedHarness(
  options: {
    pauseAt?: "connect" | "subscribe" | "run" | "producer";
    failPublishOnce?: boolean;
    pauseDisconnect?: boolean;
  } = {},
) {
  const paused = deferred();
  const disconnected = deferred();
  const crashes: Array<(restart: boolean) => void> = [];
  const handlers: Array<(input: unknown) => Promise<void>> = [];
  const groups: string[] = [];
  const counts = {
    unavailable: 0,
    connects: 0,
    subscribes: 0,
    runs: 0,
    disconnects: 0,
    producerDisconnects: 0,
    producerConnects: 0,
    publishCalls: 0,
  };
  const sent: ProducerRecord[] = [];
  const store = new VersionedFlagStore(60_000);
  const stop = startFlagFeed(store, ["unused:9092"], {
    retryMs: 5,
    instanceId: "hardening-test",
    onUnavailable: () => counts.unavailable++,
    createProducer: () => ({
      connect: async () => {
        counts.producerConnects++;
        if (options.pauseAt === "producer") await paused.promise;
      },
      disconnect: async () => {
        counts.producerDisconnects++;
      },
      send: async (record) => {
        counts.publishCalls++;
        if (options.failPublishOnce && counts.publishCalls === 1)
          throw new Error("quarantine unavailable");
        sent.push(record);
        return [];
      },
    }),
    createConsumer: (groupId) => {
      const index = groups.push(groupId) - 1;
      return {
        events: { CRASH: "consumer.crash" },
        on: (
          _name: string,
          listener: (e: { payload: { restart: boolean } }) => void,
        ) => {
          crashes[index] = (restart) => listener({ payload: { restart } });
          return () => {};
        },
        connect: async () => {
          counts.connects++;
          if (options.pauseAt === "connect") await paused.promise;
        },
        subscribe: async () => {
          counts.subscribes++;
          if (options.pauseAt === "subscribe") await paused.promise;
        },
        run: async (o: { eachMessage: (input: unknown) => Promise<void> }) => {
          counts.runs++;
          handlers[index] = o.eachMessage;
          if (options.pauseAt === "run") await paused.promise;
        },
        disconnect: async () => {
          counts.disconnects++;
          if (options.pauseDisconnect) await disconnected.promise;
        },
      } as unknown as Consumer;
    },
  });
  return {
    stop,
    counts,
    crashes,
    handlers,
    groups,
    paused,
    disconnected,
    sent,
    store,
  };
}
const poison = {
  topic: "greenguard.platform.config.v1",
  partition: 0,
  message: { offset: "12", value: Buffer.from("{") },
};

test("non-restartable crash reconnects after disconnect, retries same poison offset and ignores stale/restartable crashes", async () => {
  const h = feedHarness({ failPublishOnce: true, pauseDisconnect: true });
  try {
    await until(() => h.counts.runs === 1);
    h.crashes[0]!(true);
    assert.equal(h.counts.unavailable, 0);
    await assert.rejects(h.handlers[0]!(poison), /quarantine unavailable/);
    h.crashes[0]!(false);
    h.crashes[0]!(false);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(h.groups.length, 1); // wait for the failed consumer to disconnect
    assert.equal(h.counts.unavailable, 1);
    h.disconnected.resolve();
    await until(() => h.counts.runs === 2);
    assert.equal(h.groups[0], h.groups[1]);
    h.crashes[0]!(false);
    assert.equal(h.counts.unavailable, 1);
    await h.handlers[1]!(poison);
    assert.equal(
      h.sent[0]!.messages[0]!.key,
      "greenguard.platform.config.v1:0:12",
    );
    h.crashes[1]!(false);
    await until(() => h.counts.runs === 3); // second crash is also recoverable
    assert.equal(h.counts.unavailable, 2);
  } finally {
    h.disconnected.resolve();
    await h.stop();
  }
  assert.equal(h.counts.producerConnects, 1);
  assert.equal(h.counts.producerDisconnects, 1);
});

for (const pauseAt of ["producer", "connect", "subscribe", "run"] as const) {
  test(`shutdown waits for in-flight ${pauseAt} and disconnects late consumer before producer`, async () => {
    const h = feedHarness({ pauseAt });
    await until(() =>
      pauseAt === "producer"
        ? h.counts.producerConnects === 1
        : pauseAt === "connect"
          ? h.counts.connects === 1
          : pauseAt === "subscribe"
            ? h.counts.subscribes === 1
            : h.counts.runs === 1,
    );
    let stopped = false;
    const stopping = h.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 8));
    assert.equal(stopped, false);
    assert.equal(h.counts.producerDisconnects, 0);
    h.paused.resolve();
    await stopping;
    assert.equal(h.counts.disconnects, 1);
    assert.equal(h.counts.producerDisconnects, 1);
    h.crashes[0]?.(false);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.groups.length, 1);
  });
}

test("shutdown cancels recovery retry and ignores displaced crashes", async () => {
  const h = feedHarness();
  await until(() => h.counts.runs === 1);
  h.crashes[0]!(false);
  await h.stop();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.groups.length, 1);
  assert.equal(h.counts.unavailable, 1);
  assert.equal(h.counts.disconnects, 1);
});

test("hold terminal state survives receipt failure then flag re-enables without a send", async () => {
  const task = makeTask();
  const { deps, broker, adapter } = makeDeps(ledgerPool());
  deps.optionalSendEnabled = async () => false;
  const exhausted = {
    ...incoming(task),
    headers: { [OPTIONAL_HOLD_ATTEMPT_HEADER]: deps.policy.maxAttempts - 1 },
  };
  broker.failWith = new Error("receipt confirm lost");
  await assert.rejects(handleTask(deps, exhausted), /receipt confirm lost/);
  deps.optionalSendEnabled = async () => true;
  broker.failWith = null;
  assert.equal(await handleTask(deps, exhausted), "ack");
  assert.deepEqual(broker.keys(), [RECEIPT_KEY, DEAD_KEY]);
  assert.equal(
    JSON.parse(broker.published[0]!.body.toString()).outcome,
    "failed",
  );
  assert.equal(adapter.sendCalls.length, 0);
});

test("hold exhaustion keeps prior sent terminal result and never fabricates failure for uncertain send", async () => {
  for (const status of ["sent", "unknown"]) {
    const task = makeTask();
    const { deps, broker, adapter } = makeDeps(ledgerPool(status));
    deps.optionalSendEnabled = async () => false;
    const exhausted = {
      ...incoming(task),
      headers: { [OPTIONAL_HOLD_ATTEMPT_HEADER]: deps.policy.maxAttempts - 1 },
    };
    assert.equal(await handleTask(deps, exhausted), "ack");
    if (status === "sent") {
      assert.deepEqual(broker.keys(), [RECEIPT_KEY]);
      assert.equal(
        JSON.parse(broker.published[0]!.body.toString()).outcome,
        "sent",
      );
    } else assert.deepEqual(broker.keys(), [DEAD_KEY]);
    assert.equal(adapter.sendCalls.length, 0);
  }
});
