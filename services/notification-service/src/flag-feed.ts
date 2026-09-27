import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import kafkaJs, { type Consumer } from "kafkajs";
import {
  applyFlagEvent,
  FLAG_REGISTRY,
  PoisonFlagEventError,
  type VersionedFlagStore,
} from "@greenguard/feature-flags";
import {
  classifyFlagMessage,
  flagHeaderTenant,
  type FlagFeedMessage,
} from "./flag-feed-message.js";

const RETRY_MS = 5_000;
const CONFIG_TOPIC = "greenguard.platform.config.v1";
const { Kafka, CompressionCodecs, CompressionTypes } = kafkaJs;
CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
  "kafkajs-snappy",
);

export function notificationInstanceId(env: NodeJS.ProcessEnv): string {
  return (
    env.NOTIFICATION_INSTANCE_ID?.trim() || env.HOSTNAME?.trim() || randomUUID()
  );
}

export { isFlagTenantId } from "./flag-feed-message.js";
type FeedConsumer = Pick<
  Consumer,
  "connect" | "subscribe" | "run" | "disconnect" | "on" | "events"
>;

/** Poison events are skipped locally and counted; the DynamoDB feed owns quarantine. */
async function handleMessage(
  store: VersionedFlagStore,
  { message }: FlagFeedMessage,
  onPoison?: (reason: string) => void,
): Promise<void> {
  if (!message.value) return;
  const raw = message.value.toString("utf8");
  const checked = classifyFlagMessage(raw, flagHeaderTenant(message));
  if (checked.reason) {
    onPoison?.(checked.reason);
    return;
  }
  try {
    applyFlagEvent(store, checked.event, FLAG_REGISTRY);
  } catch (error) {
    if (!(error instanceof PoisonFlagEventError)) throw error;
    onPoison?.(error.reason);
  }
}

/** Replays the config topic after outages; failures leave safe defaults active. */
export function startFlagFeed(
  store: VersionedFlagStore,
  brokers: string[],
  options: {
    retryMs?: number;
    onUnavailable?: () => void;
    onPoison?: (reason: string) => void;
    createConsumer?: (groupId: string) => FeedConsumer;
    instanceId?: string;
  } = {},
): () => Promise<void> {
  const kafka = new Kafka({
    clientId: "greenguard-notifications-flags",
    brokers,
  });
  // The cache is in-memory. Each replica gets an isolated group and replays the
  // retained topic, rather than competing with other replicas for partitions.
  const groupId = `greenguard-notifications-flags-${options.instanceId ?? randomUUID()}`;
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
      await next.connect();
      if (closed) return;
      consumer = next;
      next.on(next.events.CRASH, ({ payload }) => {
        if (!payload.restart) recover(next);
      });
      await next.subscribe({ topic: CONFIG_TOPIC, fromBeginning: true });
      if (closed || failed.has(next)) return;
      await next.run({
        autoCommit: false,
        eachMessage: (payload) =>
          handleMessage(store, payload as FlagFeedMessage, options.onPoison),
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
  };
}
