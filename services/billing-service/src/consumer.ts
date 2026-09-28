import { kafkaSecurityFromEnv } from "@greenguard/kafka-security";
import { Kafka, type Consumer } from "kafkajs";
import { BillingCommands } from "./commands.js";
import { BillingUsage } from "./usage.js";
import { UUID } from "./ids.js";
import type { ConsumerLag } from "./lag.js";

interface EventEnvelope {
  event_id: string;
  event_type: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

function parseEvent(value: Buffer): EventEnvelope {
  const event = JSON.parse(value.toString("utf8")) as EventEnvelope;
  if (
    !event ||
    !UUID.test(event.event_id) ||
    !UUID.test(event.tenant_id) ||
    typeof event.event_type !== "string" ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  )
    throw new Error("invalid billing source event");
  return event;
}

// Kafka commits an offset only after the billing transaction commits. Replayed
// events use source event IDs in the usage ledger and tenant-name IDs in commands.
export async function startBillingConsumer(options: {
  brokers: string[];
  commands: BillingCommands;
  usage: BillingUsage;
  lag?: ConsumerLag;
}): Promise<Consumer> {
  const kafka = new Kafka({
    clientId: "greenguard-billing",
    brokers: options.brokers,
    ...kafkaSecurityFromEnv(),
  });
  const consumer = kafka.consumer({ groupId: "greenguard-billing-v1" });
  await consumer.connect();
  await consumer.subscribe({
    topics: [
      "greenguard.inventory.tenant.v1",
      "greenguard.telemetry.recorded.v1",
    ],
    fromBeginning: true,
  });
  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async ({
      batch,
      resolveOffset,
      heartbeat,
      isRunning,
      isStale,
      commitOffsetsIfNecessary,
    }) => {
      const readings = new Map<
        string,
        { eventId: string; acceptedAt: Date }[]
      >();
      const flush = async () => {
        for (const [tenantId, values] of readings) {
          for (let index = 0; index < values.length; index += 1000)
            await options.usage.recordReadings(
              tenantId,
              values.slice(index, index + 1000),
            );
          await heartbeat();
        }
        readings.clear();
      };
      for (const message of batch.messages) {
        if (!isRunning() || isStale()) return;
        let event: EventEnvelope;
        try {
          if (!message.value) throw new Error("empty_source_event");
          event = parseEvent(message.value);
          if (
            event.event_type === "tenant.created" &&
            event.payload.tenant_id !== event.tenant_id
          )
            throw new Error("tenant_mismatch");
          if (
            event.event_type === "telemetry.recorded" &&
            (typeof event.payload.received_at !== "string" ||
              Number.isNaN(Date.parse(event.payload.received_at)))
          )
            throw new Error("invalid_received_at");
        } catch (error) {
          await options.usage.rejectSource(
            batch.topic,
            batch.partition,
            message.offset,
            error instanceof Error && /^[a-z_]+$/.test(error.message)
              ? error.message
              : "invalid_source_event",
          );
          continue;
        }
        if (event.event_type === "tenant.created") {
          await options.commands.onTenantCreated(
            event.tenant_id,
            event.event_id,
          );
        } else if (event.event_type === "telemetry.recorded") {
          const values = readings.get(event.tenant_id) ?? [];
          values.push({
            eventId: event.event_id,
            acceptedAt: new Date(event.payload.received_at as string),
          });
          readings.set(event.tenant_id, values);
          if (values.length >= 1000) await flush();
        }
      }
      await flush(); // The offset frontier follows committed billing transactions.
      for (const message of batch.messages) resolveOffset(message.offset);
      await commitOffsetsIfNecessary();
      options.lag?.observe(
        BigInt(batch.lastOffset()) + 1n >= BigInt(batch.highWatermark),
      );
    },
  });
  return consumer;
}
