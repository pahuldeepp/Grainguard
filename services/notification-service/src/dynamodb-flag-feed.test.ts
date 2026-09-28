import assert from "node:assert/strict";
import { test } from "node:test";
import type { Consumer, ProducerRecord } from "kafkajs";
import { startDynamoFlagFeed } from "./dynamodb-flag-feed.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const valid = (
  flags: object = { "notifications.optional_sends": { value: true } },
) =>
  JSON.stringify({
    event_type: "flag.configuration_changed",
    schema_version: 1,
    tenant_id: tenantId,
    aggregate_version: "4",
    payload: { scope: "tenant", config_version: "4", flags },
  });
const idleProducer = () => ({
  connect: async () => {},
  disconnect: async () => {},
  send: async () => [],
});

async function harness(
  apply: (change: { version: number }) => Promise<boolean>,
  send: (record: ProducerRecord) => Promise<unknown> = async () => [],
) {
  let messageHandler: ((message: unknown) => Promise<void>) | undefined;
  const sent: ProducerRecord[] = [];
  const stop = startDynamoFlagFeed({ apply: apply as never }, ["127.0.0.1:1"], {
    createProducer: () => ({
      ...idleProducer(),
      send: async (record) => {
        await send(record);
        sent.push(record);
        return [];
      },
    }),
    createConsumer: () =>
      ({
        connect: async () => {},
        subscribe: async () => {},
        events: { CRASH: "consumer.crash" },
        on: () => () => {},
        run: async (options: {
          eachMessage?: (message: unknown) => Promise<void>;
        }) => {
          messageHandler = options.eachMessage;
        },
        disconnect: async () => {},
      }) as unknown as Consumer,
  });
  for (let i = 0; i < 50 && !messageHandler; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(messageHandler);
  return { messageHandler, sent, stop };
}

const source = (value: string, offset = "8") => ({
  topic: "greenguard.platform.config.v1",
  partition: 2,
  message: { offset, value: Buffer.from(value) },
});

test("DynamoDB flag feed awaits persistence before Kafka message completion", async () => {
  const order: string[] = [];
  const { messageHandler, stop } = await harness(async (change) => {
    order.push(`persist-start:${change.version}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`persist-done:${change.version}`);
    return true;
  });
  try {
    await messageHandler(source(valid()));
    order.push("message-complete");
    assert.deepEqual(order, [
      "persist-start:4",
      "persist-done:4",
      "message-complete",
    ]);
  } finally {
    await stop();
  }
});

test("malformed JSON is bounded, source-addressable quarantine and completes successfully", async () => {
  const { messageHandler, sent, stop } = await harness(async () => true);
  try {
    await messageHandler(source("{".repeat(70_000), "42"));
    assert.equal(sent.length, 1);
    const record = sent[0]!;
    assert.equal(record.topic, "greenguard.quarantine.v1");
    assert.equal(record.messages[0]!.key, "greenguard.platform.config.v1:2:42");
    assert.equal(record.messages[0]!.headers?.reason_code, "bad_envelope");
    const body = JSON.parse(String(record.messages[0]!.value)) as Record<
      string,
      unknown
    >;
    assert.equal(body.source_topic, "greenguard.platform.config.v1");
    assert.equal(body.source_partition, 2);
    assert.equal(body.source_offset, "42");
    assert.equal(Buffer.from(String(body.raw_base64), "base64").length, 65_536);
    assert.equal(body.truncated, true);
  } finally {
    await stop();
  }
});

test("poison flag event is quarantined then acknowledged", async () => {
  const { messageHandler, sent, stop } = await harness(async () =>
    assert.fail("poison must not reach DynamoDB"),
  );
  try {
    await messageHandler(source(valid({ "not.registered": { value: true } })));
    assert.equal(sent.length, 1);
    assert.equal(
      sent[0]!.messages[0]!.headers?.reason_code,
      "unknown_flag_key",
    );
    assert.equal(sent[0]!.messages[0]!.headers?.tenant_id, tenantId);
  } finally {
    await stop();
  }
});

test("DynamoDB persistence failure rejects the Kafka handler for retry", async () => {
  const { messageHandler, stop } = await harness(async () =>
    Promise.reject(new Error("DynamoDB unavailable")),
  );
  try {
    await assert.rejects(
      messageHandler(source(valid())),
      /DynamoDB unavailable/,
    );
  } finally {
    await stop();
  }
});

test("quarantine publish failure rejects the Kafka handler for retry", async () => {
  const { messageHandler, stop } = await harness(
    async () => true,
    async () => {
      throw new Error("Kafka quarantine unavailable");
    },
  );
  try {
    await assert.rejects(
      messageHandler(source("{")),
      /Kafka quarantine unavailable/,
    );
  } finally {
    await stop();
  }
});

test("non-restartable DynamoDB crash marks unavailable and redelivers on the shared group", async () => {
  let attempt = 0;
  let unavailable = 0;
  const handlers: Array<(message: unknown) => Promise<void>> = [];
  const crashes: Array<(restart: boolean) => void> = [];
  const applied: number[] = [];
  const stop = startDynamoFlagFeed(
    {
      apply: async (change: { version: number }) => {
        applied.push(change.version);
        if (applied.length === 1) throw new Error("temporary DynamoDB failure");
        return true;
      },
    } as never,
    ["unused:9092"],
    {
      retryMs: 5,
      groupId: "shared-durable-flags-group",
      onUnavailable: () => unavailable++,
      createProducer: () => idleProducer(),
      createConsumer: (groupId) => {
        assert.equal(groupId, "shared-durable-flags-group");
        const index = ++attempt;
        return {
          events: { CRASH: "consumer.crash" },
          async connect() {},
          async subscribe() {},
          on(
            _event: string,
            listener: (event: { payload: { restart: boolean } }) => void,
          ) {
            crashes[index - 1] = (restart) =>
              listener({ payload: { restart } });
            return () => {};
          },
          async run(options: {
            eachMessage: (message: unknown) => Promise<void>;
          }) {
            handlers[index - 1] = options.eachMessage;
          },
          async disconnect() {},
        } as unknown as Consumer;
      },
    },
  );
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 1_000;
    while (!check() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(check());
  };
  try {
    await waitFor(() => !!handlers[0]);
    await assert.rejects(
      handlers[0]!(source(valid(), "17")),
      /temporary DynamoDB failure/,
    );
    // KafkaJS emits this after a non-restartable eachMessage exception. The
    // source offset remains uncommitted; the replacement in the same group
    // receives exactly the same record.
    crashes[0]!(false);
    await waitFor(() => !!handlers[1]);
    assert.equal(unavailable, 1);
    assert.equal(attempt, 2);
    crashes[0]!(false); // callbacks from a displaced consumer cannot disrupt its replacement
    await new Promise((resolve) => setTimeout(resolve, 8));
    assert.equal(attempt, 2);
    assert.equal(unavailable, 1);
    await handlers[1]!(source(valid(), "17"));
    assert.deepEqual(applied, [4, 4]);
    assert.equal(unavailable, 1);
  } finally {
    await stop();
  }
});

test("restart=true, stale crash callbacks, and stop during restart timer never create another consumer", async () => {
  let created = 0;
  let unavailable = 0;
  let disconnects = 0;
  const crashes: Array<(restart: boolean) => void> = [];
  const stop = startDynamoFlagFeed(
    { apply: async () => true } as never,
    ["unused:9092"],
    {
      retryMs: 50,
      onUnavailable: () => unavailable++,
      createProducer: () => idleProducer(),
      createConsumer: () => {
        const index = ++created;
        return {
          events: { CRASH: "consumer.crash" },
          async connect() {},
          async subscribe() {},
          async run() {},
          async disconnect() {
            disconnects++;
          },
          on(
            _event: string,
            listener: (event: { payload: { restart: boolean } }) => void,
          ) {
            crashes[index - 1] = (restart) =>
              listener({ payload: { restart } });
            return () => {};
          },
        } as unknown as Consumer;
      },
    },
  );
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 1_000;
    while (!check() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(check());
  };
  await waitFor(() => created === 1 && !!crashes[0]);
  crashes[0]!(true);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(unavailable, 0);
  crashes[0]!(false);
  crashes[0]!(false); // duplicate crash event cannot schedule another retry
  assert.equal(unavailable, 1);
  await stop(); // cancels retry and disconnects the failed consumer
  crashes[0]!(false); // stale callback after stop is inert
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(created, 1);
  assert.equal(unavailable, 1);
  assert.ok(disconnects >= 1);
});

test("producer disconnect still runs when consumer disconnect fails during stop", async () => {
  const order: string[] = [];
  let connected!: () => void;
  const running = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const stop = startDynamoFlagFeed(
    { apply: async () => true } as never,
    ["unused:9092"],
    {
      createProducer: () => ({
        ...idleProducer(),
        async disconnect() {
          order.push("producer");
        },
      }),
      createConsumer: () =>
        ({
          events: { CRASH: "consumer.crash" },
          async connect() {},
          async subscribe() {},
          async run() {
            connected();
          },
          async disconnect() {
            order.push("consumer");
            throw new Error("consumer disconnect failed");
          },
          on: () => () => {},
        }) as unknown as Consumer,
    },
  );
  await running;
  await assert.doesNotReject(stop());
  assert.deepEqual(order, ["consumer", "producer"]);
});
