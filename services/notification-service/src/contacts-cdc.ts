import { kafkaSecurityFromEnv } from "@greenguard/kafka-security";
import { createRequire } from "node:module";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent as HttpsAgent } from "node:https";
import kafkaJs, { type Consumer, type Producer } from "kafkajs";
import { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  NumberValue,
  PutCommand,
  type DynamoDBDocumentClient as DocumentClient,
} from "@aws-sdk/lib-dynamodb";

const CONTACTS_TOPIC = "greenguard.notifications.contacts.cdc.v1";
const HEARTBEAT_TOPIC = "greenguard.notifications.contacts.heartbeat.v2";
const DLQ_TOPIC = "greenguard.notifications.contacts.cdc.dlq.v1";
const CONTACTS_GROUP = "greenguard-notification-contacts-dynamodb-v1";
const HEARTBEAT_PREFIX = "greenguard.notification-contacts-feed";
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const RESERVED_TENANT = "00000000-0000-4000-8000-000000000001";
const RETRY_MS = 5_000;

export function contactsRegistryConfig(
  host: string,
  getenv: (key: string) => string | undefined = (key) => process.env[key],
): ConstructorParameters<typeof SchemaRegistry>[0] {
  const required = (getenv("KAFKA_REQUIRE_TLS") ?? "").toLowerCase() === "true";
  const username = getenv("SCHEMA_REGISTRY_USERNAME") ?? "";
  const password = getenv("SCHEMA_REGISTRY_PASSWORD") ?? "";
  const caFile =
    getenv("SCHEMA_REGISTRY_TLS_CA_FILE") ??
    (required ? "/etc/greenguard/kafka/registry-ca.crt" : "");
  if (!required && !username && !password && !caFile) return { host };
  if (!host.startsWith("https://") || !username || !password || !caFile)
    throw new Error(
      "Schema Registry requires HTTPS, Basic credentials, and a TLS CA file",
    );
  const ca = readFileSync(caFile, "utf8");
  const certificate = new X509Certificate(ca);
  const now = Date.now();
  if (
    !certificate.ca ||
    Date.parse(certificate.validFrom) > now ||
    Date.parse(certificate.validTo) <= now
  )
    throw new Error("Schema Registry TLS certificate is not a current CA");
  return {
    host,
    auth: { username, password },
    agent: new HttpsAgent({
      ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    }),
  };
}
export const CONTACTS_FEED_CHECKPOINT = {
  tenant_id: "SYSTEM#NOTIFICATION_CONTACTS_CDC",
  record_key: "CONTACTS_FEED_HEARTBEAT",
} as const;
const { Kafka, CompressionCodecs, CompressionTypes } = kafkaJs;
CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
  "kafkajs-snappy",
);

type KafkaConsumer = Pick<
  Consumer,
  | "connect"
  | "subscribe"
  | "run"
  | "disconnect"
  | "on"
  | "events"
  | "commitOffsets"
>;
type KafkaProducer = Pick<Producer, "send">;
type ManagedKafkaProducer = Pick<Producer, "connect" | "disconnect" | "send">;
type MessagePayload = {
  topic: string;
  partition: number;
  message: {
    key: Buffer | null;
    value: Buffer | null;
    offset: string;
    timestamp: string;
  };
};

export interface NotificationContact {
  tenant_id: string;
  email: string | null;
  sms: string | null;
  version: bigint;
}

export interface ContactsProjectionStore {
  apply(contact: NotificationContact): Promise<"applied" | "stale">;
  checkpoint?(sourceTimeMs: number): Promise<void>;
}

export interface ContactsProjectorMetrics {
  applied: number;
  stale: number;
  quarantined: number;
  failures: number;
  available: boolean;
  consumerRestarts: number;
  sourceToApplyLagSeconds: number;
  heartbeatAtMs: number | undefined;
  heartbeatAgeSeconds(now?: number): number;
  render(now?: number): string;
}

export function createContactsProjectorMetrics(): ContactsProjectorMetrics {
  const metrics: ContactsProjectorMetrics = {
    applied: 0,
    stale: 0,
    quarantined: 0,
    failures: 0,
    available: false,
    consumerRestarts: 0,
    sourceToApplyLagSeconds: 0,
    heartbeatAtMs: undefined,
    heartbeatAgeSeconds(now = Date.now()) {
      return this.heartbeatAtMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, (now - this.heartbeatAtMs) / 1000);
    },
    render(now = Date.now()) {
      const heartbeatAge = this.heartbeatAgeSeconds(now);
      return [
        "# HELP greenguard_notification_contacts_projection_applied_total Contact rows written to DynamoDB",
        "# TYPE greenguard_notification_contacts_projection_applied_total counter",
        `greenguard_notification_contacts_projection_applied_total ${this.applied}`,
        "# HELP greenguard_notification_contacts_projection_stale_total Duplicate or stale CDC rows ignored",
        "# TYPE greenguard_notification_contacts_projection_stale_total counter",
        `greenguard_notification_contacts_projection_stale_total ${this.stale}`,
        "# HELP greenguard_notification_contacts_projection_quarantined_total Invalid CDC rows placed in the recoverable DLQ",
        "# TYPE greenguard_notification_contacts_projection_quarantined_total counter",
        `greenguard_notification_contacts_projection_quarantined_total ${this.quarantined}`,
        "# HELP greenguard_notification_contacts_projection_failures_total Retryable projection failures",
        "# TYPE greenguard_notification_contacts_projection_failures_total counter",
        `greenguard_notification_contacts_projection_failures_total ${this.failures}`,
        "# HELP greenguard_notification_contacts_projector_available Whether the Kafka projector consumer is running",
        "# TYPE greenguard_notification_contacts_projector_available gauge",
        `greenguard_notification_contacts_projector_available ${this.available ? 1 : 0}`,
        "# HELP greenguard_notification_contacts_projector_restarts_total Number of app-managed Kafka consumer restarts",
        "# TYPE greenguard_notification_contacts_projector_restarts_total counter",
        `greenguard_notification_contacts_projector_restarts_total ${this.consumerRestarts}`,
        "# HELP greenguard_notification_contacts_source_to_apply_lag_seconds Age of the last contact source event when applied",
        "# TYPE greenguard_notification_contacts_source_to_apply_lag_seconds gauge",
        `greenguard_notification_contacts_source_to_apply_lag_seconds ${this.sourceToApplyLagSeconds}`,
        "# HELP greenguard_notification_contacts_heartbeat_age_seconds Age of the last transactional PostgreSQL logical-message heartbeat",
        "# TYPE greenguard_notification_contacts_heartbeat_age_seconds gauge",
        `greenguard_notification_contacts_heartbeat_age_seconds ${Number.isFinite(heartbeatAge) ? heartbeatAge : -1}`,
        "",
      ].join("\n");
    },
  };
  return metrics;
}

export class InvalidContactCdcEvent extends Error {
  constructor(readonly reason: string) {
    super(`invalid notification contacts CDC event: ${reason}`);
    this.name = "InvalidContactCdcEvent";
  }
}

type DebeziumRow = {
  tenant_id?: unknown;
  email_to?: unknown;
  sms_to?: unknown;
  version?: unknown;
  __deleted?: unknown;
};

/**
 * JSON.parse would round PostgreSQL BIGINT values above Number.MAX_SAFE_INTEGER.
 * Quote only the known integer `version` field before parsing, then convert it
 * to bigint. This keeps exact source versions without changing the CDC schema.
 */
function parseExactJson(raw: string): unknown {
  const safe = raw.replace(/("version"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"');
  try {
    return JSON.parse(safe) as unknown;
  } catch {
    throw new InvalidContactCdcEvent("malformed_json");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidContactCdcEvent("invalid_envelope");
  return value as Record<string, unknown>;
}

function tenantId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID.test(value) ||
    value === RESERVED_TENANT
  )
    throw new InvalidContactCdcEvent("invalid_tenant");
  return value.toLowerCase();
}

function versionOf(value: unknown): bigint {
  const raw = typeof value === "bigint" ? value.toString() : value;
  if (typeof raw !== "string" || !/^[1-9]\d{0,18}$/.test(raw))
    throw new InvalidContactCdcEvent("invalid_version");
  const version = BigInt(raw);
  if (version > 9_223_372_036_854_775_807n)
    throw new InvalidContactCdcEvent("invalid_version");
  return version;
}

function decodeKey(raw: Buffer | null): string {
  if (!raw) throw new InvalidContactCdcEvent("missing_tenant_key");
  const parsed = object(parseExactJson(raw.toString("utf8")));
  return tenantId(parsed.tenant_id);
}

export function parseDebeziumContact(
  raw: string | unknown,
  key: Buffer | null,
): { contact: NotificationContact; sourceTimeMs?: number } {
  const event = object(typeof raw === "string" ? parseExactJson(raw) : raw);
  // The Schema Registry envelope is the versioned producer/consumer contract.
  // The Delete rewrite remains represented by the nullable marker below.
  if (event.schema_version !== "1")
    throw new InvalidContactCdcEvent("unsupported_schema_version");
  const op = event.__op;
  if (op !== "r" && op !== "c" && op !== "u")
    throw new InvalidContactCdcEvent(
      op === "d"
        ? "hard_delete_requires_versioned_clear"
        : "unsupported_operation",
    );
  const row = event as DebeziumRow;
  if (row.__deleted === true || row.__deleted === "true")
    throw new InvalidContactCdcEvent("hard_delete_requires_versioned_clear");
  const id = tenantId(row.tenant_id);
  if (decodeKey(key) !== id)
    throw new InvalidContactCdcEvent("key_tenant_mismatch");
  const email = row.email_to;
  const sms = row.sms_to;
  if (
    !(email === null || typeof email === "string") ||
    !(sms === null || typeof sms === "string")
  )
    throw new InvalidContactCdcEvent("invalid_contact_fields");
  const version = versionOf(row.version);
  const sourceTime = event.__source_ts_ms;
  const sourceTimeMs =
    typeof sourceTime === "number" &&
    Number.isSafeInteger(sourceTime) &&
    sourceTime >= 0
      ? sourceTime
      : undefined;
  return {
    contact: { tenant_id: id, email, sms, version },
    ...(sourceTimeMs !== undefined && { sourceTimeMs }),
  };
}

export function isContactHeartbeat(raw: string | unknown): number | undefined {
  const parsed = object(typeof raw === "string" ? parseExactJson(raw) : raw);
  const content = Buffer.isBuffer(parsed.content)
    ? parsed.content.toString("utf8")
    : parsed.content;
  if (parsed.prefix !== HEARTBEAT_PREFIX || content !== "checkpoint")
    throw new InvalidContactCdcEvent("invalid_heartbeat");
  const sourceTime = parsed.__source_ts_ms;
  const rawTime =
    typeof sourceTime === "string" && /^\d{1,16}$/.test(sourceTime)
      ? Number(sourceTime)
      : sourceTime;
  if (
    typeof rawTime !== "number" ||
    !Number.isSafeInteger(rawTime) ||
    rawTime < 0
  )
    throw new InvalidContactCdcEvent("invalid_heartbeat_time");
  return rawTime;
}

function sourceCoordinate(payload: MessagePayload): string {
  return `${payload.topic}:${payload.partition}:${payload.message.offset}`;
}

/**
 * DLQ publish is awaited before eachMessage returns. Its body contains the
 * recoverable original envelope; production ACL/TLS requirements are documented
 * because contact envelopes contain PII. Logs and headers contain no PII.
 */
async function quarantine(
  producer: KafkaProducer,
  payload: MessagePayload,
  reason: string,
): Promise<void> {
  const coordinate = sourceCoordinate(payload);
  await producer.send({
    topic: DLQ_TOPIC,
    messages: [
      {
        key: coordinate,
        headers: { reason_code: reason, source_topic: payload.topic },
        value: JSON.stringify({
          reason,
          source_topic: payload.topic,
          source_partition: payload.partition,
          source_offset: payload.message.offset,
          source_key_base64: payload.message.key?.toString("base64") ?? null,
          raw_base64: payload.message.value?.toString("base64") ?? null,
        }),
      },
    ],
  });
}

export async function handleContactsCdcMessage(
  store: ContactsProjectionStore,
  producer: KafkaProducer,
  metrics: ContactsProjectorMetrics,
  payload: MessagePayload,
  now: () => number = Date.now,
  decode: (value: Buffer) => Promise<unknown> = async (value) =>
    parseExactJson(value.toString("utf8")),
): Promise<void> {
  if (!payload.message.value) return;
  try {
    const value = await decode(payload.message.value);
    if (payload.topic === HEARTBEAT_TOPIC) {
      const sourceTimeMs = isContactHeartbeat(value);
      if (sourceTimeMs === undefined)
        throw new InvalidContactCdcEvent("invalid_heartbeat_time");
      await store.checkpoint?.(sourceTimeMs);
      metrics.heartbeatAtMs = Math.max(
        metrics.heartbeatAtMs ?? 0,
        sourceTimeMs,
      );
      return;
    }
    if (payload.topic !== CONTACTS_TOPIC)
      throw new InvalidContactCdcEvent("unexpected_topic");
    const parsed = parseDebeziumContact(value, payload.message.key);
    const result = await store.apply(parsed.contact);
    if (result === "applied") {
      metrics.applied += 1;
      if (parsed.sourceTimeMs !== undefined)
        metrics.sourceToApplyLagSeconds = Math.max(
          0,
          (now() - parsed.sourceTimeMs) / 1000,
        );
    } else {
      metrics.stale += 1;
    }
  } catch (error) {
    if (error instanceof InvalidContactCdcEvent) {
      await quarantine(producer, payload, error.reason);
      metrics.quarantined += 1;
      return;
    }
    metrics.failures += 1;
    throw error;
  }
}

/** Writes a tenant snapshot only when its PostgreSQL BIGINT version is newer. */
export class DynamoContactsProjectionStore implements ContactsProjectionStore {
  constructor(
    private readonly client: DocumentClient,
    private readonly tableName: string,
  ) {
    if (!tableName.trim()) throw new Error("DynamoDB table name is required");
  }

  async apply(contact: NotificationContact): Promise<"applied" | "stale"> {
    if (!UUID.test(contact.tenant_id) || contact.tenant_id === RESERVED_TENANT)
      throw new Error("invalid tenant ID");
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            tenant_id: contact.tenant_id,
            record_key: "CONTACTS",
            email: contact.email,
            sms: contact.sms,
            version: NumberValue.from(contact.version.toString()),
          },
          ConditionExpression:
            "attribute_not_exists(#version) OR #version < :version",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: {
            ":version": NumberValue.from(contact.version.toString()),
          },
        }),
      );
      return "applied";
    } catch (error) {
      if (isConditionalFailure(error)) return "stale";
      throw error;
    }
  }

  /** Feed health is independent of when any particular tenant last changed contacts. */
  async checkpoint(sourceTimeMs: number): Promise<void> {
    if (!Number.isSafeInteger(sourceTimeMs) || sourceTimeMs < 0)
      throw new Error("invalid contact feed checkpoint time");
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...CONTACTS_FEED_CHECKPOINT, source_time_ms: sourceTimeMs },
          ConditionExpression: "attribute_not_exists(#time) OR #time < :time",
          ExpressionAttributeNames: { "#time": "source_time_ms" },
          ExpressionAttributeValues: { ":time": sourceTimeMs },
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }
}

function isConditionalFailure(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}

/** Separate remote schema lookup from local payload decoding: only local poison is quarantined. */
export async function decodeContactsWire(
  registry: Pick<SchemaRegistry, "getSchema">,
  value: Buffer,
): Promise<unknown> {
  if (value.length < 5 || value[0] !== 0)
    throw new InvalidContactCdcEvent("invalid_avro_framing");
  const schemaId = value.readUInt32BE(1);
  if (schemaId === 0)
    throw new InvalidContactCdcEvent("invalid_avro_schema_id");
  // Lookup failures include network/Registry outages and missing schemas. Retry
  // them; a repaired Registry may resolve the same record on the next delivery.
  const schema = await registry.getSchema(schemaId);
  try {
    return schema.fromBuffer(value.subarray(5));
  } catch {
    // Avro payload decoding is deterministic after a schema has been fetched.
    // Never preserve its exception text: it can contain contact values.
    throw new InvalidContactCdcEvent("invalid_avro_payload");
  }
}

export function contactsProjectorReady(
  metrics: ContactsProjectorMetrics,
  now = Date.now(),
): boolean {
  return metrics.available && metrics.heartbeatAgeSeconds(now) <= 60;
}

export function createDynamoContactsProjectionStore(options: {
  tableName: string;
  region?: string;
  endpoint?: string;
  credentials?: DynamoDBClientConfig["credentials"];
}): DynamoContactsProjectionStore & { close(): void } {
  const localCredentials =
    options.endpoint && !options.credentials
      ? { accessKeyId: "local", secretAccessKey: "local" }
      : undefined;
  const raw = new DynamoDBClient({
    region: options.region ?? "us-east-1",
    ...(options.endpoint && { endpoint: options.endpoint }),
    ...((options.credentials ?? localCredentials) && {
      credentials: options.credentials ?? localCredentials,
    }),
  });
  const client = DynamoDBDocumentClient.from(raw, {
    marshallOptions: {
      removeUndefinedValues: true,
      allowImpreciseNumbers: false,
    },
  });
  const store = new DynamoContactsProjectionStore(client, options.tableName);
  return Object.assign(store, { close: () => raw.destroy() });
}

/** Separate contact projector group/module, with at-least-once offset semantics. */
export function startContactsProjector(
  store: ContactsProjectionStore,
  brokers: string[],
  metrics: ContactsProjectorMetrics,
  options: {
    retryMs?: number;
    groupId?: string;
    registry?: SchemaRegistry;
    schemaRegistryUrl?: string;
    createConsumer?: () => KafkaConsumer;
    createProducer?: () => ManagedKafkaProducer;
    onUnavailable?: () => void;
    now?: () => number;
  } = {},
): () => Promise<void> {
  const kafka = new Kafka({
    clientId: "greenguard-notification-contacts-projector",
    brokers,
    ...kafkaSecurityFromEnv(),
  });
  const registry =
    options.registry ??
    (options.schemaRegistryUrl
      ? new SchemaRegistry(contactsRegistryConfig(options.schemaRegistryUrl))
      : undefined);
  if (!registry)
    throw new Error(
      "Schema Registry is required for the contacts CDC projector",
    );
  const decode = (value: Buffer) => decodeContactsWire(registry, value);
  const producer: ManagedKafkaProducer =
    options.createProducer?.() ??
    kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
  let producerReady: Promise<void> | undefined;
  let consumer: KafkaConsumer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restartTask: Promise<void> | undefined;
  let connectionTask: Promise<void> | undefined;
  let closed = false;
  const retryMs = options.retryMs ?? RETRY_MS;
  if (!Number.isFinite(retryMs) || retryMs < 1)
    throw new Error("retryMs must be positive");

  function markUnavailable(): void {
    metrics.available = false;
    options.onUnavailable?.();
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const next =
      options.createConsumer?.() ??
      kafka.consumer({ groupId: options.groupId ?? CONTACTS_GROUP });
    try {
      if (!producerReady) {
        producerReady = producer.connect().catch((error: unknown) => {
          producerReady = undefined;
          throw error;
        });
      }
      await producerReady;
      await next.connect();
      if (closed) {
        await next.disconnect();
        return;
      }
      await next.subscribe({ topic: CONTACTS_TOPIC, fromBeginning: true });
      await next.subscribe({ topic: HEARTBEAT_TOPIC, fromBeginning: true });
      consumer = next;
      next.on(next.events.CRASH, ({ payload }) => {
        // KafkaJS only restarts errors it classifies as retriable. SDK errors
        // (for example DynamoDB throttling) often arrive with restart=false,
        // so replace the consumer at the application boundary. Its offset is
        // still uncommitted and will be delivered again to the same group.
        if (!payload.restart) scheduleRestart(next);
      });
      const running = next.run({
        autoCommit: false,
        eachMessage: (payload) =>
          handleContactsCdcMessage(
            store,
            producer,
            metrics,
            payload as MessagePayload,
            options.now,
            decode,
          ).then(async () => {
            await next.commitOffsets([
              {
                topic: payload.topic,
                partition: payload.partition,
                offset: (BigInt(payload.message.offset) + 1n).toString(),
              },
            ]);
          }),
      });
      metrics.available = true;
      void running.catch(() => scheduleRestart(next));
    } catch {
      markUnavailable();
      await next.disconnect().catch(() => {});
      if (consumer === next) consumer = undefined;
      if (!closed)
        timer = setTimeout(() => {
          timer = undefined;
          void beginConnect();
        }, retryMs);
    }
  }

  function beginConnect(): Promise<void> {
    const task = connect();
    connectionTask = task;
    return task;
  }

  function scheduleRestart(failed: KafkaConsumer): void {
    if (closed || consumer !== failed || timer || restartTask) return;
    markUnavailable();
    metrics.consumerRestarts += 1;
    timer = setTimeout(() => {
      timer = undefined;
      restartTask = (async () => {
        if (closed || consumer !== failed) return;
        consumer = undefined;
        await failed.disconnect().catch(() => {});
        await producer.disconnect().catch(() => {});
        producerReady = undefined;
        await beginConnect();
      })()
        .catch(() => {
          markUnavailable();
          if (!closed && !timer)
            timer = setTimeout(() => {
              timer = undefined;
              restartTask = undefined;
              void beginConnect();
            }, retryMs);
        })
        .finally(() => {
          restartTask = undefined;
        });
    }, retryMs);
  }

  void beginConnect();
  return async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    await restartTask?.catch(() => {});
    await connectionTask?.catch(() => {});
    await consumer?.disconnect().catch(() => {});
    await producer.disconnect().catch(() => {});
  };
}

export const CONTACTS_CDC_TOPICS = {
  contacts: CONTACTS_TOPIC,
  heartbeat: HEARTBEAT_TOPIC,
  dlq: DLQ_TOPIC,
} as const;
