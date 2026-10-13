import { kafkaSecurityFromEnv } from "@greenguard/kafka-security";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import kafkaJs, { type Consumer, type Producer } from "kafkajs";
import {
  applyFlagEvent,
  FLAG_REGISTRY,
  PoisonFlagEventError,
  type VersionedFlagStore,
} from "@greenguard/feature-flags";

const RETRY_MS = 5_000;
const CONFIG_TOPIC = "greenguard.platform.config.v1";
const QUARANTINE_TOPIC = "greenguard.quarantine.v1";
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const { Kafka, CompressionCodecs, CompressionTypes } = kafkaJs;
CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
  "kafkajs-snappy",
);
type FeedConsumer = Pick<
  Consumer,
  "connect" | "subscribe" | "run" | "disconnect" | "on" | "events"
>;

type FeedProducer = Pick<Producer, "connect" | "disconnect" | "send">;
type FeedMessage = {
  topic: string;
  partition: number;
  message: {
    offset: string;
    value: Buffer | null;
    headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
  };
};

function headerTenant(message: FeedMessage["message"]): string | undefined {
  const raw = message.headers?.tenant_id;
  return typeof raw === "string" || Buffer.isBuffer(raw)
    ? raw.toString("utf8")
    : undefined;
}

type Checked = { event?: unknown; reason?: string; tenant: string };

function classify(raw: string, headerId: string | undefined): Checked {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { reason: "bad_envelope", tenant: "unknown" };
  }
  const id = typeof event?.tenant_id === "string" ? event.tenant_id : "";
  const tenant = UUID.test(id) ? id : "unknown";
  if (headerId !== undefined && headerId !== id)
    return { reason: "key_mismatch", tenant };
  return { event, tenant };
}

/** Poison events are quarantined (acknowledged) and the offset advances; any other
 * failure propagates so the offset is not committed and the message is redelivered. */
async function handleMessage(
  store: VersionedFlagStore,
  producer: FeedProducer,
  { topic, partition, message }: FeedMessage,
): Promise<void> {
  if (!message.value) return;
  const raw = message.value.toString("utf8");
  const checked = classify(raw, headerTenant(message));
  let reason = checked.reason;
  if (!reason) {
    try {
      applyFlagEvent(store, checked.event, FLAG_REGISTRY);
      return;
    } catch (error) {
      if (!(error instanceof PoisonFlagEventError)) throw error;
      reason = error.reason;
    }
  }
  const key = `${topic}:${partition}:${message.offset}`;
  await producer.send({
    topic: QUARANTINE_TOPIC,
    messages: [
      {
        key,
        headers: { reason_code: reason, tenant_id: checked.tenant },
        value: JSON.stringify({
          reason,
          source_topic: topic,
          source_partition: partition,
          source_offset: message.offset,
          raw_base64: Buffer.from(raw.slice(0, 65_536)).toString("base64"),
          truncated: raw.length > 65_536,
        }),
      },
    ],
  });
}

/** Replays the config topic after outages; failures leave safe defaults active. */
export function startFlagFeed(
  store: VersionedFlagStore,
  brokers: string[],
  options: {
    retryMs?: number;
    onUnavailable?: () => void;
    createConsumer?: (groupId: string) => FeedConsumer;
    createProducer?: () => FeedProducer;
    instanceId?: string;
  } = {},
): () => Promise<void> {
  const kafka = new Kafka({
    clientId: "greenguard-notifications-flags",
    brokers,
    ...kafkaSecurityFromEnv(),
  });
  const producer =
    options.createProducer?.() ??
    kafka.producer({ allowAutoTopicCreation: false });
  // The cache is in-memory. Each replica gets an isolated group and replays the
  // retained topic, rather than competing with other replicas for partitions.
  const groupId = `greenguard-notifications-flags-${options.instanceId ?? randomUUID()}`;
  let producerReady: Promise<void> | undefined;
  let consumer: FeedConsumer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectionTask: Promise<void> | undefined;
  let recoveryTask: Promise<void> | undefined;
  let closed = false;
  const failed = new WeakSet<FeedConsumer>();
  const disconnects = new WeakMap<FeedConsumer, Promise<void>>();
  const retryMs = options.retryMs ?? RETRY_MS;
  if (!Number.isFinite(retryMs) || retryMs < 1)
    throw new Error("retryMs must be positive");

  function disconnect(next: FeedConsumer): Promise<void> {
    let task = disconnects.get(next);
    if (!task) {
      task = next.disconnect().catch(() => {});
      disconnects.set(next, task);
    }
    return task;
  }

  function unavailable(): void {
    store.setUnavailable(true);
    options.onUnavailable?.();
  }

  function scheduleRetry(): void {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void beginConnect();
    }, retryMs);
  }

  function recover(next: FeedConsumer): void {
    if (closed || consumer !== next || failed.has(next)) return;
    failed.add(next);
    consumer = undefined;
    unavailable();
    // Disconnect and finish any outstanding subscribe/run before creating the
    // next consumer. A CRASH while run starts must not overlap its replacement.
    const task = (async () => {
      await disconnect(next);
      await connectionTask;
      scheduleRetry();
    })();
    recoveryTask = task;
    void task.finally(() => {
      if (recoveryTask === task) recoveryTask = undefined;
    });
  }

  async function connect(): Promise<void> {
    if (closed || consumer) return;
    const next =
      options.createConsumer?.(groupId) ?? kafka.consumer({ groupId });
    try {
      producerReady ??= producer.connect().catch((error: unknown) => {
        producerReady = undefined;
        throw error;
      });
      await producerReady;
      if (closed) return;
      await next.connect();
      if (closed) return;
      consumer = next;
      next.on(next.events.CRASH, ({ payload }) => {
        if (!payload.restart) recover(next);
      });
      await next.subscribe({ topic: CONFIG_TOPIC, fromBeginning: true });
      if (closed || failed.has(next)) return;
      await next.run({
        eachMessage: (payload) =>
          handleMessage(store, producer, payload as FeedMessage),
      });
      if (!closed && !failed.has(next)) store.setUnavailable(false);
    } catch {
      if (consumer === next) consumer = undefined;
      if (!closed && !failed.has(next)) {
        unavailable();
        await disconnect(next);
        scheduleRetry();
      }
    } finally {
      if (closed || failed.has(next)) {
        if (consumer === next) consumer = undefined;
        await disconnect(next);
      }
    }
  }

  function beginConnect(): Promise<void> {
    if (closed) return Promise.resolve();
    if (connectionTask) return connectionTask;
    const wrapped = connect().finally(() => {
      if (connectionTask === wrapped) connectionTask = undefined;
    });
    connectionTask = wrapped;
    return wrapped;
  }

  void beginConnect();
  return async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    await connectionTask;
    await recoveryTask;
    if (consumer) await disconnect(consumer);
    consumer = undefined;
    await producer.disconnect().catch(() => {});
  };
}
