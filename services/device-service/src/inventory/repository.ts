import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "../db/client.js";
import { postgresCode } from "../db/errors.js";
import {
  isUuid,
  withTenant,
  type TenantTxOptions,
  type Tx,
} from "../db/tenant.js";
import {
  DeviceNotFoundError,
  DuplicateBinError,
  DuplicateSerialError,
  IdempotencyConflictError,
  InvalidInputError,
  InvalidReferenceError,
  VersionConflictError,
} from "./errors.js";

export interface CommandContext {
  tenantId: string;
  actorType: "user" | "service";
  actorId: string;
  correlationId: string;
  traceparent: string;
  idempotencyKey: string;
}

export type DeviceStatus = "active" | "disabled" | "deleted";

export interface RegisterDeviceInput {
  serialNumber: string;
  siteId: string;
  binId?: string | null;
}

export interface DeviceChanged {
  deviceId: string;
  bindingVersion: string;
  eventId: string;
}

export interface DeviceRegistered extends DeviceChanged {
  status: DeviceStatus;
}

interface EventSpec {
  commandId: string;
  eventType: string;
  deviceId: string;
  version: bigint;
  payload: Record<string, unknown>;
  action: string;
}

function mapWriteError(error: unknown): unknown {
  switch (postgresCode(error)) {
    case "23505":
      return new DuplicateSerialError();
    case "23503":
      return new InvalidReferenceError();
    default:
      return error;
  }
}

// Domain change, outbox event and audit record commit in the caller's transaction.
async function appendEvent(tx: Tx, ctx: CommandContext, spec: EventSpec) {
  const eventId = randomUUID();
  const occurredAt = new Date();
  await tx.outboxEvent.createMany({
    data: [
      {
        eventId,
        tenantId: ctx.tenantId,
        aggregateType: "device",
        aggregateId: spec.deviceId,
        aggregateVersion: spec.version,
        eventType: spec.eventType,
        schemaVersion: 1,
        occurredAt,
        correlationId: ctx.correlationId,
        causationId: spec.commandId,
        traceparent: ctx.traceparent,
        payload: { ...spec.payload, binding_version: spec.version.toString() },
      },
    ],
  });
  await tx.auditEvent.createMany({
    data: [
      {
        auditId: randomUUID(),
        tenantId: ctx.tenantId,
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        action: spec.action,
        resourceType: "device",
        resourceId: spec.deviceId,
        commandId: spec.commandId,
        eventId,
        outcome: "succeeded",
        occurredAt,
      },
    ],
  });
  return eventId;
}

export async function createTenant(db: Db, tenantId: string, name: string) {
  await withTenant(db, tenantId, (tx) =>
    tx.tenant.create({ data: { tenantId, name } }),
  );
}

export async function createSite(
  db: Db,
  tenantId: string,
  siteId: string,
  name: string,
) {
  await withTenant(db, tenantId, (tx) =>
    tx.site.create({ data: { tenantId, siteId, name } }),
  );
}

export async function createBin(
  db: Db,
  tenantId: string,
  input: { binId: string; siteId: string; name: string },
) {
  try {
    await withTenant(db, tenantId, (tx) =>
      tx.bin.create({ data: { tenantId, ...input } }),
    );
  } catch (error) {
    throw postgresCode(error) === "23505"
      ? new DuplicateBinError()
      : mapWriteError(error);
  }
}

// Idempotent: a retry with the same key and request returns the original result;
// the same key with a different request is rejected.
export async function registerDevice(
  db: Db,
  ctx: CommandContext,
  input: RegisterDeviceInput,
): Promise<DeviceRegistered> {
  const request = {
    serial_number: input.serialNumber,
    site_id: input.siteId,
    bin_id: input.binId ?? null,
  };
  const receiptKey = {
    tenantId: ctx.tenantId,
    commandType: "device.register",
    idempotencyKey: ctx.idempotencyKey,
  };
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      // Pessimistic, transaction-scoped: concurrent retries of one command queue here
      // instead of racing to insert. Safe under PgBouncer transaction pooling.
      const lockKey = `${ctx.tenantId}:device.register:${ctx.idempotencyKey}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const receipt = await tx.commandReceipt.findUnique({
        where: { tenantId_commandType_idempotencyKey: receiptKey },
      });
      if (receipt) {
        if (!isDeepStrictEqual(receipt.normalizedRequest, request))
          throw new IdempotencyConflictError();
        return receipt.responseBody as unknown as DeviceRegistered;
      }
      const deviceId = randomUUID();
      const commandId = randomUUID();
      await tx.device.create({
        data: {
          tenantId: ctx.tenantId,
          deviceId,
          siteId: input.siteId,
          binId: input.binId ?? null,
          serialNumber: input.serialNumber,
          status: "active",
        },
      });
      const eventId = await appendEvent(tx, ctx, {
        commandId,
        eventType: "device.registered",
        deviceId,
        version: 1n,
        payload: { device_id: deviceId, ...request, status: "active" },
        action: "device.register",
      });
      const response: DeviceRegistered = {
        deviceId,
        bindingVersion: "1",
        eventId,
        status: "active",
      };
      await tx.commandReceipt.create({
        data: {
          ...receiptKey,
          commandId,
          normalizedRequest: request,
          responseBody: { ...response },
          acceptedAt: new Date(),
        },
      });
      return response;
    });
  } catch (error) {
    throw mapWriteError(error);
  }
}

// Optimistic concurrency: the caller supplies the version it last read. A stale
// version changes nothing and reports the current version (HTTP 409).
export async function changeDeviceBinding(
  db: Db,
  ctx: CommandContext,
  input: {
    deviceId: string;
    expectedVersion: string;
    siteId: string;
    binId: string | null;
  },
): Promise<DeviceChanged> {
  if (!/^[1-9]\d{0,18}$/.test(input.expectedVersion))
    throw new InvalidInputError(
      "expectedVersion must be a positive integer string",
    );
  const expected = BigInt(input.expectedVersion);
  const next = expected + 1n;
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const { count } = await tx.device.updateMany({
        where: {
          tenantId: ctx.tenantId,
          deviceId: input.deviceId,
          bindingVersion: expected,
        },
        data: {
          siteId: input.siteId,
          binId: input.binId,
          bindingVersion: next,
          updatedAt: new Date(),
        },
      });
      if (count === 0) {
        const current = await tx.device.findUnique({
          where: {
            tenantId_deviceId: {
              tenantId: ctx.tenantId,
              deviceId: input.deviceId,
            },
          },
          select: { bindingVersion: true },
        });
        if (!current) throw new DeviceNotFoundError();
        throw new VersionConflictError(current.bindingVersion.toString());
      }
      const eventId = await appendEvent(tx, ctx, {
        commandId: randomUUID(),
        eventType: "device.binding_changed",
        deviceId: input.deviceId,
        version: next,
        payload: {
          device_id: input.deviceId,
          site_id: input.siteId,
          bin_id: input.binId,
        },
        action: "device.change_binding",
      });
      return {
        deviceId: input.deviceId,
        bindingVersion: next.toString(),
        eventId,
      };
    });
  } catch (error) {
    throw mapWriteError(error);
  }
}

// Pessimistic concurrency: lock the row, then read-modify-write. Used for
// server-side commands that have no client-supplied version.
export async function lockDevice(
  tx: Tx,
  tenantId: string,
  deviceId: string,
  noWait = false,
): Promise<{ bindingVersion: bigint; status: string } | undefined> {
  const rows = noWait
    ? await tx.$queryRaw<{ binding_version: bigint; status: string }[]>`
        SELECT binding_version, status FROM devices
        WHERE tenant_id = ${tenantId}::uuid AND device_id = ${deviceId}::uuid
        FOR UPDATE NOWAIT`
    : await tx.$queryRaw<{ binding_version: bigint; status: string }[]>`
        SELECT binding_version, status FROM devices
        WHERE tenant_id = ${tenantId}::uuid AND device_id = ${deviceId}::uuid
        FOR UPDATE`;
  const row = rows[0];
  return row && { bindingVersion: row.binding_version, status: row.status };
}

export const DEFAULT_LOCK_TIMEOUT_MS = 2000;

export async function setDeviceStatus(
  db: Db,
  ctx: CommandContext,
  input: { deviceId: string; status: DeviceStatus; noWait?: boolean },
  options: TenantTxOptions = {},
): Promise<DeviceChanged> {
  return withTenant(
    db,
    ctx.tenantId,
    async (tx) => {
      const locked = await lockDevice(
        tx,
        ctx.tenantId,
        input.deviceId,
        input.noWait,
      );
      if (!locked) throw new DeviceNotFoundError();
      const next = locked.bindingVersion + 1n;
      await tx.device.update({
        where: {
          tenantId_deviceId: {
            tenantId: ctx.tenantId,
            deviceId: input.deviceId,
          },
        },
        data: {
          status: input.status,
          bindingVersion: next,
          updatedAt: new Date(),
        },
      });
      const eventId = await appendEvent(tx, ctx, {
        commandId: randomUUID(),
        eventType: "device.status_changed",
        deviceId: input.deviceId,
        version: next,
        payload: { device_id: input.deviceId, status: input.status },
        action: "device.set_status",
      });
      return {
        deviceId: input.deviceId,
        bindingVersion: next.toString(),
        eventId,
      };
    },
    // A pessimistic lock never waits unbounded, whatever else the caller sets.
    { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS, ...options },
  );
}

export const MAX_PAGE_SIZE = 500;

// Keyset pagination: bounded pages ordered by device ID, always inside one tenant.
export async function listDevices(
  db: Db,
  tenantId: string,
  page: { limit: number; afterDeviceId?: string },
) {
  if (page.afterDeviceId !== undefined && !isUuid(page.afterDeviceId))
    throw new InvalidInputError("afterDeviceId must be a lowercase UUID");
  const take = Math.min(
    Math.max(Math.trunc(page.limit) || 1, 1),
    MAX_PAGE_SIZE,
  );
  return withTenant(db, tenantId, (tx) =>
    tx.device.findMany({
      where: {
        tenantId,
        ...(page.afterDeviceId && { deviceId: { gt: page.afterDeviceId } }),
      },
      orderBy: { deviceId: "asc" },
      take,
    }),
  );
}

export function getDevice(db: Db, tenantId: string, deviceId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx.device.findUnique({
      where: { tenantId_deviceId: { tenantId, deviceId } },
    }),
  );
}
