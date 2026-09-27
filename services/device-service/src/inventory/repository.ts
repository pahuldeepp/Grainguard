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
import { GRAIN_TYPE, placementTime } from "./lot-validation.js";
import { assertDeviceCapacity } from "./entitlements.js";

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

export interface RegisterPendingDeviceInput extends RegisterDeviceInput {
  assetId: string;
}

export interface DeviceChanged {
  deviceId: string;
  bindingVersion: string;
  eventId: string;
}

export interface DeviceRegistered extends DeviceChanged {
  status: DeviceStatus;
}

export interface PendingDeviceRegistered {
  deviceId: string;
  assetId: string;
  status: "provisioning";
}

// A pending device is inventory-only. No device.registered event is emitted
// until the saga activates it, so existing telemetry consumers only see valid
// active/disabled/deleted lifecycle states.
export async function registerPendingDevice(
  db: Db,
  ctx: CommandContext,
  input: RegisterPendingDeviceInput,
): Promise<PendingDeviceRegistered> {
  const request = {
    serial_number: input.serialNumber,
    site_id: input.siteId,
    bin_id: input.binId ?? null,
    asset_id: input.assetId,
  };
  const key = {
    tenantId: ctx.tenantId,
    commandType: "device.register_pending",
    idempotencyKey: ctx.idempotencyKey,
  };
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const lockKey = `${ctx.tenantId}:device.register_pending:${ctx.idempotencyKey}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const receipt = await tx.commandReceipt.findUnique({
        where: { tenantId_commandType_idempotencyKey: key },
      });
      if (receipt) {
        if (!isDeepStrictEqual(receipt.normalizedRequest, request))
          throw new IdempotencyConflictError();
        return receipt.responseBody as unknown as PendingDeviceRegistered;
      }
      await assertDeviceCapacity(tx, ctx.tenantId);
      const deviceId = randomUUID();
      const commandId = randomUUID();
      await tx.device.create({
        data: {
          tenantId: ctx.tenantId,
          deviceId,
          assetId: input.assetId,
          siteId: input.siteId,
          binId: input.binId ?? null,
          serialNumber: input.serialNumber,
          status: "provisioning",
        },
      });
      const response: PendingDeviceRegistered = {
        deviceId,
        assetId: input.assetId,
        status: "provisioning",
      };
      await tx.auditEvent.createMany({
        data: {
          auditId: randomUUID(),
          tenantId: ctx.tenantId,
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          action: "device.register_pending",
          resourceType: "device",
          resourceId: deviceId,
          commandId,
          outcome: "succeeded",
          occurredAt: new Date(),
        },
      });
      await tx.commandReceipt.createMany({
        data: {
          ...key,
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

export interface EventSpec {
  commandId: string;
  eventType: string;
  aggregateType: "device" | "site" | "bin" | "bin_occupancy";
  aggregateId: string;
  version: bigint;
  payload: Record<string, string | null>;
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
export async function appendEvent(
  tx: Tx,
  ctx: CommandContext,
  spec: EventSpec,
) {
  const eventId = randomUUID();
  const occurredAt = new Date();
  await tx.outboxEvent.createMany({
    data: [
      {
        eventId,
        tenantId: ctx.tenantId,
        aggregateType: spec.aggregateType,
        aggregateId: spec.aggregateId,
        aggregateVersion: spec.version,
        eventType: spec.eventType,
        schemaVersion: 1,
        occurredAt,
        correlationId: ctx.correlationId,
        causationId: spec.commandId,
        traceparent: ctx.traceparent,
        payload:
          spec.aggregateType === "device"
            ? { ...spec.payload, binding_version: spec.version.toString() }
            : spec.payload,
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
        resourceType: spec.aggregateType,
        resourceId: spec.aggregateId,
        commandId: spec.commandId,
        eventId,
        outcome: "succeeded",
        occurredAt,
      },
    ],
  });
  return eventId;
}

interface FacilityCreated {
  name: string;
  eventId: string;
}

// The receipt lock serializes retries; future edits use optimistic version checks.
async function createFacility<T extends FacilityCreated>(
  db: Db,
  ctx: CommandContext,
  aggregateType: "site" | "bin",
  request: Record<string, string>,
  write: (tx: Tx) => Promise<{
    aggregateId: string;
    payload: Record<string, string>;
    response: Omit<T, "eventId">;
  }>,
): Promise<T> {
  const receiptKey = {
    tenantId: ctx.tenantId,
    commandType: `${aggregateType}.create`,
    idempotencyKey: ctx.idempotencyKey,
  };
  return withTenant(db, ctx.tenantId, async (tx) => {
    const lockKey = `${ctx.tenantId}:${receiptKey.commandType}:${ctx.idempotencyKey}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const receipt = await tx.commandReceipt.findUnique({
      where: { tenantId_commandType_idempotencyKey: receiptKey },
    });
    if (receipt) {
      if (!isDeepStrictEqual(receipt.normalizedRequest, request))
        throw new IdempotencyConflictError();
      return receipt.responseBody as unknown as T;
    }
    const result = await write(tx);
    const commandId = randomUUID();
    const eventId = await appendEvent(tx, ctx, {
      commandId,
      aggregateType,
      aggregateId: result.aggregateId,
      version: 1n,
      eventType: `${aggregateType}.changed`,
      payload: result.payload,
      action: receiptKey.commandType,
    });
    const response = { ...result.response, eventId };
    await tx.commandReceipt.create({
      data: {
        ...receiptKey,
        commandId,
        normalizedRequest: request,
        responseBody: response,
        acceptedAt: new Date(),
      },
    });
    return response as T;
  });
}

export function createSite(
  db: Db,
  ctx: CommandContext,
  siteId: string,
  name: string,
) {
  return createFacility<
    FacilityCreated & { siteId: string; siteVersion: string }
  >(db, ctx, "site", { name }, async (tx) => {
    await tx.site.create({ data: { tenantId: ctx.tenantId, siteId, name } });
    return {
      aggregateId: siteId,
      payload: { site_id: siteId, name, site_version: "1" },
      response: { siteId, name, siteVersion: "1" },
    };
  });
}

export async function createBin(
  db: Db,
  ctx: CommandContext,
  input: { binId: string; siteId: string; name: string },
) {
  try {
    return await createFacility<
      FacilityCreated & { binId: string; siteId: string; binVersion: string }
    >(
      db,
      ctx,
      "bin",
      { site_id: input.siteId, name: input.name },
      async (tx) => {
        await tx.bin.create({ data: { tenantId: ctx.tenantId, ...input } });
        return {
          aggregateId: input.binId,
          payload: {
            bin_id: input.binId,
            site_id: input.siteId,
            name: input.name,
            bin_version: "1",
          },
          response: { ...input, binVersion: "1" },
        };
      },
    );
  } catch (error) {
    throw postgresCode(error) === "23505"
      ? new DuplicateBinError()
      : mapWriteError(error);
  }
}

export interface PlaceGrainLotInput {
  binId: string;
  lotId?: string;
  grainType: string;
  variety?: string | null;
  effectiveFrom: string;
}

export interface GrainLotPlacement {
  binId: string;
  lotId: string;
  grainType: string;
  occupancyVersion: string;
  effectiveFrom: string;
  eventId: string;
}

// Receipt lock handles retries; a bin row lock serializes distinct placement
// commands. The exclusion constraint additionally forbids overlapping ranges.
export async function placeGrainLot(
  db: Db,
  ctx: CommandContext,
  input: PlaceGrainLotInput,
): Promise<GrainLotPlacement> {
  if (
    !isUuid(input.binId) ||
    (input.lotId !== undefined && !isUuid(input.lotId))
  )
    throw new InvalidInputError("binId and lotId must be lowercase UUIDs");
  if (!GRAIN_TYPE.test(input.grainType))
    throw new InvalidInputError("grainType must be a lowercase grain code");
  if (
    input.variety != null &&
    (input.variety.length < 1 || input.variety.length > 100)
  )
    throw new InvalidInputError("variety must be 1-100 characters");
  const effectiveFrom = placementTime(input.effectiveFrom);
  const request = {
    bin_id: input.binId,
    lot_id: input.lotId ?? null,
    grain_type: input.grainType,
    variety: input.variety ?? null,
    effective_from: input.effectiveFrom,
  };
  const receiptKey = {
    tenantId: ctx.tenantId,
    commandType: "lot.place",
    idempotencyKey: ctx.idempotencyKey,
  };
  return withTenant(
    db,
    ctx.tenantId,
    async (tx) => {
      const lockKey = `${ctx.tenantId}:${receiptKey.commandType}:${ctx.idempotencyKey}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const receipt = await tx.commandReceipt.findUnique({
        where: { tenantId_commandType_idempotencyKey: receiptKey },
      });
      if (receipt) {
        if (!isDeepStrictEqual(receipt.normalizedRequest, request))
          throw new IdempotencyConflictError();
        return receipt.responseBody as unknown as GrainLotPlacement;
      }
      const lotId = input.lotId ?? randomUUID();
      const bins = await tx.$queryRaw<{ site_id: string }[]>`
      SELECT site_id FROM bins WHERE tenant_id = ${ctx.tenantId}::uuid
        AND bin_id = ${input.binId}::uuid FOR UPDATE`;
      if (bins.length !== 1) throw new InvalidReferenceError();
      const previous = await tx.binOccupancy.findFirst({
        where: {
          tenantId: ctx.tenantId,
          binId: input.binId,
          effectiveTo: null,
        },
      });
      if (previous && effectiveFrom <= previous.effectiveFrom)
        throw new InvalidInputError(
          "effectiveFrom must follow the current batch start",
        );
      const next = previous ? previous.occupancyVersion + 1n : 1n;
      if (previous) {
        await tx.binOccupancy.update({
          where: {
            tenantId_binId_occupancyVersion: {
              tenantId: ctx.tenantId,
              binId: input.binId,
              occupancyVersion: previous.occupancyVersion,
            },
          },
          data: { effectiveTo: effectiveFrom },
        });
      }
      await tx.grainLot.create({
        data: {
          tenantId: ctx.tenantId,
          lotId,
          grainType: input.grainType,
          variety: input.variety ?? null,
        },
      });
      await tx.binOccupancy.create({
        data: {
          tenantId: ctx.tenantId,
          binId: input.binId,
          occupancyVersion: next,
          lotId,
          effectiveFrom,
        },
      });
      const commandId = randomUUID();
      const eventId = await appendEvent(tx, ctx, {
        commandId,
        eventType: "lot.changed",
        aggregateType: "bin_occupancy",
        aggregateId: input.binId,
        version: next,
        payload: {
          bin_id: input.binId,
          site_id: bins[0].site_id,
          lot_id: lotId,
          grain_type: input.grainType,
          variety: input.variety ?? null,
          occupancy_version: next.toString(),
          effective_from: input.effectiveFrom,
          previous_lot_id: previous?.lotId ?? null,
        },
        action: "lot.place",
      });
      const response = {
        binId: input.binId,
        lotId,
        grainType: input.grainType,
        occupancyVersion: next.toString(),
        effectiveFrom: input.effectiveFrom,
        eventId,
      };
      await tx.commandReceipt.create({
        data: {
          ...receiptKey,
          commandId,
          normalizedRequest: request,
          responseBody: response,
          acceptedAt: new Date(),
        },
      });
      return response;
    },
    { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS },
  );
}

// Risk consumers use this same as-of rule on their own local lot projection.
// This owner query is a reference for event-time correctness and tenant RLS.
export function grainLotAt(
  db: Db,
  tenantId: string,
  binId: string,
  observedAt: Date,
) {
  if (!isUuid(binId) || Number.isNaN(observedAt.getTime()))
    throw new InvalidInputError("valid binId and observedAt are required");
  return withTenant(db, tenantId, async (tx) => {
    const occupancy = await tx.binOccupancy.findFirst({
      where: {
        tenantId,
        binId,
        effectiveFrom: { lte: observedAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: observedAt } }],
      },
      include: { lot: true },
      orderBy: { occupancyVersion: "desc" },
    });
    return (
      occupancy && {
        binId,
        lotId: occupancy.lotId,
        grainType: occupancy.lot.grainType,
        occupancyVersion: occupancy.occupancyVersion.toString(),
        effectiveFrom: occupancy.effectiveFrom.toISOString(),
        effectiveTo: occupancy.effectiveTo?.toISOString() ?? null,
      }
    );
  });
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
      await assertDeviceCapacity(tx, ctx.tenantId);
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
        aggregateType: "device",
        aggregateId: deviceId,
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
          status: { not: "provisioning" },
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
          select: { bindingVersion: true, status: true },
        });
        if (!current) throw new DeviceNotFoundError();
        if (current.status === "provisioning")
          throw new InvalidInputError(
            "pending device binding is fixed until provisioning completes",
          );
        throw new VersionConflictError(current.bindingVersion.toString());
      }
      const eventId = await appendEvent(tx, ctx, {
        commandId: randomUUID(),
        eventType: "device.binding_changed",
        aggregateType: "device",
        aggregateId: input.deviceId,
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
): Promise<
  | {
      bindingVersion: bigint;
      status: string;
      assetId: string | null;
      activeSagaId: string | null;
    }
  | undefined
> {
  const rows = noWait
    ? await tx.$queryRaw<
        {
          binding_version: bigint;
          status: string;
          asset_id: string | null;
          active_saga_id: string | null;
        }[]
      >`
        SELECT binding_version, status, asset_id, active_saga_id FROM devices
        WHERE tenant_id = ${tenantId}::uuid AND device_id = ${deviceId}::uuid
        FOR UPDATE NOWAIT`
    : await tx.$queryRaw<
        {
          binding_version: bigint;
          status: string;
          asset_id: string | null;
          active_saga_id: string | null;
        }[]
      >`
        SELECT binding_version, status, asset_id, active_saga_id FROM devices
        WHERE tenant_id = ${tenantId}::uuid AND device_id = ${deviceId}::uuid
        FOR UPDATE`;
  const row = rows[0];
  return (
    row && {
      bindingVersion: row.binding_version,
      status: row.status,
      assetId: row.asset_id ?? null,
      activeSagaId: row.active_saga_id ?? null,
    }
  );
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
      if (locked.status === "provisioning" || locked.assetId !== null)
        throw new InvalidInputError(
          "saga-managed device status must change through provisioning workflow",
        );
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
        aggregateType: "device",
        aggregateId: input.deviceId,
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
