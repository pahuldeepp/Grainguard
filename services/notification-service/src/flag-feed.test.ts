import assert from "node:assert/strict";
import { test } from "node:test";
import type { Consumer } from "kafkajs";
import { VersionedFlagStore } from "@greenguard/feature-flags";
import { startFlagFeed } from "./flag-feed.js";
import { optionalSendGate } from "./flags.js";

const idleProducer = () => ({
  connect: async () => {},
  disconnect: async () => {},
  send: async () => [],
});

test("flag feed retries initial outage and applies queued version on recovery", async () => {
  const store = new VersionedFlagStore(60_000);
  const tenantId = "11111111-1111-4111-8111-111111111111";
  let calls = 0;
  let failures = 0;
  const stop = startFlagFeed(store, ["127.0.0.1:1"], {
    retryMs: 2,
    onUnavailable: () => failures++,
    createProducer: idleProducer,
    createConsumer: () =>
      ({
        events: { CRASH: "consumer.crash" },
        on: () => () => {},
        connect: async () => {
          if (++calls === 1) throw new Error("down");
        },
        subscribe: async () => {},
        run: async (options: {
          eachMessage?: (message: unknown) => Promise<void>;
        }) => {
          await options.eachMessage?.({
            message: {
              value: Buffer.from(
                JSON.stringify({
                  event_type: "flag.configuration_changed",
                  schema_version: 1,
                  tenant_id: tenantId,
                  aggregate_version: "1",
                  payload: {
                    scope: "tenant",
                    config_version: "1",
                    flags: { "notifications.optional_sends": { value: true } },
                  },
                }),
              ),
            },
          });
        },
        disconnect: async () => {},
      }) as unknown as Consumer,
  });
  try {
    for (
      let i = 0;
      i < 50 &&
      !store.resolve(tenantId, "notifications.optional_sends", "boolean");
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(failures, 1);
    assert.ok(calls >= 2);
    assert.equal(
      store.resolve(tenantId, "notifications.optional_sends", "boolean")?.value,
      true,
    );
  } finally {
    await stop();
  }
});

test("process-local flag feeds use distinct consumer groups and replay from beginning", async () => {
  const groups: string[] = [];
  const subscriptions: { topic: string; fromBeginning: boolean }[] = [];
  const start = (instanceId: string) =>
    startFlagFeed(new VersionedFlagStore(60_000), ["127.0.0.1:1"], {
      instanceId,
      createProducer: idleProducer,
      createConsumer: (groupId) => {
        groups.push(groupId);
        return {
          events: { CRASH: "consumer.crash" },
          on: () => () => {},
          connect: async () => {},
          subscribe: async (subscription: {
            topic: string;
            fromBeginning: boolean;
          }) => {
            subscriptions.push(subscription);
          },
          run: async () => {},
          disconnect: async () => {},
        } as unknown as Consumer;
      },
    });
  const stopA = start("pod-a");
  const stopB = start("pod-b");
  try {
    for (
      let i = 0;
      i < 50 && (groups.length < 2 || subscriptions.length < 2);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(groups.length, 2);
    assert.notEqual(groups[0], groups[1]);
    assert.match(groups[0]!, /pod-a/);
    assert.match(groups[1]!, /pod-b/);
    assert.deepEqual(subscriptions, [
      { topic: "greenguard.platform.config.v1", fromBeginning: true },
      { topic: "greenguard.platform.config.v1", fromBeginning: true },
    ]);
  } finally {
    await Promise.all([stopA(), stopB()]);
  }
});

const T = "11111111-1111-4111-8111-111111111111";
const GLOBAL = "00000000-0000-4000-8000-000000000001";
const envelope = (
  tenant: string,
  scope: string,
  version: string,
  flags: object,
) => ({
  event_type: "flag.configuration_changed",
  schema_version: 1,
  tenant_id: tenant,
  aggregate_version: version,
  payload: { scope, config_version: version, flags },
});

async function harness(sendFails = false) {
  const store = new VersionedFlagStore(60_000);
  const sent: {
    topic: string;
    messages: { key: string; headers: Record<string, string>; value: string }[];
  }[] = [];
  let handler!: (m: unknown) => Promise<void>;
  const stop = startFlagFeed(store, ["127.0.0.1:1"], {
    createConsumer: () =>
      ({
        events: { CRASH: "consumer.crash" },
        on: () => () => {},
        connect: async () => {},
        subscribe: async () => {},
        run: async (o: { eachMessage: typeof handler }) => {
          handler = o.eachMessage;
        },
        disconnect: async () => {},
      }) as unknown as Consumer,
    createProducer: () => ({
      ...idleProducer(),
      send: async (record: (typeof sent)[number]) => {
        if (sendFails) throw new Error("broker down");
        sent.push(record);
        return [];
      },
    }),
  });
  for (let i = 0; i < 50 && !handler; i++)
    await new Promise((r) => setTimeout(r, 2));
  const deliver = (
    value: unknown,
    headers: Record<string, string> = {},
    offset = "0",
  ) =>
    handler({
      topic: "greenguard.platform.config.v1",
      partition: 0,
      message: {
        offset,
        value: Buffer.from(
          typeof value === "string" ? value : JSON.stringify(value),
        ),
        headers: Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k, Buffer.from(v)]),
        ),
      },
    });
  return { store, sent, deliver, stop };
}

test("poison flag event is quarantined and committed past; later kill switch applies", async () => {
  const { store, sent, deliver, stop } = await harness();
  try {
    await deliver(
      envelope(T, "tenant", "1", { "made.up": { value: true } }),
      {},
      "0",
    );
    await deliver("{not json", {}, "1");
    await deliver(
      envelope(T, "tenant", "1", {
        "notifications.optional_sends": { value: true },
      }),
      { tenant_id: GLOBAL },
      "2",
    );
    assert.equal(sent.length, 3);
    assert.equal(sent[0]!.topic, "greenguard.quarantine.v1");
    assert.equal(
      sent[0]!.messages[0]!.key,
      "greenguard.platform.config.v1:0:0",
    );
    assert.equal(sent[0]!.messages[0]!.headers.reason_code, "unknown_flag_key");
    assert.equal(sent[0]!.messages[0]!.headers.tenant_id, T);
    assert.equal(sent[1]!.messages[0]!.headers.reason_code, "bad_envelope");
    assert.equal(sent[1]!.messages[0]!.headers.tenant_id, "unknown");
    assert.equal(sent[2]!.messages[0]!.headers.reason_code, "key_mismatch");
    await deliver(
      envelope(GLOBAL, "global", "1", {
        "notifications.optional_sends": { value: false, locked: true },
      }),
      {},
      "3",
    );
    await deliver(
      envelope(T, "tenant", "1", {
        "notifications.optional_sends": { value: true },
      }),
      { tenant_id: T },
      "4",
    );
    assert.equal(
      store.resolve(T, "notifications.optional_sends", "boolean")?.value,
      false,
    );
  } finally {
    await stop();
  }
});

test("quarantine publish failure does not commit: the error propagates for redelivery", async () => {
  const { deliver, stop } = await harness(true);
  try {
    await assert.rejects(deliver("{not json"), /broker down/);
  } finally {
    await stop();
  }
});

test("optionalSendGate refresh bookkeeping is bounded", async () => {
  const store = new VersionedFlagStore(60_000);
  const gate = optionalSendGate(
    store,
    async (id) => ({ scope: "tenant", tenantId: id, version: 1, flags: {} }),
    () => 0,
    5,
  );
  for (let i = 0; i < 20; i++)
    await gate(`${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`);
  assert.ok(gate.trackedTenants() <= 6);
});
