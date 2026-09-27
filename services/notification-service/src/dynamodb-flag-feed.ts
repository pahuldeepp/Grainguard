import { createRequire } from "node:module";
import kafkaJs, { type Consumer, type Producer } from "kafkajs";
import {
  FLAG_REGISTRY,
  PoisonFlagEventError,
  parseFlagEvent,
  createDynamoFlagSnapshotStore,
  type DynamoFlagSnapshotStore,
} from "@greenguard/feature-flags";
import {
  classifyFlagMessage,
  flagHeaderTenant,
  quarantineFlagMessage,
  type FlagFeedMessage,
} from "./flag-feed-message.js";

const RETRY_MS = 5_000;
const { Kafka, CompressionCodecs, CompressionTypes } = kafkaJs;
CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
  "kafkajs-snappy",
);
type FeedConsumer = Pick<
  Consumer,
  "connect" | "subscribe" | "run" | "disconnect" | "on" | "events"
>;
type FeedProducer = Pick<Producer, "connect" | "disconnect" | "send">;
async function handleMessage(
  store: Pick<DynamoFlagSnapshotStore, "apply">,
  producer: FeedProducer,
  source: FlagFeedMessage,
): Promise<void> {
  const { value } = source.message;
  if (!value) return;
  const raw = value.toString("utf8");
  const checked = classifyFlagMessage(raw, flagHeaderTenant(source.message));
  if (checked.reason) {
    await quarantineFlagMessage(
      producer,
      source,
      raw,
      checked.reason,
      checked.tenant,
    );
    return;
  }

  let change;
  try {
    change = parseFlagEvent(checked.event, FLAG_REGISTRY);
  } catch (error) {
    if (!(error instanceof PoisonFlagEventError)) throw error;
    await quarantineFlagMessage(
      producer,
      source,
      raw,
      error.reason,
      checked.tenant,
    );
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
  const kafka = new Kafka({ clientId: "greenguard-dynamodb-flags", brokers });
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
      producerReady ??= producer.connect().catch((error: unknown) => {
        producerReady = undefined;
        throw error;
      });
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
          handleMessage(store, producer, payload as FlagFeedMessage),
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
