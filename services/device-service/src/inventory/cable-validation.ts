import { isUuid } from "../db/tenant.js";
import { InvalidInputError } from "./errors.js";

// API work/response bounds, not hardware limits or agronomic calibration.
export const MAX_SENSORS_PER_CABLE = 100;
export interface SensorInput {
  sensorId?: string;
  label: string;
  position: number;
  depthM: number | null;
}
export interface CableInput {
  binId: string;
  deviceId: string;
  label: string;
  sensors: SensorInput[];
}

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidInputError("Body must be a JSON object");
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new InvalidInputError(`Unknown field: ${key.slice(0, 40)}`);
  return value as Record<string, unknown>;
}
function label(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 200
  )
    throw new InvalidInputError("label must be 1-200 nonblank characters");
  return value;
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !isUuid(value))
    throw new InvalidInputError(`${field} must be a lowercase UUID`);
  return value;
}
export function parseCable(body: unknown, editing = false): CableInput {
  const value = object(body, ["binId", "deviceId", "label", "sensors"]);
  if (
    !Array.isArray(value.sensors) ||
    value.sensors.length > MAX_SENSORS_PER_CABLE
  )
    throw new InvalidInputError(
      `sensors must be an array of at most ${MAX_SENSORS_PER_CABLE} entries`,
    );
  const ids = new Set<string>();
  const positions = new Set<number>();
  const sensors = value.sensors.map((item): SensorInput => {
    const sensor = object(item, [
      "label",
      "position",
      "depthM",
      ...(editing ? ["sensorId"] : []),
    ]);
    const sensorId =
      sensor.sensorId === undefined
        ? undefined
        : uuid(sensor.sensorId, "sensorId");
    if (sensorId && ids.has(sensorId))
      throw new InvalidInputError("Duplicate sensorId");
    if (sensorId) ids.add(sensorId);
    const position = sensor.position;
    if (
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > MAX_SENSORS_PER_CABLE ||
      positions.has(position)
    )
      throw new InvalidInputError(
        "positions must be distinct positive integers within the sensor limit",
      );
    positions.add(position);
    const depthM = sensor.depthM ?? null;
    if (
      depthM !== null &&
      (typeof depthM !== "number" || !Number.isFinite(depthM) || depthM < 0)
    )
      throw new InvalidInputError(
        "depthM must be finite nonnegative meters or null",
      );
    return {
      ...(sensorId && { sensorId }),
      label: label(sensor.label),
      position,
      depthM: depthM as number | null,
    };
  });
  return {
    binId: uuid(value.binId, "binId"),
    deviceId: uuid(value.deviceId, "deviceId"),
    label: label(value.label),
    sensors: sensors.sort((a, b) => a.position - b.position),
  };
}

export function cableVersion(value: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) >= 9223372036854775807n)
    throw new InvalidInputError(
      "expectedVersion must be a positive PostgreSQL bigint with room for the next version",
    );
  return BigInt(value);
}
