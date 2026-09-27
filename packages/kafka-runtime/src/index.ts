import { createRequire } from "node:module";
import kafkaJs from "kafkajs";
import type {
  EachMessagePayload,
  KafkaMessage,
  Consumer,
  Producer,
} from "kafkajs";

const { Kafka, CompressionCodecs, CompressionTypes, logLevel } = kafkaJs;

export function configureSnappy(moduleUrl: string): void {
  CompressionCodecs[CompressionTypes.Snappy] =
    createRequire(moduleUrl)("kafkajs-snappy");
}

export function createWorkerClients(options: {
  moduleUrl: string;
  brokers: string[];
  clientId: string;
  groupId: string;
  missingBrokersMessage: string;
  onFatal?: (error: Error) => void;
}): { consumer: Consumer; producer: Producer; close: () => Promise<void> } {
  if (!options.brokers.length || options.brokers.some((broker) => !broker))
    throw new Error(options.missingBrokersMessage);
  configureSnappy(options.moduleUrl);
  const kafka = new Kafka({
    brokers: options.brokers,
    clientId: options.clientId,
    logLevel: logLevel.ERROR,
  });
  const consumer = kafka.consumer({
    groupId: options.groupId,
    allowAutoTopicCreation: false,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (!payload.restart) options.onFatal?.(payload.error);
  });
  return {
    consumer,
    producer,
    close: async () => {
      await consumer.disconnect().catch(() => undefined);
      await producer.disconnect();
    },
  };
}

export async function processWithDlq(options: {
  consumer: Consumer;
  producer: Producer;
  message: EachMessagePayload;
  dlqTopic: string;
  isInvalid: (error: unknown) => error is Error;
  process: (message: KafkaMessage) => Promise<void>;
}): Promise<void> {
  const { consumer, producer, message, dlqTopic } = options;
  const { topic, partition, message: kafkaMessage } = message;
  try {
    await options.process(kafkaMessage);
  } catch (error) {
    if (!options.isInvalid(error)) throw error;
    await producer.send({
      topic: dlqTopic,
      acks: -1,
      messages: [
        {
          key: `${topic}:${partition}:${kafkaMessage.offset}`,
          value: JSON.stringify({
            source_topic: topic,
            partition,
            offset: kafkaMessage.offset,
            reason: error.message,
            key_base64: kafkaMessage.key?.toString("base64") ?? "",
            value_base64: kafkaMessage.value?.toString("base64") ?? "",
          }),
        },
      ],
    });
  }
  await consumer.commitOffsets([
    { topic, partition, offset: (BigInt(kafkaMessage.offset) + 1n).toString() },
  ]);
}

export async function connectWorker(
  consumer: Consumer,
  producer: Producer,
): Promise<void> {
  await producer.connect();
  try {
    await consumer.connect();
  } catch (error) {
    await consumer.disconnect().catch(() => undefined);
    await producer.disconnect();
    throw error;
  }
}
