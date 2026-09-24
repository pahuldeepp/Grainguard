import { InvalidInputError } from "./errors.js";

export const GRAIN_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;
const UTC_MILLIS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export const MAX_PLACEMENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isUtcMillis(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_MILLIS.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function placementTime(value: string): Date {
  if (!isUtcMillis(value))
    throw new InvalidInputError(
      "effectiveFrom must be a UTC millisecond timestamp",
    );
  const date = new Date(value);
  if (date.getTime() > Date.now() + MAX_PLACEMENT_FUTURE_SKEW_MS)
    throw new InvalidInputError("effectiveFrom is too far in the future");
  return date;
}
