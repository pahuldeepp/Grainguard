import assert from "node:assert/strict";
import test from "node:test";
import { rootCertificates } from "node:tls";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Consumer, Producer } from "kafkajs";
import { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CONTACTS_CDC_TOPICS,
  CONTACTS_FEED_CHECKPOINT,
  contactsProjectorReady,
  contactsRegistryConfig,
  decodeContactsWire,
  startContactsProjector,
  DynamoContactsProjectionStore,
  InvalidContactCdcEvent,
  createContactsProjectorMetrics,
  handleContactsCdcMessage,
  isContactHeartbeat,
  parseDebeziumContact,
  type ContactsProjectionStore,
  type NotificationContact,
} from "./contacts-cdc.js";

test("Schema Registry uses verified HTTPS and Basic auth in AWS profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-ca-"));
  const caFile = join(dir, "ca.crt");
  writeFileSync(caFile, rootCertificates[0]!);
  const values: Record<string, string> = {
    KAFKA_REQUIRE_TLS: "true",
    SCHEMA_REGISTRY_USERNAME: "registry-user",
    SCHEMA_REGISTRY_PASSWORD: "secret",
    SCHEMA_REGISTRY_TLS_CA_FILE: caFile,
  };
  const env = (key: string) => values[key];
  try {
    assert.throws(
      () => contactsRegistryConfig("http://registry:8081", env),
      /requires HTTPS/,
    );
    const config = contactsRegistryConfig("https://registry:8081", env);
    assert.deepEqual(config.auth, {
      username: "registry-user",
      password: "secret",
    });
    assert.ok(config.agent);
    assert.equal(
      (config.agent as { options?: { minVersion?: string } }).options
        ?.minVersion,
      "TLSv1.2",
    );
    assert.deepEqual(
      contactsRegistryConfig("http://localhost:8081", () => undefined),
      { host: "http://localhost:8081" },
    );
    assert.throws(
      () =>
        contactsRegistryConfig("https://registry:8081", (key) =>
          key === "KAFKA_REQUIRE_TLS" ? "true" : undefined,
        ),
      /requires HTTPS/,
    );
    writeFileSync(caFile, "not a certificate");
    assert.throws(() => contactsRegistryConfig("https://registry:8081", env));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tenantA = "8a8b5bb6-cc18-4f31-966b-6931d24d95df";
const tenantB = "3925f2f9-3f87-46b5-a43a-3f59a1ca57bb";
const key = (tenantId = tenantA) =>
  Buffer.from(JSON.stringify({ tenant_id: tenantId }));
const event = (
  options: {
    tenantId?: string;
    version?: string;
    email?: string | null;
    sms?: string | null;
    op?: string;
  } = {},
) =>
  JSON.stringify({
    tenant_id: options.tenantId ?? tenantA,
    email_to:
      options.email === undefined ? "alerts@example.test" : options.email,
    sms_to: options.sms === undefined ? "+12045550123" : options.sms,
    version: options.version ?? "7",
    schema_version: "1",
    __op: options.op ?? "u",
    __source_ts_ms: 1_750_000_000_000,
  });

function message(topic: string, raw: string, k: Buffer | null = key()) {
  return {
    topic,
    partition: 3,
    message: {
      key: k,
      value: Buffer.from(raw),
      offset: "52",
      timestamp: "1750000000001",
    },
  };
}

function producer(send: Producer["send"] = async () => []) {
  return { send };
}

test("preserves int64 BIGINT versions beyond JavaScript safe integer and validates tenant key", () => {
  const decoded = parseDebeziumContact(
    event({ version: "9223372036854775806" }),
    key(),
  );
  assert.equal(decoded.contact.version, 9_223_372_036_854_775_806n);
  assert.equal(decoded.contact.tenant_id, tenantA);
  assert.equal(decoded.sourceTimeMs, 1_750_000_000_000);
  assert.throws(
    () => parseDebeziumContact(event({ tenantId: tenantA }), key(tenantB)),
    (error: unknown) =>
      error instanceof InvalidContactCdcEvent &&
      error.reason === "key_tenant_mismatch",
  );
});

test("rejects unsafe, invalid and hard-delete CDC records; channel clears remain versioned nulls", () => {
  assert.throws(
    () => parseDebeziumContact(event({ version: "0" }), key()),
    /invalid_version/,
  );
  assert.throws(
    () =>
      parseDebeziumContact(event({ version: "9223372036854775808" }), key()),
    /invalid_version/,
  );
  assert.throws(
    () => parseDebeziumContact(event({ op: "d" }), key()),
    /hard_delete_requires_versioned_clear/,
  );
  assert.throws(
    () =>
      parseDebeziumContact(
        JSON.stringify({ ...JSON.parse(event()), schema_version: "2" }),
        key(),
      ),
    /unsupported_schema_version/,
  );
  const cleared = parseDebeziumContact(
    event({ email: null, sms: null, version: "8" }),
    key(),
  );
  assert.equal(cleared.contact.email, null);
  assert.equal(cleared.contact.sms, null);
  assert.equal(cleared.contact.version, 8n);
});

test("accepts only the expected transactional Postgres heartbeat and exposes stale age", () => {
  const heartbeat = {
    prefix: "greenguard.notification-contacts-feed",
    content: Buffer.from("checkpoint"),
    __source_ts_ms: "1750000000000",
  };
  assert.equal(isContactHeartbeat(heartbeat), 1_750_000_000_000);
  assert.throws(
    () =>
      isContactHeartbeat({
        op: "m",
        after: { prefix: "other" },
        source: { ts_ms: 1 },
      }),
    /invalid_heartbeat/,
  );
  assert.throws(
    () =>
      isContactHeartbeat({
        prefix: "greenguard.notification-contacts-feed",
        content: Buffer.from("checkpoint"),
        __source_ts_ms: "9007199254740992",
      }),
    /invalid_heartbeat_time/,
  );
  const metrics = createContactsProjectorMetrics();
  assert.equal(metrics.heartbeatAgeSeconds(2_000), Number.POSITIVE_INFINITY);
  metrics.heartbeatAtMs = 500;
  assert.equal(metrics.heartbeatAgeSeconds(32_000), 31.5);
  assert.match(
    metrics.render(32_000),
    /greenguard_notification_contacts_heartbeat_age_seconds 31\.5/,
  );
});

test("projects contact events, ignores duplicate/stale versions, and keeps metrics tenant-free", async () => {
  const stored = new Map<string, bigint>();
  const store: ContactsProjectionStore = {
    async apply(contact: NotificationContact) {
      const current = stored.get(contact.tenant_id) ?? 0n;
      if (contact.version <= current) return "stale";
      stored.set(contact.tenant_id, contact.version);
      return "applied";
    },
  };
  const metrics = createContactsProjectorMetrics();
  const dlq = producer();
  const payload = message(
    CONTACTS_CDC_TOPICS.contacts,
    event({ version: "10" }),
  );
  await handleContactsCdcMessage(
    store,
    dlq,
    metrics,
    payload,
    () => 1_750_000_005_000,
  );
  await handleContactsCdcMessage(
    store,
    dlq,
    metrics,
    payload,
    () => 1_750_000_005_000,
  );
  await handleContactsCdcMessage(
    store,
    dlq,
    metrics,
    message(CONTACTS_CDC_TOPICS.contacts, event({ version: "9" })),
    () => 1_750_000_005_000,
  );
  assert.equal(stored.get(tenantA), 10n);
  assert.equal(metrics.applied, 1);
  assert.equal(metrics.stale, 2);
  assert.equal(metrics.sourceToApplyLagSeconds, 5);
  assert.doesNotMatch(metrics.render(), new RegExp(tenantA));
});

test("invalid events are quarantined before acknowledgment without PII in headers", async () => {
  const metrics = createContactsProjectorMetrics();
  let dlqRecord: Parameters<Producer["send"]>[0] | undefined;
  const dlq = producer(async (request) => {
    dlqRecord = request;
    return [];
  });
  await handleContactsCdcMessage(
    {
      async apply() {
        throw new Error("must not project invalid event");
      },
    },
    dlq,
    metrics,
    message(
      CONTACTS_CDC_TOPICS.contacts,
      event({ tenantId: tenantA }),
      key(tenantB),
    ),
  );
  assert.equal(metrics.quarantined, 1);
  assert.ok(dlqRecord);
  assert.equal(dlqRecord.topic, CONTACTS_CDC_TOPICS.dlq);
  const record = dlqRecord.messages[0];
  assert.ok(record);
  assert.equal(record.headers?.reason_code, "key_tenant_mismatch");
  assert.equal(record.headers?.tenant_id, undefined);
  assert.ok(record.value);
  assert.match(record.value.toString(), /raw_base64/);
  assert.doesNotMatch(JSON.stringify(record.headers), /alerts@example/);
});

test("failed DLQ publish or transient DynamoDB failure propagates so Kafka offset stays uncommitted", async () => {
  const metrics = createContactsProjectorMetrics();
  await assert.rejects(
    handleContactsCdcMessage(
      {
        async apply() {
          throw new Error("unused");
        },
      },
      producer(async () => {
        throw new Error("broker unavailable");
      }),
      metrics,
      message(CONTACTS_CDC_TOPICS.contacts, "{broken"),
    ),
    /broker unavailable/,
  );
  await assert.rejects(
    handleContactsCdcMessage(
      {
        async apply() {
          throw new Error("DynamoDB throttled");
        },
      },
      producer(),
      metrics,
      message(CONTACTS_CDC_TOPICS.contacts, event()),
    ),
    /DynamoDB throttled/,
  );
  assert.equal(metrics.failures, 1);
});

test("DynamoDB store writes numeric exact versions with strict monotonic condition; conditional conflict is a no-op", async () => {
  const calls: PutCommand[] = [];
  const client = {
    async send(command: PutCommand) {
      calls.push(command);
      if (calls.length === 2) {
        const error = new Error("conditional conflict");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoContactsProjectionStore(client, "notification-state");
  const contact: NotificationContact = {
    tenant_id: tenantA,
    email: null,
    sms: null,
    version: 9_223_372_036_854_775_806n,
  };
  assert.equal(await store.apply(contact), "applied");
  assert.equal(await store.apply(contact), "stale");
  const command = calls[0];
  assert.ok(command);
  assert.ok(command.input.ConditionExpression);
  assert.match(command.input.ConditionExpression, /#version < :version/);
  assert.ok(command.input.Item);
  assert.equal(String(command.input.Item.version), "9223372036854775806");
  assert.equal(command.input.Item.email, null);
  assert.equal("Key" in command.input, false);
});

test("quarantine preserves malformed Avro bytes exactly and keeps exception text out of headers", async () => {
  const raw = Buffer.from([0, 255, 128, 254, 195, 40, 0, 239, 191]);
  let request: Parameters<Producer["send"]>[0] | undefined;
  const metrics = createContactsProjectorMetrics();
  await handleContactsCdcMessage(
    {
      async apply() {
        throw new Error("unused");
      },
    },
    producer(async (sent) => {
      request = sent;
      return [];
    }),
    metrics,
    {
      ...message(CONTACTS_CDC_TOPICS.contacts, ""),
      message: {
        ...message(CONTACTS_CDC_TOPICS.contacts, "").message,
        value: raw,
      },
    },
    Date.now,
    async () => {
      throw new InvalidContactCdcEvent("invalid_avro_payload");
    },
  );
  assert.ok(request?.messages[0]?.value);
  const body = JSON.parse(request.messages[0].value.toString()) as {
    raw_base64: string;
  };
  assert.deepEqual(Buffer.from(body.raw_base64, "base64"), raw);
  assert.equal(metrics.quarantined, 1);
  assert.doesNotMatch(
    JSON.stringify(request.messages[0].headers),
    /raw_base64/,
  );
});

function registrySchema(
  fromBuffer: (buffer: Buffer) => unknown,
): Awaited<ReturnType<SchemaRegistry["getSchema"]>> {
  return { fromBuffer, toBuffer: () => Buffer.alloc(0), isValid: () => true };
}

function wire(payload = Buffer.from([2])): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(1, 1);
  return Buffer.concat([header, payload]);
}

test("wire decoder quarantines permanent framing and Avro poison but retries Registry lookup failures", async () => {
  let lookups = 0;
  const registry = {
    async getSchema() {
      lookups += 1;
      return registrySchema(() => {
        throw new Error("PII could be in Avro error");
      });
    },
  };
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.from([0, 1]),
    Buffer.from([1, 0, 0, 0, 1]),
    Buffer.alloc(5),
  ])
    await assert.rejects(
      decodeContactsWire(registry, invalid),
      InvalidContactCdcEvent,
    );
  assert.equal(lookups, 0);
  await assert.rejects(
    decodeContactsWire(registry, wire()),
    (error: unknown) =>
      error instanceof InvalidContactCdcEvent &&
      error.reason === "invalid_avro_payload" &&
      !error.message.includes("PII"),
  );
  const outage = new Error("registry temporarily unavailable");
  await assert.rejects(
    decodeContactsWire(
      {
        async getSchema() {
          throw outage;
        },
      },
      wire(),
    ),
    (error) => error === outage,
  );
  const missing = Object.assign(new Error("schema temporarily missing"), {
    status: 404,
  });
  await assert.rejects(
    decodeContactsWire(
      {
        async getSchema() {
          throw missing;
        },
      },
      wire(),
    ),
    (error) => error === missing,
  );
  assert.deepEqual(
    await decodeContactsWire(
      {
        async getSchema() {
          return registrySchema(() => ({ schema_version: "1" }));
        },
      },
      wire(),
    ),
    { schema_version: "1" },
  );

  const metrics = createContactsProjectorMetrics();
  let published = 0;
  const dlq = producer(async () => {
    published += 1;
    return [];
  });
  const payload = {
    ...message(CONTACTS_CDC_TOPICS.contacts, ""),
    message: {
      ...message(CONTACTS_CDC_TOPICS.contacts, "").message,
      value: wire(),
    },
  };
  await handleContactsCdcMessage(
    {
      async apply() {
        throw new Error("unused");
      },
    },
    dlq,
    metrics,
    payload,
    Date.now,
    (value) => decodeContactsWire(registry, value),
  );
  assert.equal(published, 1);
  await assert.rejects(
    handleContactsCdcMessage(
      {
        async apply() {
          throw new Error("unused");
        },
      },
      dlq,
      metrics,
      payload,
      Date.now,
      (value) =>
        decodeContactsWire(
          {
            async getSchema() {
              throw outage;
            },
          },
          value,
        ),
    ),
    (error) => error === outage,
  );
  assert.equal(published, 1);
  assert.equal(metrics.failures, 1);
});

test("readiness requires both fresh heartbeat and an available consumer", () => {
  const metrics = createContactsProjectorMetrics();
  metrics.heartbeatAtMs = 1000;
  assert.equal(contactsProjectorReady(metrics, 1001), false);
  metrics.available = true;
  assert.equal(contactsProjectorReady(metrics, 1001), true);
  assert.equal(contactsProjectorReady(metrics, 62000), false);
});

test("DynamoDB feed heartbeat uses reserved key and monotonic condition; duplicates and replay are safe", async () => {
  let current = 0;
  const calls: PutCommand[] = [];
  const store = new DynamoContactsProjectionStore(
    {
      async send(command: PutCommand) {
        calls.push(command);
        const time = command.input.Item?.source_time_ms as number;
        if (time <= current)
          throw Object.assign(new Error("condition"), {
            name: "ConditionalCheckFailedException",
          });
        current = time;
        return {};
      },
    } as unknown as DynamoDBDocumentClient,
    "notification-state",
  );
  await store.checkpoint(2000);
  await store.checkpoint(2000);
  await store.checkpoint(1000);
  assert.equal(current, 2000);
  assert.deepEqual(calls[0]?.input.Item, {
    ...CONTACTS_FEED_CHECKPOINT,
    source_time_ms: 2000,
  });
  assert.equal(
    calls[0]?.input.ConditionExpression,
    "attribute_not_exists(#time) OR #time < :time",
  );
  await assert.rejects(
    store.apply({
      tenant_id: CONTACTS_FEED_CHECKPOINT.tenant_id,
      email: null,
      sms: null,
      version: 1n,
    }),
    /invalid tenant ID/,
  );
  await assert.rejects(store.checkpoint(Number.NaN), /invalid contact feed/);
  const unavailable = new DynamoContactsProjectionStore(
    {
      async send() {
        throw new Error("DDB outage");
      },
    } as unknown as DynamoDBDocumentClient,
    "notification-state",
  );
  await assert.rejects(unavailable.checkpoint(3000), /DDB outage/);
});

test("heartbeat is committed to the feed store before acknowledgment; replay never rewinds freshness", async () => {
  const metrics = createContactsProjectorMetrics();
  let durable = 0;
  const store = {
    async apply() {
      return "stale" as const;
    },
    async checkpoint(time: number) {
      durable = Math.max(time, durable);
    },
  };
  const heartbeat = (time: number) =>
    message(
      CONTACTS_CDC_TOPICS.heartbeat,
      JSON.stringify({
        prefix: "greenguard.notification-contacts-feed",
        content: "checkpoint",
        __source_ts_ms: String(time),
      }),
    );
  await handleContactsCdcMessage(store, producer(), metrics, heartbeat(3000));
  await handleContactsCdcMessage(store, producer(), metrics, heartbeat(2000));
  assert.equal(durable, 3000);
  assert.equal(metrics.heartbeatAtMs, 3000);
  await assert.rejects(
    handleContactsCdcMessage(
      {
        ...store,
        async checkpoint() {
          throw new Error("DDB outage");
        },
      },
      producer(),
      metrics,
      heartbeat(4000),
    ),
    /DDB outage/,
  );
  assert.equal(metrics.heartbeatAtMs, 3000);
});

test("initial connect failure recovers and later crash can schedule another recovery", async () => {
  let created = 0;
  let disconnected = 0;
  const crashes: Array<() => void> = [];
  const metrics = createContactsProjectorMetrics();
  const stop = startContactsProjector(
    {
      async apply() {
        return "stale";
      },
    },
    ["unused:9092"],
    metrics,
    {
      retryMs: 10,
      registry: new SchemaRegistry({ host: "http://unused:8081" }),
      createProducer: () => ({
        async connect() {},
        async disconnect() {},
        async send() {
          return [];
        },
      }),
      createConsumer: () => {
        const attempt = ++created;
        return {
          async connect() {
            if (attempt === 1) throw new Error("initial outage");
          },
          async disconnect() {
            disconnected += 1;
          },
          async subscribe() {},
          async run() {},
          async commitOffsets() {},
          events: { CRASH: "consumer.crash" },
          on(
            _event: string,
            callback: (event: { payload: { restart: boolean } }) => void,
          ) {
            crashes.push(() => callback({ payload: { restart: false } }));
            return () => {};
          },
        } as unknown as Consumer;
      },
    },
  );
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 1000;
    while (!check() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(check());
  };
  try {
    await waitFor(() => created === 2 && metrics.available);
    assert.equal(crashes.length, 1);
    crashes[0]?.();
    await waitFor(() => created === 3 && metrics.available);
    assert.equal(metrics.consumerRestarts, 1);
    assert.ok(disconnected >= 2);
  } finally {
    await stop();
  }
});
