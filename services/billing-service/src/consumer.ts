import {
  Kafka,
  type Consumer,
  type EachBatchPayload,
  type KafkaMessage,
} from "kafkajs";
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

type ReadingGroups = Map<string, { eventId: string; acceptedAt: Date }[]>;

function validateBusinessEvent(event: EventEnvelope): void {
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
}

async function flushReadings(
  groups: ReadingGroups,
  usage: BillingUsage,
  heartbeat: EachBatchPayload["heartbeat"],
): Promise<void> {
  for (const [tenantId, values] of groups) {
    for (let index = 0; index < values.length; index += 1000)
      await usage.recordReadings(tenantId, values.slice(index, index + 1000));
    await heartbeat();
  }
  groups.clear();
}

async function processMessage(
  message: KafkaMessage,
  batch: EachBatchPayload["batch"],
  groups: ReadingGroups,
  options: { commands: BillingCommands; usage: BillingUsage },
  heartbeat: EachBatchPayload["heartbeat"],
): Promise<void> {
  let event: EventEnvelope;
  try {
    if (!message.value) throw new Error("empty_source_event");
    event = parseEvent(message.value);
    validateBusinessEvent(event);
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "invalid_source_event";
    await options.usage.rejectSource(
      batch.topic,
      batch.partition,
      message.offset,
      reason,
    );
    return;
  }
  if (event.event_type === "tenant.created") {
    await options.commands.onTenantCreated(event.tenant_id, event.event_id);
  } else if (event.event_type === "telemetry.recorded") {
    const values = groups.get(event.tenant_id) ?? [];
    values.push({
      eventId: event.event_id,
      acceptedAt: new Date(event.payload.received_at as string),
    });
    groups.set(event.tenant_id, values);
    if (values.length >= 1000)
      await flushReadings(groups, options.usage, heartbeat);
  }
}

async function processBatch(
  payload: EachBatchPayload,
  options: {
    commands: BillingCommands;
    usage: BillingUsage;
    lag?: ConsumerLag;
  },
): Promise<void> {
  const groups: ReadingGroups = new Map();
  for (const message of payload.batch.messages) {
    if (!payload.isRunning() || payload.isStale()) return;
    await processMessage(
      message,
      payload.batch,
      groups,
      options,
      payload.heartbeat,
    );
  }
  await flushReadings(groups, options.usage, payload.heartbeat);
  for (const message of payload.batch.messages)
    payload.resolveOffset(message.offset);
  await payload.commitOffsetsIfNecessary();
  const caughtUp =
    BigInt(payload.batch.lastOffset()) + 1n >=
    BigInt(payload.batch.highWatermark);
  if (caughtUp) options.lag?.markCaughtUp();
  else options.lag?.markBehind();
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
    eachBatch: (payload) => processBatch(payload, options),
  });
  return consumer;
}
