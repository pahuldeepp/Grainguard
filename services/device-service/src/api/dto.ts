import { InvalidInputError } from "../inventory/errors.js";
import type {
  DeviceStatus,
  RegisterDeviceInput,
} from "../inventory/repository.js";
import { isUuid } from "../db/tenant.js";
import {
  GRAIN_TYPE,
  isUtcMillis,
  placementTime,
} from "../inventory/lot-validation.js";
import { PreconditionRequiredError } from "./errors.js";

const STATUSES: ReadonlySet<string> = new Set([
  "active",
  "disabled",
  "deleted",
]);
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;
const ETAG = /^"(\d{1,19})"$/;

function object(body: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new InvalidInputError("Body must be a JSON object");
  for (const key of Object.keys(body))
    if (!allowed.includes(key))
      throw new InvalidInputError(`Unknown field: ${key.slice(0, 40)}`);
  return body as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    throw new InvalidInputError(`${field} must be 1-${max} characters`);
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !isUuid(value))
    throw new InvalidInputError(`${field} must be a lowercase UUID`);
  return value;
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : uuid(value, field);
}

export const parseSite = (body: unknown) => ({
  name: text(object(body, ["name"]).name, "name", 200),
});

export function parseBin(body: unknown) {
  const fields = object(body, ["siteId", "name"]);
  return {
    siteId: uuid(fields.siteId, "siteId"),
    name: text(fields.name, "name", 200),
  };
}

export function parseLotPlacement(body: unknown) {
  const fields = object(body, ["grainType", "variety", "effectiveFrom"]);
  const grainType = text(fields.grainType, "grainType", 32);
  if (!GRAIN_TYPE.test(grainType))
    throw new InvalidInputError("grainType must be a lowercase grain code");
  const variety =
    fields.variety == null ? null : text(fields.variety, "variety", 100);
  const effectiveFrom = text(fields.effectiveFrom, "effectiveFrom", 24);
  placementTime(effectiveFrom);
  return { grainType, variety, effectiveFrom };
}

export function parseObservedAt(value: string | undefined): Date {
  if (!isUtcMillis(value))
    throw new InvalidInputError(
      "observedAt must be a UTC millisecond timestamp",
    );
  return new Date(value);
}

export function parseRegister(body: unknown): RegisterDeviceInput {
  const fields = object(body, ["serialNumber", "siteId", "binId"]);
  return {
    serialNumber: text(fields.serialNumber, "serialNumber", 128),
    siteId: uuid(fields.siteId, "siteId"),
    binId: nullableUuid(fields.binId, "binId"),
  };
}

export function parseBinding(body: unknown) {
  const fields = object(body, ["siteId", "binId"]);
  return {
    siteId: uuid(fields.siteId, "siteId"),
    binId: nullableUuid(fields.binId, "binId"),
  };
}

export function parseStatus(body: unknown): DeviceStatus {
  const { status } = object(body, ["status"]);
  if (typeof status !== "string" || !STATUSES.has(status))
    throw new InvalidInputError("status must be active, disabled or deleted");
  return status as DeviceStatus;
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (value === undefined)
    throw new InvalidInputError("Idempotency-Key header is required");
  if (!IDEMPOTENCY_KEY.test(value))
    throw new InvalidInputError(
      "Idempotency-Key must be 1-200 printable characters without spaces",
    );
  return value;
}

export function parseIfMatch(value: string | undefined): string {
  if (value === undefined) throw new PreconditionRequiredError();
  const match = ETAG.exec(value);
  if (!match)
    throw new InvalidInputError(
      'If-Match must be a quoted version such as "3"',
    );
  return match[1];
}

export function parsePage(
  limit: string | undefined,
  after: string | undefined,
) {
  const parsed = limit === undefined ? 50 : Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500)
    throw new InvalidInputError("limit must be an integer from 1 to 500");
  return { limit: parsed, afterDeviceId: after };
}

export const etag = (version: bigint | string) => `"${version}"`;

interface DeviceRow {
  deviceId: string;
  siteId: string;
  binId: string | null;
  serialNumber: string;
  status: string;
  bindingVersion: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export const toDeviceDto = (device: DeviceRow) => ({
  deviceId: device.deviceId,
  siteId: device.siteId,
  binId: device.binId,
  serialNumber: device.serialNumber,
  status: device.status,
  bindingVersion: device.bindingVersion.toString(),
  createdAt: device.createdAt.toISOString(),
  updatedAt: device.updatedAt.toISOString(),
});
