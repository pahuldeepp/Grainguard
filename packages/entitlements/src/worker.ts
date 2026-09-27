import {
  connectWorker,
  createWorkerClients,
  processWithDlq,
} from "@greenguard/kafka-runtime";
import {
  decodeEntitlementEvent,
  decodeHeartbeat,
  InvalidEntitlementEvent,
  type Envelope,
} from "./event.js";
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
  const { consumer, producer, close } = createWorkerClients({
    moduleUrl: import.meta.url,
    brokers: options.brokers,
    clientId: options.clientId,
    groupId: options.groupId,
    missingBrokersMessage: "Kafka brokers required",
    onFatal: options.onFatal,
  });
  await connectWorker(consumer, producer);
  try {
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachMessage: async (payload) => {
        await processWithDlq({
          consumer,
          producer,
          message: payload,
          dlqTopic: DLQ,
          isInvalid: (error): error is InvalidEntitlementEvent =>
            error instanceof InvalidEntitlementEvent,
          process: async (message) => {
            if (!message.value)
              throw new InvalidEntitlementEvent("missing value");
            const value = Buffer.from(message.value);
            const beat = decodeHeartbeat(value);
            if (beat) await options.heartbeat(payload.partition, beat);
            else {
              const event = decodeEntitlementEvent(
                value,
                message.key ? Buffer.from(message.key) : null,
              );
              if (event) await options.apply(event);
            }
          },
        });
      },
    });
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
