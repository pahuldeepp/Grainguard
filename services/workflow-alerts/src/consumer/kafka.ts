import { kafkaSecurityFromEnv } from "@greenguard/kafka-security";
import { createRequire } from "node:module";
import kafkaJs, { type EachMessagePayload } from "kafkajs";
import type { Db } from "../db/client.js";
import { handleRiskEvent } from "./handler.js";
import { processRecord, type SourceRecord } from "./runner.js";

const { CompressionCodecs, CompressionTypes, Kafka, logLevel } = kafkaJs;

export const RISK_TOPICS = [
  "greenguard.risk.assessment.v1",
  "greenguard.risk.assessment.v2",
  "greenguard.risk.assessment_invalidated.v1",
] as const;
const QUARANTINE_TOPIC = "greenguard.quarantine.v1";

// KafkaJS ships a placeholder for Snappy. The canonical CDC stream may contain
// Snappy batches even when this consumer never produces compressed messages.
// Registration must happen before the first broker fetch.
export function registerSnappyCodec(): void {
  CompressionCodecs[CompressionTypes.Snappy] = createRequire(import.meta.url)(
    "kafkajs-snappy",
  );
}

export function handleConsumerCrash(
  restart: boolean,
  onFatal?: () => void,
): void {
  if (!restart) onFatal?.();
}

// Each partition is processed in order. Offsets advance only after the tenant
// transaction commits or a poison record is acknowledged by the quarantine topic.
export async function startRiskKafkaConsumer(
  db: Db,
  brokers: string[],
  groupId = "workflow-alerts",
  onFatal?: () => void,
) {
  registerSnappyCodec();
  const kafka = new Kafka({
    clientId: "workflow-alerts",
    brokers,
    logLevel: logLevel.ERROR,
    ...kafkaSecurityFromEnv(),
  });
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    handleConsumerCrash(payload.restart, onFatal);
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  try {
    await consumer.connect();
    for (const topic of RISK_TOPICS)
      await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({
        topic,
        partition,
        message,
      }: EachMessagePayload) => {
        const record: SourceRecord = {
          value: message.value?.toString("utf8") ?? "",
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([key, value]) => [
              key,
              value?.toString("utf8"),
            ]),
          ),
          position: `${topic}:${partition}:${message.offset}`,
        };
        await processRecord(
          {
            signal: new AbortController().signal,
            handle: (event) => handleRiskEvent(db, event),
            source: {
              poll: async () => undefined,
              commit: async () => {
                await consumer.commitOffsets([
                  {
                    topic,
                    partition,
                    offset: (BigInt(message.offset) + 1n).toString(),
                  },
                ]);
              },
              quarantine: async (_record, errors) => {
                await producer.send({
                  topic: QUARANTINE_TOPIC,
                  messages: [
                    {
                      key: `${topic}:${partition}:${message.offset}`,
                      value: JSON.stringify({
                        source: record.position,
                        errors,
                        value: record.value,
                      }),
                    },
                  ],
                });
              },
            },
          },
          record,
        );
      },
    });
  } catch (error) {
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect();
    throw error;
  }
  return async () => {
    await consumer.disconnect();
    await producer.disconnect();
  };
}
