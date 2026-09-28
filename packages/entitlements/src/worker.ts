import { kafkaSecurityFromEnv } from "@greenguard/kafka-security";
import { createRequire } from "node:module";
import kafkaJs from "kafkajs";
import {
  decodeEntitlementEvent,
  decodeHeartbeat,
  InvalidEntitlementEvent,
  type Envelope,
} from "./event.js";
const { Kafka, CompressionCodecs, CompressionTypes, logLevel } = kafkaJs;
export const TOPIC = "greenguard.billing.lifecycle.v1";
export const DLQ = "greenguard.billing.entitlements.dlq.v1";
export async function startEntitlementWorker(options: {
  brokers: string[];
  groupId: string;
  clientId: string;
  apply: (event: Envelope) => Promise<boolean>;
  heartbeat: (partition: number, emittedAt: Date) => Promise<void>;
  onFatal?: (error: Error) => void;
}): Promise<() => Promise<void>> {
  if (!options.brokers.length || options.brokers.some((x) => !x))
    throw new Error("Kafka brokers required");
  CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
    "kafkajs-snappy",
  );
  const kafka = new Kafka({
    brokers: options.brokers,
    clientId: options.clientId,
    logLevel: logLevel.ERROR,
    ...kafkaSecurityFromEnv(),
  });
  const consumer = kafka.consumer({
    groupId: options.groupId,
    allowAutoTopicCreation: false,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (!payload.restart) options.onFatal?.(payload.error);
  });
  await producer.connect();
  try {
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        try {
          if (!message.value)
            throw new InvalidEntitlementEvent("missing value");
          const value = Buffer.from(message.value);
          const beat = decodeHeartbeat(value);
          if (beat) await options.heartbeat(partition, beat);
          else {
            const event = decodeEntitlementEvent(
              value,
              message.key ? Buffer.from(message.key) : null,
            );
            if (event) await options.apply(event);
          }
        } catch (error) {
          if (!(error instanceof InvalidEntitlementEvent)) throw error;
          await producer.send({
            topic: DLQ,
            acks: -1,
            messages: [
              {
                key: `${topic}:${partition}:${message.offset}`,
                value: JSON.stringify({
                  source_topic: topic,
                  partition,
                  offset: message.offset,
                  reason: error.message,
                  key_base64: message.key?.toString("base64") ?? "",
                  value_base64: message.value?.toString("base64") ?? "",
                }),
              },
            ],
          });
        }
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]);
      },
    });
    return async () => {
      await consumer.disconnect();
      await producer.disconnect();
    };
  } catch (error) {
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect();
    throw error;
  }
}
