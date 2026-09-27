import assert from "node:assert/strict";
import { test } from "node:test";
import type { Consumer } from "kafkajs";
import { VersionedFlagStore } from "@greenguard/feature-flags";
import { notificationInstanceId, startFlagFeed } from "./flag-feed.js";
import { optionalSendGate } from "./flags.js";

test("flag feed retries initial outage and applies queued version on recovery", async () => {
  const store = new VersionedFlagStore(60_000);
  const tenantId = "11111111-1111-4111-8111-111111111111";
  let calls = 0;
  let failures = 0;
  const stop = startFlagFeed(store, ["127.0.0.1:1"], {
    retryMs: 2,
    onUnavailable: () => failures++,
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
  const autoCommitSettings: boolean[] = [];
  const start = (instanceId: string) =>
    startFlagFeed(new VersionedFlagStore(60_000), ["127.0.0.1:1"], {
      instanceId,
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
          run: async (options: { autoCommit?: boolean }) => {
            autoCommitSettings.push(options.autoCommit ?? true);
          },
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
    assert.deepEqual(autoCommitSettings, [false, false]);
  } finally {
    await Promise.all([stopA(), stopB()]);
  }
});

test("notification flag consumers keep a stable ID per replica when available", () => {
  assert.equal(
    notificationInstanceId({
      NOTIFICATION_INSTANCE_ID: " replica-a ",
      HOSTNAME: "host-a",
    }),
    "replica-a",
  );
  assert.equal(notificationInstanceId({ HOSTNAME: "host-a" }), "host-a");
  assert.match(notificationInstanceId({}), /^[0-9a-f-]{36}$/);
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

async function harness() {
  const store = new VersionedFlagStore(60_000);
  const poisonReasons: string[] = [];
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
    onPoison: (reason) => poisonReasons.push(reason),
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
  return { store, poisonReasons, deliver, stop };
}

test("poison flag event is counted and skipped locally; later kill switch applies", async () => {
  const { store, poisonReasons, deliver, stop } = await harness();
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
    assert.deepEqual(poisonReasons, [
      "unknown_flag_key",
      "bad_envelope",
      "key_mismatch",
    ]);
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
