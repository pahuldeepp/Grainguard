import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import kafkaJs from "kafkajs";
import { SchemaRegistry, SchemaType } from "@kafkajs/confluent-schema-registry";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import test from "node:test";
import {
  CONTACTS_CDC_TOPICS,
  CONTACTS_FEED_CHECKPOINT,
  createContactsProjectorMetrics,
  createDynamoContactsProjectionStore,
  parseDebeziumContact,
  startContactsProjector,
} from "./contacts-cdc.js";

const live = process.env.CONTACTS_CDC_LIVE === "1";
const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:28000";
const brokers = (process.env.KAFKA_BROKERS ?? "127.0.0.1:59092").split(",");
const { Kafka } = kafkaJs;

async function ensureTable(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "ResourceNotFoundException"
    ))
      throw error;
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "tenant_id", AttributeType: "S" },
          { AttributeName: "record_key", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "tenant_id", KeyType: "HASH" },
          { AttributeName: "record_key", KeyType: "RANGE" },
        ],
      }),
    );
  }
  await waitUntilTableExists(
    { client, maxWaitTime: 30 },
    { TableName: tableName },
  );
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function readRealDebeziumContact(
  kafka: InstanceType<typeof Kafka>,
  registry: SchemaRegistry,
) {
  const consumer = kafka.consumer({
    groupId: `greenguard-contact-source-inspect-${randomUUID()}`,
  });
  await consumer.connect();
  await consumer.subscribe({
    topic: CONTACTS_CDC_TOPICS.contacts,
    fromBeginning: true,
  });
  try {
    let resolveRecord!: (
      value: ReturnType<typeof parseDebeziumContact>,
    ) => void;
    let rejectRecord!: (error: Error) => void;
    const found = new Promise<ReturnType<typeof parseDebeziumContact>>(
      (resolve, reject) => {
        resolveRecord = resolve;
        rejectRecord = reject;
      },
    );
    const timer = setTimeout(
      () =>
        rejectRecord(new Error("no Debezium contact snapshot row available")),
      15_000,
    );
    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value || !message.key) return;
        try {
          resolveRecord(
            parseDebeziumContact(
              await registry.decode(message.value),
              message.key,
            ),
          );
        } catch (error) {
          rejectRecord(
            error instanceof Error
              ? error
              : new Error("Debezium contact decode failed"),
          );
        }
      },
    });
    try {
      return await found;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await consumer.disconnect();
  }
}

function contactEvent(
  tenantId: string,
  version: string,
  email: string | null,
  sms: string | null,
) {
  return {
    schema_version: "1",
    tenant_id: tenantId,
    email_to: email,
    sms_to: sms,
    version,
    __op: "u",
    __source_ts_ms: Date.now(),
    __deleted: null,
  };
}

test(
  "live Kafka CDC contact rows project monotonically to DynamoDB and survive projector restart",
  { skip: !live },
  async () => {
    const tableName = `greenguard_contacts_cdc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ddb = new DynamoDBClient({
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    const dynamoStore = createDynamoContactsProjectionStore({
      tableName,
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      localCredentials: true,
    });
    const kafka = new Kafka({
      clientId: `greenguard-contact-cdc-live-${randomUUID()}`,
      brokers,
    });
    const producer = kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
    });
    const tenant = randomUUID();
    const group = `greenguard-contact-cdc-live-${randomUUID()}`;
    const metrics = createContactsProjectorMetrics();
    const registry = new SchemaRegistry({
      host: process.env.SCHEMA_REGISTRY_URL ?? "http://127.0.0.1:58081",
    });
    const avroSchema = JSON.stringify({
      type: "record",
      name: "NotificationContactsCdcV1",
      namespace: "io.greenguard.notifications",
      fields: [
        { name: "schema_version", type: "string" },
        { name: "tenant_id", type: "string" },
        { name: "email_to", type: ["null", "string"], default: null },
        { name: "sms_to", type: ["null", "string"], default: null },
        { name: "version", type: "string" },
        { name: "__op", type: "string" },
        { name: "__source_ts_ms", type: ["null", "long"], default: null },
        { name: "__deleted", type: ["null", "string"], default: null },
      ],
    });
    const { id: schemaId } = await registry.register(
      { type: SchemaType.AVRO, schema: avroSchema },
      { subject: `greenguard-contact-cdc-live-${randomUUID()}-value` },
    );
    let stop = async () => {};
    try {
      await ensureTable(ddb, tableName);
      await producer.connect();
      stop = startContactsProjector(dynamoStore, brokers, metrics, {
        groupId: group,
        registry,
      });
      const send = async (
        version: string,
        email: string | null,
        sms: string | null,
      ) =>
        producer.send({
          topic: CONTACTS_CDC_TOPICS.contacts,
          messages: [
            {
              key: JSON.stringify({ tenant_id: tenant }),
              value: await registry.encode(
                schemaId,
                contactEvent(tenant, version, email, sms),
              ),
            },
          ],
        });
      const get = async () =>
        ddb.send(
          new GetItemCommand({
            TableName: tableName,
            Key: { tenant_id: { S: tenant }, record_key: { S: "CONTACTS" } },
            ConsistentRead: true,
          }),
        );

      await send("1", "first@example.test", "+12045550123");
      await waitFor(
        async () => (await get()).Item?.version?.N === "1",
        "initial contact snapshot",
      );
      await stop();
      stop = async () => {};

      await send("3", "current@example.test", null);
      await send("2", "stale@example.test", "+12045550123");
      stop = startContactsProjector(dynamoStore, brokers, metrics, {
        groupId: group,
        registry,
      });
      await waitFor(
        async () => (await get()).Item?.version?.N === "3",
        "post-restart CDC catch-up",
      );
      const current = await get();
      assert.equal(current.Item?.email?.S, "current@example.test");
      assert.equal(current.Item?.sms?.NULL, true);
      assert.equal(current.Item?.version?.N, "3");
      assert.ok(metrics.applied >= 2);
      assert.ok(metrics.stale >= 1);
    } finally {
      await stop().catch(() => {});
      await producer.disconnect().catch(() => {});
      dynamoStore.close();
      await ddb
        .send(new DeleteTableCommand({ TableName: tableName }))
        .catch(() => {});
      ddb.destroy();
    }
  },
);

test(
  "live projector restarts after transient DynamoDB failure and reapplies the uncommitted Kafka record",
  { skip: !live },
  async () => {
    const tableName = `greenguard_contacts_recovery_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ddb = new DynamoDBClient({
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    const store = createDynamoContactsProjectionStore({
      tableName,
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      localCredentials: true,
    });
    const kafka = new Kafka({
      clientId: `greenguard-contact-recovery-${randomUUID()}`,
      brokers,
    });
    const producer = kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
    });
    const registry = new SchemaRegistry({
      host: process.env.SCHEMA_REGISTRY_URL ?? "http://127.0.0.1:58081",
    });
    const tenant = randomUUID();
    const group = `greenguard-contact-recovery-${randomUUID()}`;
    const metrics = createContactsProjectorMetrics();
    const { id: schemaId } = await registry.register(
      {
        type: SchemaType.AVRO,
        schema: JSON.stringify({
          type: "record",
          name: "NotificationContactsRecoveryV1",
          namespace: "io.greenguard.notifications",
          fields: [
            { name: "schema_version", type: "string" },
            { name: "tenant_id", type: "string" },
            { name: "email_to", type: ["null", "string"], default: null },
            { name: "sms_to", type: ["null", "string"], default: null },
            { name: "version", type: "string" },
            { name: "__op", type: "string" },
            { name: "__source_ts_ms", type: ["null", "long"], default: null },
            { name: "__deleted", type: ["null", "string"], default: null },
          ],
        }),
      },
      { subject: `greenguard-contact-recovery-${randomUUID()}-value` },
    );
    let attempts = 0;
    let unavailable = 0;
    const flakyStore = {
      checkpoint: (time: number) => store.checkpoint(time),
      async apply(contact: Parameters<typeof store.apply>[0]) {
        if (contact.tenant_id === tenant) {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error(
              "simulated DynamoDB throttling",
            ) as Error & { retriable: boolean };
            // AWS SDK service exceptions are not necessarily marked retriable by
            // KafkaJS; this reproduces CRASH(restart=false) rather than its own retry.
            error.retriable = false;
            throw error;
          }
        }
        return store.apply(contact);
      },
    };
    let stop = async () => {};
    try {
      await ensureTable(ddb, tableName);
      await producer.connect();
      stop = startContactsProjector(flakyStore, brokers, metrics, {
        groupId: group,
        registry,
        retryMs: 150,
        onUnavailable: () => {
          unavailable += 1;
        },
      });
      const value = await registry.encode(
        schemaId,
        contactEvent(tenant, "1", "recovered@example.test", null),
      );
      await producer.send({
        topic: CONTACTS_CDC_TOPICS.contacts,
        messages: [{ key: JSON.stringify({ tenant_id: tenant }), value }],
      });
      await waitFor(
        async () => {
          const row = (
            await ddb.send(
              new GetItemCommand({
                TableName: tableName,
                Key: {
                  tenant_id: { S: tenant },
                  record_key: { S: "CONTACTS" },
                },
                ConsistentRead: true,
              }),
            )
          ).Item;
          return row?.version?.N === "1" && attempts >= 2 && metrics.available;
        },
        "same uncommitted Kafka record applied after transient DynamoDB failure",
        20_000,
      );
      assert.equal(attempts, 2);
      assert.equal(metrics.failures, 1);
      assert.equal(metrics.consumerRestarts, 1);
      assert.ok(unavailable >= 1);
      assert.match(
        metrics.render(),
        /greenguard_notification_contacts_projector_available 1/,
      );
    } finally {
      await stop().catch(() => {});
      await producer.disconnect().catch(() => {});
      store.close();
      await ddb
        .send(new DeleteTableCommand({ TableName: tableName }))
        .catch(() => {});
      ddb.destroy();
    }
  },
);

test(
  "live Debezium Avro snapshot row and heartbeat project through Schema Registry into DynamoDB",
  { skip: !live },
  async () => {
    const tableName = `greenguard_contacts_cdc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ddb = new DynamoDBClient({
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    const store = createDynamoContactsProjectionStore({
      tableName,
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      localCredentials: true,
    });
    const kafka = new Kafka({
      clientId: `greenguard-contact-contract-live-${randomUUID()}`,
      brokers,
    });
    const registryUrl =
      process.env.SCHEMA_REGISTRY_URL ?? "http://127.0.0.1:58081";
    const registry = new SchemaRegistry({ host: registryUrl });
    const metrics = createContactsProjectorMetrics();
    let stop = async () => {};
    try {
      await ensureTable(ddb, tableName);
      const source = await readRealDebeziumContact(kafka, registry);
      stop = startContactsProjector(store, brokers, metrics, {
        groupId: `greenguard-contact-contract-projector-${randomUUID()}`,
        schemaRegistryUrl: registryUrl,
      });
      const get = () =>
        ddb.send(
          new GetItemCommand({
            TableName: tableName,
            Key: {
              tenant_id: { S: source.contact.tenant_id },
              record_key: { S: "CONTACTS" },
            },
            ConsistentRead: true,
          }),
        );
      await waitFor(async () => {
        const item = (await get()).Item;
        return (
          !!item?.version?.N && BigInt(item.version.N) >= source.contact.version
        );
      }, "real Debezium contact row in DynamoDB");
      assert.ok(metrics.applied > 0);

      // Replay can contain an old heartbeat, so require a source timestamp emitted
      // after this test started. The connector emits the source heartbeat every 30s.
      const liveStartedAt = Date.now();
      await waitFor(
        async () =>
          metrics.heartbeatAtMs !== undefined &&
          metrics.heartbeatAtMs >= liveStartedAt &&
          metrics.heartbeatAgeSeconds() <= 10,
        "fresh real Debezium heartbeat",
        65_000,
      );
      const checkpoint = await ddb.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            tenant_id: { S: CONTACTS_FEED_CHECKPOINT.tenant_id },
            record_key: { S: CONTACTS_FEED_CHECKPOINT.record_key },
          },
          ConsistentRead: true,
        }),
      );
      assert.ok(Number(checkpoint.Item?.source_time_ms?.N) >= liveStartedAt);
    } finally {
      await stop().catch(() => {});
      store.close();
      await ddb
        .send(new DeleteTableCommand({ TableName: tableName }))
        .catch(() => {});
      ddb.destroy();
    }
  },
);

test(
  "live DynamoDB feed checkpoint stays monotonic through duplicate and older heartbeat replay",
  { skip: !live },
  async () => {
    const tableName = `greenguard_contacts_checkpoint_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ddb = new DynamoDBClient({
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    const store = createDynamoContactsProjectionStore({
      tableName,
      endpoint,
      localCredentials: true,
    });
    try {
      await ensureTable(ddb, tableName);
      await store.checkpoint(1_750_000_005_000);
      await store.checkpoint(1_750_000_005_000);
      await store.checkpoint(1_750_000_000_000);
      const get = () =>
        ddb.send(
          new GetItemCommand({
            TableName: tableName,
            Key: {
              tenant_id: { S: CONTACTS_FEED_CHECKPOINT.tenant_id },
              record_key: { S: CONTACTS_FEED_CHECKPOINT.record_key },
            },
            ConsistentRead: true,
          }),
        );
      assert.equal((await get()).Item?.source_time_ms?.N, "1750000005000");
      await store.checkpoint(1_750_000_006_000);
      assert.equal((await get()).Item?.source_time_ms?.N, "1750000006000");
    } finally {
      store.close();
      await ddb
        .send(new DeleteTableCommand({ TableName: tableName }))
        .catch(() => {});
      ddb.destroy();
    }
  },
);

test(
  "live crash after DynamoDB apply but before offset commit replays as an idempotent no-op",
  { skip: !live },
  async () => {
    const tableName = `greenguard_contacts_commit_crash_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ddb = new DynamoDBClient({
      endpoint,
      region: process.env.AWS_REGION ?? "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    const store = createDynamoContactsProjectionStore({
      tableName,
      endpoint,
      localCredentials: true,
    });
    const kafka = new Kafka({
      clientId: `greenguard-contact-commit-crash-${randomUUID()}`,
      brokers,
    });
    const producer = kafka.producer({
      allowAutoTopicCreation: false,
      idempotent: true,
    });
    const registry = new SchemaRegistry({
      host: process.env.SCHEMA_REGISTRY_URL ?? "http://127.0.0.1:58081",
    });
    const tenant = randomUUID();
    const groupId = `greenguard-contact-commit-crash-${randomUUID()}`;
    const metrics = createContactsProjectorMetrics();
    const results: Array<"applied" | "stale"> = [];
    let stop = async () => {};
    let crashed = false;
    try {
      await ensureTable(ddb, tableName);
      await producer.connect();
      const schemaId = await registry.getLatestSchemaId(
        `${CONTACTS_CDC_TOPICS.contacts}-value`,
      );
      const sent = await producer.send({
        topic: CONTACTS_CDC_TOPICS.contacts,
        messages: [
          {
            key: JSON.stringify({ tenant_id: tenant }),
            value: await registry.encode(
              schemaId,
              contactEvent(tenant, "19", "once@example.test", null),
            ),
          },
        ],
      });
      const source = sent[0];
      assert.ok(source?.baseOffset);
      const committedOffset = (BigInt(source.baseOffset) + 1n).toString();
      stop = startContactsProjector(
        {
          checkpoint: (time) => store.checkpoint(time),
          async apply(contact) {
            const result = await store.apply(contact);
            if (contact.tenant_id === tenant) results.push(result);
            return result;
          },
        },
        brokers,
        metrics,
        {
          registry,
          groupId,
          retryMs: 100,
          createConsumer: () => {
            const consumer = kafka.consumer({ groupId });
            const commit = consumer.commitOffsets.bind(consumer);
            consumer.commitOffsets = async (offsets) => {
              if (
                !crashed &&
                offsets.some(
                  (offset) =>
                    offset.topic === CONTACTS_CDC_TOPICS.contacts &&
                    offset.partition === source.partition &&
                    offset.offset === committedOffset,
                )
              ) {
                assert.deepEqual(results, ["applied"]);
                crashed = true;
                // Fail only after the real DDB write. Kafka's group offset is still
                // uncommitted; the replacement consumer must replay this same row.
                throw Object.assign(
                  new Error("simulated process failure before Kafka commit"),
                  { retriable: false },
                );
              }
              await commit(offsets);
            };
            return consumer;
          },
        },
      );
      await waitFor(
        async () => crashed && results.length >= 2 && metrics.available,
        "post-apply uncommitted row redelivery",
        20_000,
      );
      assert.deepEqual(results, ["applied", "stale"]);
      assert.ok(metrics.consumerRestarts >= 1);
      const row = (
        await ddb.send(
          new GetItemCommand({
            TableName: tableName,
            Key: { tenant_id: { S: tenant }, record_key: { S: "CONTACTS" } },
            ConsistentRead: true,
          }),
        )
      ).Item;
      assert.equal(row?.version?.N, "19");
      assert.equal(row?.email?.S, "once@example.test");
    } finally {
      await stop().catch(() => {});
      await producer.disconnect().catch(() => {});
      store.close();
      await ddb
        .send(new DeleteTableCommand({ TableName: tableName }))
        .catch(() => {});
      ddb.destroy();
    }
  },
);
