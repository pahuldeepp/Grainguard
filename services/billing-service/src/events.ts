import type { Tx } from "./db.js";
import { freshId, nameId } from "./ids.js";

export interface EventContext {
  correlationId: string;
  causationId: string;
  traceparent: string;
}
export interface OutboxPayload {
  type: string;
  payload: Record<string, unknown>;
}

export function context(
  correlationId?: string,
  causationId?: string,
  traceparent?: string,
): EventContext {
  const id = correlationId ?? freshId();
  return {
    correlationId: id,
    causationId: causationId ?? id,
    traceparent:
      traceparent && /^00-[\da-f]{32}-[\da-f]{16}-(00|01)$/.test(traceparent)
        ? traceparent
        : `00-${freshId().replaceAll("-", "")}-${freshId().replaceAll("-", "").slice(0, 16)}-01`,
  };
}

export async function outbox(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  version: bigint,
  event: OutboxPayload,
  ctx: EventContext,
): Promise<void> {
  const eventId = nameId(
    "billing-event",
    tenantId,
    aggregateType,
    aggregateId,
    version.toString(),
  );
  await tx.$executeRaw`INSERT INTO outbox_events (event_id, tenant_id, aggregate_type,
    aggregate_id, aggregate_version, event_type, schema_version, occurred_at,
    correlation_id, causation_id, traceparent, payload)
    VALUES (${eventId}::uuid, ${tenantId}::uuid, ${aggregateType}, ${aggregateId}::uuid,
      ${version}, ${event.type}, 1, clock_timestamp(), ${ctx.correlationId}::uuid,
      ${ctx.causationId}::uuid, ${ctx.traceparent}, ${JSON.stringify(event.payload)}::jsonb)
    ON CONFLICT (event_id) DO NOTHING`;
}

export async function audit(
  tx: Tx,
  tenantId: string,
  actorId: string,
  action: string,
  objectId: string,
  detail: Record<string, unknown>,
  stableKey?: string,
): Promise<void> {
  const auditId = stableKey
    ? nameId("billing-audit", tenantId, action, stableKey)
    : freshId();
  await tx.$executeRaw`INSERT INTO billing_audit_events
    (tenant_id, audit_id, actor_id, action, object_id, detail)
    VALUES (${tenantId}::uuid, ${auditId}::uuid, ${actorId}, ${action}, ${objectId},
      ${JSON.stringify(detail)}::jsonb) ON CONFLICT DO NOTHING`;
}
