import {
  connectWorker,
  createWorkerClients,
  processWithDlq,
} from "@greenguard/kafka-runtime";
import { validateEvent, type DomainEvent } from "@greenguard/contracts";
import type { Db } from "../db/client.js";
import { withTenant } from "../db/tenant.js";

export const TENANT_TOPIC = "greenguard.inventory.tenant.v1";
export const TENANT_DLQ_TOPIC = "greenguard.inventory.tenant.dlq.v1";

export class InvalidTenantProjectionEvent extends Error {}

export function decodeTenantEvent(
  value: Buffer,
  key: Buffer | null,
): DomainEvent | null {
  let input: unknown;
  try {
    input = JSON.parse(value.toString("utf8"));
  } catch {
    throw new InvalidTenantProjectionEvent("invalid JSON");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new InvalidTenantProjectionEvent("event must be an object");
  const type = (input as Record<string, unknown>).event_type;
  if (type !== "tenant.created") return null;
  const checked = validateEvent(input);
  if (!checked.ok)
    throw new InvalidTenantProjectionEvent("invalid tenant.created contract");
  const event = checked.event;
  if (
    event.aggregate_id !== event.tenant_id ||
    event.payload.tenant_id !== event.tenant_id
  )
    throw new InvalidTenantProjectionEvent("tenant identity mismatch");
  if (key?.toString("utf8") !== `${event.tenant_id}:${event.aggregate_id}`)
    throw new InvalidTenantProjectionEvent("tenant Kafka key mismatch");
  if (event.payload.organization_version !== event.aggregate_version)
    throw new InvalidTenantProjectionEvent("tenant version mismatch");
  return event;
}

// The projector principal alone has tenant INSERT/UPDATE. The version predicate
// makes repeated or reordered delivery harmless without a separate inbox table.
export async function applyTenantEvent(
  db: Db,
  event: DomainEvent,
): Promise<boolean> {
  const version = BigInt(event.aggregate_version);
  const name = event.payload.name as string;
  const state = event.payload.state as string;
  const region = event.payload.home_region as string;
  return withTenant(db, event.tenant_id, async (tx) => {
    const applied = await tx.$executeRaw`
      INSERT INTO tenants (tenant_id, name, state, home_region, version)
      VALUES (${event.tenant_id}::uuid, ${name}, ${state}, ${region}, ${version})
      ON CONFLICT (tenant_id) DO UPDATE
        SET name=EXCLUDED.name, state=EXCLUDED.state,
            home_region=EXCLUDED.home_region, version=EXCLUDED.version
      WHERE tenants.version < EXCLUDED.version`;
    return applied === 1;
  });
}

export async function startTenantProjector(
  db: Db,
  brokers: string[],
  groupId = "greenguard-inventory-tenant-v1",
  onFatal?: (error: Error) => void,
): Promise<() => Promise<void>> {
  const { consumer, producer, close } = createWorkerClients({
    moduleUrl: import.meta.url,
    brokers,
    clientId: "inventory-tenant-projector",
    groupId,
    missingBrokersMessage: "tenant projector requires Kafka brokers",
    onFatal,
  });
  await connectWorker(consumer, producer);
  try {
    await consumer.subscribe({ topic: TENANT_TOPIC, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachMessage: async (payload) => {
        await processWithDlq({
          consumer,
          producer,
          message: payload,
          dlqTopic: TENANT_DLQ_TOPIC,
          isInvalid: (error): error is InvalidTenantProjectionEvent =>
            error instanceof InvalidTenantProjectionEvent,
          process: async (message) => {
            if (!message.value)
              throw new InvalidTenantProjectionEvent("missing value");
            const event = decodeTenantEvent(message.value, message.key);
            if (event) await applyTenantEvent(db, event);
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
