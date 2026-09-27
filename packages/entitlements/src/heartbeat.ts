import kafkaJs from "kafkajs";
import { randomInt } from "node:crypto";
import { TOPIC } from "./worker.js";
const { Kafka, logLevel } = kafkaJs;
export const HEARTBEAT_INTERVAL_MS = 60_000;
// One heartbeat to EVERY partition: consumers only prove a partition is caught up
// by reaching its own heartbeat, so a lagging partition keeps the feed stale.
// Cost is O(partitions) per interval regardless of tenant count. The interval is
// jittered so replicas of this job do not synchronize.
export async function startEntitlementHeartbeat(options: {
  brokers: string[];
  clientId: string;
  intervalMs?: number;
  jitterMs?: number;
  now?: () => Date;
  onError?: (error: Error) => void;
}): Promise<() => Promise<void>> {
  const kafka = new Kafka({
    brokers: options.brokers,
    clientId: options.clientId,
    logLevel: logLevel.ERROR,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const admin = kafka.admin();
  await Promise.all([producer.connect(), admin.connect()]);
  const interval = options.intervalMs ?? HEARTBEAT_INTERVAL_MS,
    jitter = options.jitterMs ?? Math.floor(interval / 10);
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const beat = async () => {
    try {
      const meta = await admin.fetchTopicMetadata({ topics: [TOPIC] });
      const partitions =
        meta.topics[0]?.partitions.map((p) => p.partitionId) ?? [];
      const value = JSON.stringify({
        event_type: "entitlements.heartbeat",
        emitted_at: now().toISOString(),
      });
      await producer.send({
        topic: TOPIC,
        acks: -1,
        messages: partitions.map((partition) => ({
          partition,
          key: `heartbeat:${partition}`,
          value,
        })),
      });
    } catch (error) {
      options.onError?.(error as Error);
    }
    if (!stopped)
      timer = setTimeout(
        () => {
          void beat();
        },
        interval + randomInt(jitter),
      );
  };
  void beat();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await Promise.all([producer.disconnect(), admin.disconnect()]);
  };
}
if (process.argv[1]?.endsWith("/heartbeat.js")) {
  const brokers = process.env.KAFKA_BROKERS;
  if (!brokers) throw new Error("KAFKA_BROKERS required");
  const stop = await startEntitlementHeartbeat({
    brokers: brokers.split(","),
    clientId: "entitlement-heartbeat",
    onError: (error) => console.error(error),
  });
  const shutdown = () => {
    void stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
