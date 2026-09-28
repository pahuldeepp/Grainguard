import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "../db/client.js";
import { postgresCode } from "../db/errors.js";
import { isUuid, withTenant, type Tx } from "../db/tenant.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  appendEvent,
  DEFAULT_LOCK_TIMEOUT_MS,
  type CommandContext,
} from "./repository.js";
import {
  IdempotencyConflictError,
  InvalidInputError,
  InvalidReferenceError,
  VersionConflictError,
} from "./errors.js";
import {
  cableVersion,
  parseCable,
  type CableInput,
} from "./cable-validation.js";

export class CableNotFoundError extends Error {}
type Layout = Prisma.BinCableGetPayload<{ include: { sensors: true } }>;
const include = {
  sensors: {
    where: { status: "active" },
    orderBy: [{ position: "asc" as const }, { sensorId: "asc" as const }],
  },
};

export function cableDto(cable: Layout) {
  return {
    cableId: cable.cableId,
    binId: cable.binId,
    deviceId: cable.deviceId,
    label: cable.label,
    cableVersion: cable.version.toString(),
    status: cable.status,
    sensors: cable.sensors
      .filter((s) => s.status === "active")
      .map((s) => ({
        sensorId: s.sensorId,
        label: s.label,
        position: s.position,
        depthM: s.depthM,
      })),
  };
}

// Device rows are locked before cable rows in every command, including device
// moves. This protects binding eligibility while the owner event is committed.
async function lockDevices(tx: Tx, tenantId: string, ids: string[]) {
  for (const deviceId of [...new Set(ids)].sort(
    (a, b) => Number(a > b) - Number(a < b),
  )) {
    await tx.$queryRaw`SELECT device_id FROM devices
      WHERE tenant_id = ${tenantId}::uuid AND device_id = ${deviceId}::uuid FOR UPDATE`;
  }
}
async function requireBinding(tx: Tx, tenantId: string, input: CableInput) {
  const device = await tx.device.findFirst({
    where: {
      tenantId,
      deviceId: input.deviceId,
      binId: input.binId,
      status: "active",
    },
  });
  if (!device) throw new InvalidReferenceError();
  const bin = await tx.bin.findFirst({
    where: { tenantId, binId: input.binId, siteId: device.siteId },
  });
  if (!bin) throw new InvalidReferenceError();
}
async function layout(
  tx: Tx,
  tenantId: string,
  cableId: string,
): Promise<Layout> {
  const row = await tx.binCable.findFirst({
    where: { tenantId, cableId },
    include,
  });
  if (!row) throw new CableNotFoundError();
  return row;
}
async function event(
  tx: Tx,
  ctx: CommandContext,
  row: Layout,
  action: string,
  commandId = randomUUID(),
) {
  return appendEvent(tx, ctx, {
    commandId,
    aggregateType: "cable",
    aggregateId: row.cableId,
    version: row.version,
    eventType: "cable.layout_changed",
    action,
    payload: {
      cable_id: row.cableId,
      bin_id: row.binId,
      device_id: row.deviceId,
      cable_version: row.version.toString(),
      operation: row.status === "removed" ? "deleted" : "upsert",
      sensors:
        row.status === "removed"
          ? []
          : row.sensors
              .filter((s) => s.status === "active")
              .map((s) => ({
                sensor_id: s.sensorId,
                label: s.label,
                position: s.position,
                depth_m: s.depthM,
              })),
    },
  });
}
function referenceError(error: unknown): unknown {
  return postgresCode(error) === "23503" ? new InvalidReferenceError() : error;
}

export async function createCable(
  db: Db,
  ctx: CommandContext,
  value: CableInput,
) {
  const input = parseCable(value);
  const key = {
    tenantId: ctx.tenantId,
    commandType: "cable.create",
    idempotencyKey: ctx.idempotencyKey,
  };
  try {
    return await withTenant(
      db,
      ctx.tenantId,
      async (tx) => {
        const receiptLock = `${ctx.tenantId}:cable.create:${ctx.idempotencyKey}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${receiptLock}, 0))`;
        const receipt = await tx.commandReceipt.findUnique({
          where: { tenantId_commandType_idempotencyKey: key },
        });
        if (receipt) {
          if (!isDeepStrictEqual(receipt.normalizedRequest, input))
            throw new IdempotencyConflictError();
          return receipt.responseBody as unknown as ReturnType<
            typeof cableDto
          > & { eventId: string };
        }
        await lockDevices(tx, ctx.tenantId, [input.deviceId]);
        await requireBinding(tx, ctx.tenantId, input);
        const cableId = randomUUID();
        await tx.binCable.create({
          data: {
            tenantId: ctx.tenantId,
            cableId,
            binId: input.binId,
            deviceId: input.deviceId,
            label: input.label,
          },
        });
        if (input.sensors.length)
          await tx.cableSensor.createMany({
            data: input.sensors.map((s) => ({
              ...s,
              sensorId: randomUUID(),
              tenantId: ctx.tenantId,
              cableId,
            })),
          });
        const row = await layout(tx, ctx.tenantId, cableId);
        const commandId = randomUUID();
        const eventId = await event(tx, ctx, row, "cable.create", commandId);
        const response = { ...cableDto(row), eventId };
        await tx.commandReceipt.create({
          data: {
            ...key,
            commandId,
            normalizedRequest: input as unknown as Prisma.InputJsonObject,
            responseBody: response,
            acceptedAt: new Date(),
          },
        });
        return response;
      },
      { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS },
    );
  } catch (error) {
    throw referenceError(error);
  }
}

export async function changeCable(
  db: Db,
  ctx: CommandContext,
  cableId: string,
  expectedVersion: string,
  value: CableInput,
) {
  const input = parseCable(value, true);
  const expected = cableVersion(expectedVersion);
  try {
    return await withTenant(
      db,
      ctx.tenantId,
      async (tx) => {
        const previous = await layout(tx, ctx.tenantId, cableId);
        if (previous.status === "removed") throw new CableNotFoundError();
        if (previous.version !== expected)
          throw new VersionConflictError(previous.version.toString());
        await lockDevices(tx, ctx.tenantId, [
          previous.deviceId,
          input.deviceId,
        ]);
        await requireBinding(tx, ctx.tenantId, input);
        const updated = await tx.binCable.updateMany({
          where: {
            tenantId: ctx.tenantId,
            cableId,
            version: expected,
            status: "active",
          },
          data: {
            binId: input.binId,
            deviceId: input.deviceId,
            label: input.label,
            version: expected + 1n,
            updatedAt: new Date(),
          },
        });
        if (!updated.count) {
          const current = await layout(tx, ctx.tenantId, cableId);
          if (current.status === "removed") throw new CableNotFoundError();
          throw new VersionConflictError(current.version.toString());
        }
        const existing = new Map(previous.sensors.map((s) => [s.sensorId, s]));
        for (const sensor of input.sensors) {
          if (
            sensor.sensorId &&
            existing.get(sensor.sensorId)?.status !== "active"
          )
            throw new InvalidReferenceError();
        }
        // Positions can be swapped: first retire the current slots, then set the
        // new full layout. Stable sensor IDs stay on their original cable.
        await tx.cableSensor.updateMany({
          where: { tenantId: ctx.tenantId, cableId, status: "active" },
          data: { status: "removed" },
        });
        for (const sensor of input.sensors) {
          if (sensor.sensorId)
            await tx.cableSensor.updateMany({
              where: {
                tenantId: ctx.tenantId,
                cableId,
                sensorId: sensor.sensorId,
              },
              data: {
                label: sensor.label,
                position: sensor.position,
                depthM: sensor.depthM,
                status: "active",
              },
            });
          else
            await tx.cableSensor.create({
              data: {
                ...sensor,
                sensorId: randomUUID(),
                tenantId: ctx.tenantId,
                cableId,
              },
            });
        }
        const row = await layout(tx, ctx.tenantId, cableId);
        return {
          ...cableDto(row),
          eventId: await event(tx, ctx, row, "cable.change"),
        };
      },
      { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS },
    );
  } catch (error) {
    throw referenceError(error);
  }
}

export async function removeCable(
  db: Db,
  ctx: CommandContext,
  cableId: string,
  expectedVersion: string,
) {
  const expected = cableVersion(expectedVersion);
  return withTenant(
    db,
    ctx.tenantId,
    async (tx) => {
      const previous = await layout(tx, ctx.tenantId, cableId);
      if (previous.status === "removed") throw new CableNotFoundError();
      if (previous.version !== expected)
        throw new VersionConflictError(previous.version.toString());
      await lockDevices(tx, ctx.tenantId, [previous.deviceId]);
      const updated = await tx.binCable.updateMany({
        where: {
          tenantId: ctx.tenantId,
          cableId,
          version: expected,
          status: "active",
        },
        data: {
          status: "removed",
          version: expected + 1n,
          updatedAt: new Date(),
        },
      });
      if (!updated.count) {
        const current = await layout(tx, ctx.tenantId, cableId);
        if (current.status === "removed") throw new CableNotFoundError();
        throw new VersionConflictError(current.version.toString());
      }
      await tx.cableSensor.updateMany({
        where: { tenantId: ctx.tenantId, cableId, status: "active" },
        data: { status: "removed" },
      });
      const row = await layout(tx, ctx.tenantId, cableId);
      return {
        ...cableDto(row),
        eventId: await event(tx, ctx, row, "cable.remove"),
      };
    },
    { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS },
  );
}

export function getCable(db: Db, tenantId: string, cableId: string) {
  return withTenant(db, tenantId, async (tx) =>
    cableDto(await layout(tx, tenantId, cableId)),
  );
}
export function listCables(
  db: Db,
  tenantId: string,
  binId: string,
  limit: number,
  after?: string,
) {
  if (after !== undefined && !isUuid(after))
    throw new InvalidInputError("after must be a lowercase cable UUID");
  return withTenant(db, tenantId, async (tx) => {
    const bin = await tx.bin.findFirst({ where: { tenantId, binId } });
    if (!bin) throw new CableNotFoundError();
    const rows = await tx.binCable.findMany({
      where: {
        tenantId,
        binId,
        status: "active",
        ...(after && { cableId: { gt: after } }),
      },
      include,
      orderBy: { cableId: "asc" },
      take: Math.min(Math.max(Math.trunc(limit) || 1, 1), 20),
    });
    return rows.map(cableDto);
  });
}

// Called after a device mutation holds the device row lock. Cable snapshots
// move with the agricultural binding; physical asset_id never enters layouts.
export async function syncDeviceCables(
  tx: Tx,
  ctx: CommandContext,
  deviceId: string,
  binId: string | null,
  removing = false,
) {
  const rows = await tx.binCable.findMany({
    where: { tenantId: ctx.tenantId, deviceId, status: "active" },
    orderBy: { cableId: "asc" },
    include,
  });
  for (const row of rows) {
    await tx.binCable.updateMany({
      where: {
        tenantId: ctx.tenantId,
        cableId: row.cableId,
        version: row.version,
      },
      data: {
        ...(binId && { binId }),
        status: removing || !binId ? "removed" : "active",
        version: row.version + 1n,
        updatedAt: new Date(),
      },
    });
    if (removing || !binId)
      await tx.cableSensor.updateMany({
        where: {
          tenantId: ctx.tenantId,
          cableId: row.cableId,
          status: "active",
        },
        data: { status: "removed" },
      });
    await event(
      tx,
      ctx,
      await layout(tx, ctx.tenantId, row.cableId),
      removing || !binId ? "cable.device_removed" : "cable.device_moved",
    );
  }
}
