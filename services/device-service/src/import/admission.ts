import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { withTenant, type Tx } from "../db/tenant.js";
import { postgresCode } from "../db/errors.js";
import { assertDeviceCapacity } from "../inventory/entitlements.js";
import {
  DuplicateBinError,
  DuplicateSerialError,
  InvalidInputError,
  InvalidReferenceError,
} from "../inventory/errors.js";
import { appendEvent, type CommandContext } from "../inventory/repository.js";
import { syncDeviceCables } from "../inventory/cables.js";
import { parseImportChange, type ImportChange } from "./contract.js";

export class ImportConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export interface ImportResult {
  outcome: "applied" | "stale";
  entityId: string;
  aggregateVersion: string;
  eventIds: string[];
}
const keyOf = (change: ImportChange, tenantId: string) => ({
  tenantId,
  sourceId: change.source_id,
  entityType: change.entity_type,
  externalId: change.external_id,
});
const sourceLock = (change: ImportChange, tenantId: string) =>
  `${tenantId}:import:${change.source_id}:${change.entity_type}:${change.external_id}`;

async function requireImportedParent(
  tx: Tx,
  tenantId: string,
  sourceId: string,
  entityType: "site" | "bin",
  entityId: string,
): Promise<void> {
  const count = await tx.inventoryImportState.count({
    where: { tenantId, sourceId, entityType, entityId },
  });
  if (count !== 1) throw new InvalidReferenceError();
}

async function applySite(
  tx: Tx,
  ctx: CommandContext,
  change: ImportChange,
): Promise<ImportResult> {
  const { entity_id: siteId } = change;
  const name = change.payload.name!;
  const current = await tx.site.findUnique({
    where: { tenantId_siteId: { tenantId: ctx.tenantId, siteId } },
  });
  if (change.operation === "delete")
    throw new InvalidInputError("facility delete requires quarantine");
  if (current)
    await tx.site.update({
      where: { tenantId_siteId: { tenantId: ctx.tenantId, siteId } },
      data: { name, version: { increment: 1 } },
    });
  else await tx.site.create({ data: { tenantId: ctx.tenantId, siteId, name } });
  const version = current ? current.version + 1n : 1n;
  const eventId = await appendEvent(tx, ctx, {
    commandId: randomUUID(),
    eventType: "site.changed",
    aggregateType: "site",
    aggregateId: siteId,
    version,
    payload: { site_id: siteId, name, site_version: version.toString() },
    action: "site.import",
  });
  return {
    outcome: "applied",
    entityId: siteId,
    aggregateVersion: version.toString(),
    eventIds: [eventId],
  };
}
async function applyBin(
  tx: Tx,
  ctx: CommandContext,
  change: ImportChange,
): Promise<ImportResult> {
  const { entity_id: binId } = change;
  const siteId = change.payload.site_id!;
  const name = change.payload.name!;
  await requireImportedParent(
    tx,
    ctx.tenantId,
    change.source_id,
    "site",
    siteId,
  );
  const current = await tx.bin.findUnique({
    where: { tenantId_binId: { tenantId: ctx.tenantId, binId } },
  });
  if (change.operation === "delete")
    throw new InvalidInputError("facility delete requires quarantine");
  if (current && current.siteId !== siteId)
    throw new ImportConflictError("bin relocation is unsupported");
  if (current)
    await tx.bin.update({
      where: { tenantId_binId: { tenantId: ctx.tenantId, binId } },
      data: { name, version: { increment: 1 } },
    });
  else
    await tx.bin.create({
      data: { tenantId: ctx.tenantId, binId, siteId, name },
    });
  const version = current ? current.version + 1n : 1n;
  const eventId = await appendEvent(tx, ctx, {
    commandId: randomUUID(),
    eventType: "bin.changed",
    aggregateType: "bin",
    aggregateId: binId,
    version,
    payload: {
      bin_id: binId,
      site_id: siteId,
      name,
      bin_version: version.toString(),
    },
    action: "bin.import",
  });
  return {
    outcome: "applied",
    entityId: binId,
    aggregateVersion: version.toString(),
    eventIds: [eventId],
  };
}
async function applyDevice(
  tx: Tx,
  ctx: CommandContext,
  change: ImportChange,
): Promise<ImportResult> {
  const { entity_id: deviceId } = change;
  const siteId = change.payload.site_id!;
  const binId = change.payload.bin_id;
  const serialNumber = change.payload.serial_number!;
  const status =
    change.operation === "delete" ? "deleted" : change.payload.status!;
  await requireImportedParent(
    tx,
    ctx.tenantId,
    change.source_id,
    "site",
    siteId,
  );
  if (binId)
    await requireImportedParent(
      tx,
      ctx.tenantId,
      change.source_id,
      "bin",
      binId,
    );
  const currentRows = await tx.$queryRaw<
    {
      site_id: string;
      bin_id: string | null;
      serial_number: string;
      status: string;
      binding_version: bigint;
      asset_id: string | null;
    }[]
  >`
    SELECT site_id, bin_id, serial_number, status, binding_version, asset_id
    FROM devices WHERE tenant_id = ${ctx.tenantId}::uuid AND device_id = ${deviceId}::uuid
    FOR UPDATE`;
  const current = currentRows[0];
  if (!current) {
    if (status !== "deleted") await assertDeviceCapacity(tx, ctx.tenantId);
    await tx.device.create({
      data: {
        tenantId: ctx.tenantId,
        deviceId,
        siteId,
        binId,
        serialNumber,
        status,
      },
    });
    const eventId = await appendEvent(tx, ctx, {
      commandId: randomUUID(),
      eventType: "device.registered",
      aggregateType: "device",
      aggregateId: deviceId,
      version: 1n,
      payload: {
        device_id: deviceId,
        serial_number: serialNumber,
        site_id: siteId,
        bin_id: binId,
        status,
      },
      action: "device.import",
    });
    return {
      outcome: "applied",
      entityId: deviceId,
      aggregateVersion: "1",
      eventIds: [eventId],
    };
  }
  if (current.asset_id !== null || current.status === "provisioning")
    throw new ImportConflictError("saga-managed device cannot be imported");
  if (current.serial_number !== serialNumber)
    throw new ImportConflictError(
      "serial number changes have no canonical v1 event",
    );
  if (current.status === "deleted" && status !== "deleted")
    await assertDeviceCapacity(tx, ctx.tenantId);
  const bindingChanged = current.site_id !== siteId || current.bin_id !== binId;
  const statusChanged = current.status !== status;
  const eventIds: string[] = [];
  let version = current.binding_version;
  if (bindingChanged) {
    version++;
    eventIds.push(
      await appendEvent(tx, ctx, {
        commandId: randomUUID(),
        eventType: "device.binding_changed",
        aggregateType: "device",
        aggregateId: deviceId,
        version,
        payload: { device_id: deviceId, site_id: siteId, bin_id: binId },
        action: "device.import_binding",
      }),
    );
  }
  if (statusChanged || !bindingChanged) {
    version++;
    eventIds.push(
      await appendEvent(tx, ctx, {
        commandId: randomUUID(),
        eventType: "device.status_changed",
        aggregateType: "device",
        aggregateId: deviceId,
        version,
        payload: { device_id: deviceId, status },
        action: "device.import_status",
      }),
    );
  }
  await tx.device.update({
    where: { tenantId_deviceId: { tenantId: ctx.tenantId, deviceId } },
    data: {
      siteId,
      binId,
      status,
      bindingVersion: version,
      updatedAt: new Date(),
    },
  });
  if (bindingChanged || status === "deleted")
    await syncDeviceCables(tx, ctx, deviceId, binId, status === "deleted");
  return {
    outcome: "applied",
    entityId: deviceId,
    aggregateVersion: version.toString(),
    eventIds,
  };
}

/** Atomic source fence, canonical mutation, outbox and audit admission. */
export async function admitImport(
  db: Db,
  ctx: CommandContext,
  body: unknown,
  expectedSourceId: string,
): Promise<ImportResult> {
  const change = parseImportChange(body, ctx.tenantId);
  if (change.source_id !== expectedSourceId)
    throw new InvalidInputError("source ID does not match configured importer");
  if (change.operation === "delete" && change.entity_type !== "device")
    throw new InvalidInputError("facility delete requires quarantine");
  try {
    return await withTenant(
      db,
      ctx.tenantId,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${sourceLock(change, ctx.tenantId)}, 0))`;
        const key = keyOf(change, ctx.tenantId);
        const previous = await tx.inventoryImportState.findUnique({
          where: { tenantId_sourceId_entityType_externalId: key },
        });
        const coordinate = change.source_coordinate;
        const offset = BigInt(coordinate.offset);
        if (previous) {
          if (
            previous.entityId !== change.entity_id ||
            previous.connectorGeneration !== coordinate.connector_generation ||
            previous.topic !== coordinate.topic ||
            previous.partitionId !== coordinate.partition
          )
            throw new ImportConflictError(
              "source entity coordinate lineage changed",
            );
          if (offset < previous.sourceOffset)
            return {
              ...(previous.responseBody as unknown as ImportResult),
              outcome: "stale",
            };
          if (offset === previous.sourceOffset) {
            if (previous.payloadSha256 !== change.payload_sha256)
              throw new ImportConflictError(
                "source coordinate reused with different bytes",
              );
            return previous.responseBody as unknown as ImportResult;
          }
        } else {
          if (change.operation === "delete")
            throw new ImportConflictError(
              "source delete has no previously admitted entity",
            );
          // A deterministic ID is import-owned only when its source state already
          // exists. Refuse a collision with a human-created canonical entity.
          const existing =
            change.entity_type === "site"
              ? await tx.site.findUnique({
                  where: {
                    tenantId_siteId: {
                      tenantId: ctx.tenantId,
                      siteId: change.entity_id,
                    },
                  },
                })
              : change.entity_type === "bin"
                ? await tx.bin.findUnique({
                    where: {
                      tenantId_binId: {
                        tenantId: ctx.tenantId,
                        binId: change.entity_id,
                      },
                    },
                  })
                : await tx.device.findUnique({
                    where: {
                      tenantId_deviceId: {
                        tenantId: ctx.tenantId,
                        deviceId: change.entity_id,
                      },
                    },
                  });
          if (existing)
            throw new ImportConflictError(
              "canonical identity is already owned",
            );
        }
        const response =
          change.entity_type === "site"
            ? await applySite(tx, ctx, change)
            : change.entity_type === "bin"
              ? await applyBin(tx, ctx, change)
              : await applyDevice(tx, ctx, change);
        if (previous)
          await tx.inventoryImportState.update({
            where: { tenantId_sourceId_entityType_externalId: key },
            data: {
              sourceOffset: offset,
              payloadSha256: change.payload_sha256,
              responseBody: { ...response },
              updatedAt: new Date(),
            },
          });
        else
          await tx.inventoryImportState.create({
            data: {
              ...key,
              entityId: change.entity_id,
              connectorGeneration: coordinate.connector_generation,
              topic: coordinate.topic,
              partitionId: coordinate.partition,
              sourceOffset: offset,
              payloadSha256: change.payload_sha256,
              responseBody: { ...response },
            },
          });
        return response;
      },
      { lockTimeoutMs: 2000, timeoutMs: 10000 },
    );
  } catch (error) {
    switch (postgresCode(error)) {
      case "23503":
        throw new InvalidReferenceError();
      case "23505":
        throw change.entity_type === "bin"
          ? new DuplicateBinError()
          : new DuplicateSerialError();
      default:
        throw error;
    }
  }
}
