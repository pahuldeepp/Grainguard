import type { Tx } from "../db/client.js";
import { nameId } from "./ids.js";

export interface Command {
  idempotencyKey: string;
  correlationId: string;
  traceparent: string;
}

export interface OutboxEvent {
  tenantId: string;
  aggregateType: "organization" | "membership";
  aggregateId: string;
  version: bigint;
  eventType: "tenant.created" | "membership.changed";
  payload: Record<string, unknown>;
}

// Written in the same transaction as the change it describes; CDC publishes after
// commit. The event ID is derived from the aggregate version, never regenerated.
export async function appendEvent(
  tx: Tx,
  event: OutboxEvent,
  cmd: Command,
): Promise<void> {
  const eventId = nameId(
    "event",
    event.tenantId,
    event.aggregateType,
    event.aggregateId,
    String(event.version),
  );
  await tx.$executeRaw`INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id,
      aggregate_version, event_type, schema_version, occurred_at, correlation_id, causation_id, traceparent, payload)
    VALUES (${eventId}::uuid, ${event.tenantId}::uuid, ${event.aggregateType}, ${event.aggregateId}::uuid,
      ${event.version}, ${event.eventType}, 1, clock_timestamp(), ${cmd.correlationId}::uuid,
      ${cmd.correlationId}::uuid, ${cmd.traceparent}, ${JSON.stringify(event.payload)}::jsonb)`;
}
