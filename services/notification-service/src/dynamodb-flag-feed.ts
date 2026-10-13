import { kafkaSecurityFromEnv } from "@greenguard/kafka-security";
import { createRequire } from "node:module";
import kafkaJs, { type Consumer, type Producer } from "kafkajs";
import {
  FLAG_REGISTRY,
  PoisonFlagEventError,
  parseFlagEvent,
  createDynamoFlagSnapshotStore,
  type DynamoFlagSnapshotStore,
} from "@greenguard/feature-flags";

const RETRY_MS = 5_000;
const QUARANTINE_TOPIC = "greenguard.quarantine.v1";
const MAX_RAW_BYTES = 65_536;
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
  message: { offset: string; value: Buffer | null };
};

async function quarantine(
  producer: FeedProducer,
  source: FeedMessage,
  raw: string,
  reason: string,
  tenantId: string,
): Promise<void> {
  const bytes = Buffer.from(raw, "utf8");
  await producer.send({
    topic: QUARANTINE_TOPIC,
    messages: [
      {
        key: `${source.topic}:${source.partition}:${source.message.offset}`,
        headers: { reason_code: reason, tenant_id: tenantId },
        value: JSON.stringify({
          reason,
          source_topic: source.topic,
          source_partition: source.partition,
          source_offset: source.message.offset,
          raw_base64: bytes.subarray(0, MAX_RAW_BYTES).toString("base64"),
          truncated: bytes.length > MAX_RAW_BYTES,
        }),
      },
    ],
  });
}

async function handleMessage(
  store: Pick<DynamoFlagSnapshotStore, "apply">,
  producer: FeedProducer,
  source: FeedMessage,
): Promise<void> {
  const { value } = source.message;
  if (!value) return;
  const raw = value.toString("utf8");
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    await quarantine(producer, source, raw, "bad_envelope", "unknown");
    return;
  }

  let change;
  try {
    change = parseFlagEvent(input, FLAG_REGISTRY);
  } catch (error) {
    if (!(error instanceof PoisonFlagEventError)) throw error;
    const candidate = (input as { tenant_id?: unknown } | null)?.tenant_id;
    const tenantId =
      typeof candidate === "string" && candidate.length <= 64
        ? candidate
        : "unknown";
    await quarantine(producer, source, raw, error.reason, tenantId);
    return;
  }
  // Unrelated events sharing the topic are ignored. Persistence errors propagate
  // to prevent Kafka offset commits until the DynamoDB write succeeds.
  if (change) await store.apply(change);
}

/** Projects canonical flag snapshots durably; eachMessage completion gates offset commit. */
export function startDynamoFlagFeed(
  store: Pick<DynamoFlagSnapshotStore, "apply">,
  brokers: string[],
  options: {
    retryMs?: number;
    groupId?: string;
    onUnavailable?: () => void;
    createConsumer?: (groupId: string) => FeedConsumer;
    createProducer?: () => FeedProducer;
  } = {},
): () => Promise<void> {
  const kafka = new Kafka({
    clientId: "greenguard-dynamodb-flags",
    brokers,
    ...kafkaSecurityFromEnv(),
  });
  const groupId = options.groupId ?? "greenguard-platform-flag-dynamodb-v1";
  let consumer: FeedConsumer | undefined;
  let producerReady: Promise<void> | undefined;
  const producer =
    options.createProducer?.() ??
    kafka.producer({ allowAutoTopicCreation: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectionTask: Promise<void> | undefined;
  let restartTask: Promise<void> | undefined;
  let pendingFailedConsumer: FeedConsumer | undefined;
  let pendingFailedDisconnect: Promise<void> | undefined;
  let closed = false;
  const retryMs = options.retryMs ?? RETRY_MS;
  if (!Number.isFinite(retryMs) || retryMs < 1)
    throw new Error("retryMs must be positive");

  function scheduleRetry(): void {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void beginConnect();
    }, retryMs);
  }

  async function connect(): Promise<void> {
    if (closed || consumer) return;
    const next =
      options.createConsumer?.(groupId) ?? kafka.consumer({ groupId });
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
      await next.subscribe({
        topic: "greenguard.platform.config.v1",
        fromBeginning: true,
      });
      consumer = next;
      next.on(next.events.CRASH, ({ payload }) => {
        if (!payload.restart && !closed && consumer === next)
          scheduleRestart(next);
      });
      await next.run({
        eachMessage: (payload) =>
          handleMessage(store, producer, payload as FeedMessage),
      });
    } catch {
      const restartAlreadyScheduled = pendingFailedConsumer === next;
      if (consumer === next) consumer = undefined;
      if (!restartAlreadyScheduled) {
        options.onUnavailable?.();
        await next.disconnect().catch(() => {});
        scheduleRetry();
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

  function scheduleRestart(failed: FeedConsumer): void {
    if (closed || consumer !== failed || timer) return;
    consumer = undefined;
    pendingFailedConsumer = failed;
    pendingFailedDisconnect = failed.disconnect().catch(() => {});
    options.onUnavailable?.();
    timer = setTimeout(() => {
      timer = undefined;
      const task = (async () => {
        await pendingFailedDisconnect;
        if (pendingFailedConsumer === failed) {
          pendingFailedConsumer = undefined;
          pendingFailedDisconnect = undefined;
        }
        if (closed || consumer) return;
        await beginConnect();
      })().catch(() => {
        options.onUnavailable?.();
        scheduleRetry();
      });
      restartTask = task;
      void task.finally(() => {
        if (restartTask === task) restartTask = undefined;
      });
    }, retryMs);
  }

  void beginConnect();
  return async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    const failed = pendingFailedConsumer;
    pendingFailedConsumer = undefined;
    const failedDisconnect = pendingFailedDisconnect;
    pendingFailedDisconnect = undefined;
    if (failed) await (failedDisconnect ?? failed.disconnect().catch(() => {}));
    await restartTask?.catch(() => {});
    await connectionTask?.catch(() => {});
    await consumer?.disconnect().catch(() => {});
    await producer.disconnect().catch(() => {});
  };
}

export function createDynamoFeedStore(options: {
  tableName: string;
  region?: string;
  endpoint?: string;
}) {
  return createDynamoFlagSnapshotStore(options);
}
