import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { isUuid, withTenant, type Tx } from "../db/tenant.js";
import { appendEvent, type CommandContext } from "../inventory/repository.js";
import { sagaTrace } from "./trace.js";

export interface InventoryCommand {
  tenant_id: string;
  saga_id: string;
  command_id: string;
  step: "inventory.activate" | "inventory.deactivate";
  saga_version: number;
  fencing_token: number;
  payload: { device_id: string; asset_id: string };
  /** The saga's sanitized W3C context; absent on pre-propagation commands. */
  traceparent?: string;
}

export interface InventoryResult {
  tenant_id: string;
  saga_id: string;
  command_id: string;
  result_id: string;
  step: InventoryCommand["step"];
  saga_version: number;
  fencing_token: number;
  outcome: "succeeded" | "rejected";
  traceparent?: string;
}

export class InvalidInventorySagaCommandError extends Error {}

export function decodeInventoryCommand(
  value: Buffer,
  key: Buffer,
): InventoryCommand | null {
  let command: unknown;
  try {
    command = JSON.parse(value.toString("utf8"));
  } catch {
    throw new InvalidInventorySagaCommandError("invalid saga command JSON");
  }
  if (typeof command !== "object" || command === null)
    throw new InvalidInventorySagaCommandError("invalid saga command");
  const c = command as Record<string, unknown>;
  if (c.step !== "inventory.activate" && c.step !== "inventory.deactivate")
    return null;
  const p = c.payload as Record<string, unknown> | undefined;
  if (
    !isUuid(String(c.tenant_id)) ||
    !isUuid(String(c.saga_id)) ||
    !isUuid(String(c.command_id)) ||
    !isUuid(String(p?.device_id)) ||
    !isUuid(String(p?.asset_id)) ||
    key.toString() !== `${c.tenant_id}:${c.saga_id}` ||
    !Number.isSafeInteger(c.saga_version) ||
    Number(c.saga_version) < 1 ||
    !Number.isSafeInteger(c.fencing_token) ||
    Number(c.fencing_token) < 1
  )
    throw new InvalidInventorySagaCommandError(
      "invalid inventory saga command fields",
    );
  const traceparent = sagaTrace(c.traceparent);
  const decoded = { ...c } as unknown as InventoryCommand;
  if (traceparent) decoded.traceparent = traceparent;
  else delete decoded.traceparent;
  return decoded;
}

// outbox_events.traceparent is mandatory. A command queued before trace
// propagation has none, so its events start one new random root trace.
function eventContext(c: InventoryCommand): CommandContext {
  const trace =
    sagaTrace(c.traceparent) ??
    `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
  return {
    tenantId: c.tenant_id,
    actorType: "service",
    actorId: "saga-orchestrator",
    correlationId: c.saga_id,
    traceparent: trace,
    idempotencyKey: c.command_id,
  };
}

interface DeviceRow {
  status: string;
  asset_id: string | null;
  active_saga_id: string | null;
  binding_version: bigint;
  serial_number: string;
  site_id: string;
  bin_id: string | null;
}

async function transition(
  tx: Tx,
  c: InventoryCommand,
): Promise<InventoryResult["outcome"]> {
  const rows = await tx.$queryRaw<DeviceRow[]>`
    SELECT status, asset_id, active_saga_id, binding_version, serial_number, site_id, bin_id
    FROM devices WHERE tenant_id=${c.tenant_id}::uuid AND device_id=${c.payload.device_id}::uuid
    FOR UPDATE`;
  const device = rows[0];
  if (device?.asset_id !== c.payload.asset_id) return "rejected";
  if (c.step === "inventory.activate") return activate(tx, c, device);
  return deactivate(tx, c, device);
}

async function activate(
  tx: Tx,
  c: InventoryCommand,
  d: DeviceRow,
): Promise<InventoryResult["outcome"]> {
  if (d.status === "active" && d.active_saga_id === c.saga_id)
    return "succeeded";
  if (
    d.status !== "provisioning" ||
    d.active_saga_id !== null ||
    d.binding_version !== 1n
  )
    return "rejected";
  await tx.$executeRaw`UPDATE devices SET status='active', active_saga_id=${c.saga_id}::uuid,
    updated_at=now() WHERE tenant_id=${c.tenant_id}::uuid AND device_id=${c.payload.device_id}::uuid`;
  await appendEvent(tx, eventContext(c), {
    commandId: c.command_id,
    eventType: "device.registered",
    aggregateType: "device",
    aggregateId: c.payload.device_id,
    version: 1n,
    payload: {
      device_id: c.payload.device_id,
      serial_number: d.serial_number,
      site_id: d.site_id,
      bin_id: d.bin_id,
      status: "active",
    },
    action: "saga.inventory.activate",
  });
  return "succeeded";
}

async function deactivate(
  tx: Tx,
  c: InventoryCommand,
  d: DeviceRow,
): Promise<InventoryResult["outcome"]> {
  // A deadline compensation can undo an activation that never happened. The
  // activate command precedes this one on the same Kafka key, so an untouched
  // provisioning device means there is nothing to undo.
  if (d.active_saga_id === null && d.status === "provisioning")
    return "succeeded";
  if (d.active_saga_id !== c.saga_id) return "rejected";
  if (d.status === "disabled") return "succeeded";
  if (d.status !== "active") return "rejected";
  const next = d.binding_version + 1n;
  await tx.$executeRaw`UPDATE devices SET status='disabled', binding_version=${next},
    updated_at=now() WHERE tenant_id=${c.tenant_id}::uuid AND device_id=${c.payload.device_id}::uuid`;
  await appendEvent(tx, eventContext(c), {
    commandId: c.command_id,
    eventType: "device.status_changed",
    aggregateType: "device",
    aggregateId: c.payload.device_id,
    version: next,
    payload: { device_id: c.payload.device_id, status: "disabled" },
    action: "saga.inventory.deactivate",
  });
  return "succeeded";
}

// The receipt, inventory mutation, CDC event, and result outbox commit together.
// Kafka redelivery returns the original result ID and cannot repeat a mutation.
export function applyInventoryCommand(
  db: Db,
  c: InventoryCommand,
): Promise<InventoryResult> {
  return withTenant(db, c.tenant_id, async (tx) => {
    const lockKey = `${c.tenant_id}:inventory-saga:${c.command_id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const existing = await tx.$queryRaw<
      (InventoryResult & { device_id: string; asset_id: string })[]
    >`
      SELECT tenant_id::text, saga_id::text, command_id::text, result_id::text,
        device_id::text, asset_id::text, step, saga_version, fencing_token, outcome FROM inventory_saga_receipts
      WHERE tenant_id=${c.tenant_id}::uuid AND command_id=${c.command_id}::uuid`;
    if (existing[0]) {
      const r = existing[0];
      if (
        r.saga_id !== c.saga_id ||
        r.step !== c.step ||
        r.device_id !== c.payload.device_id ||
        r.asset_id !== c.payload.asset_id ||
        Number(r.saga_version) !== c.saga_version ||
        Number(r.fencing_token) !== c.fencing_token
      )
        throw new InvalidInventorySagaCommandError(
          "saga command ID reused with conflicting fields",
        );
      return {
        tenant_id: r.tenant_id,
        saga_id: r.saga_id,
        command_id: r.command_id,
        result_id: r.result_id,
        step: r.step,
        saga_version: Number(r.saga_version),
        fencing_token: Number(r.fencing_token),
        outcome: r.outcome,
        ...(c.traceparent ? { traceparent: c.traceparent } : {}),
      };
    }
    const outcome = await transition(tx, c);
    const result: InventoryResult = {
      tenant_id: c.tenant_id,
      saga_id: c.saga_id,
      command_id: c.command_id,
      result_id: randomUUID(),
      step: c.step,
      saga_version: c.saga_version,
      fencing_token: c.fencing_token,
      outcome,
      ...(c.traceparent ? { traceparent: c.traceparent } : {}),
    };
    await tx.$executeRaw`INSERT INTO inventory_saga_receipts
      (tenant_id, command_id, saga_id, device_id, asset_id, step, saga_version, fencing_token, outcome, result_id)
      VALUES (${c.tenant_id}::uuid, ${c.command_id}::uuid, ${c.saga_id}::uuid,
      ${c.payload.device_id}::uuid, ${c.payload.asset_id}::uuid, ${c.step},
      ${c.saga_version}, ${c.fencing_token}, ${outcome}, ${result.result_id}::uuid)`;
    await tx.$executeRaw`INSERT INTO inventory_saga_result_outbox
      (tenant_id, result_id, command_id, saga_id, step, saga_version, fencing_token, outcome, traceparent)
      VALUES (${c.tenant_id}::uuid, ${result.result_id}::uuid, ${c.command_id}::uuid,
      ${c.saga_id}::uuid, ${c.step}, ${c.saga_version}, ${c.fencing_token}, ${outcome},
      ${c.traceparent ?? null})`;
    return result;
  });
}
