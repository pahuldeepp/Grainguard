import type { ChangedEvent } from "./index.js";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface Envelope extends ChangedEvent {
  event_id: string;
  aggregate_type: "entitlement";
  aggregate_id: string;
  aggregate_version: string;
}
export class InvalidEntitlementEvent extends Error {}
export function decodeEntitlementEvent(
  raw: Buffer,
  key: Buffer | null,
): Envelope | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new InvalidEntitlementEvent("invalid JSON");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  )
    throw new InvalidEntitlementEvent("invalid envelope");
  const e = candidate as Partial<Envelope>;
  if (e.event_type !== "entitlements.changed") return null;
  const p = e.payload;
  if (
    !p ||
    !UUID.test(e.tenant_id ?? "") ||
    !UUID.test(e.event_id ?? "") ||
    e.aggregate_type !== "entitlement" ||
    e.aggregate_id !== e.tenant_id ||
    p.tenant_id !== e.tenant_id ||
    key?.toString("utf8") !== `${e.tenant_id}:${e.aggregate_id}` ||
    !/^\d+$/.test(e.aggregate_version ?? "") ||
    e.aggregate_version !== p.source_version ||
    !/^\d+$/.test(p.plan_version) ||
    !["free", "standard", "enterprise"].includes(p.plan_key) ||
    !Number.isFinite(Date.parse(p.effective_at)) ||
    typeof p.limits !== "object" ||
    p.limits === null ||
    typeof p.features !== "object" ||
    p.features === null
  )
    throw new InvalidEntitlementEvent(
      "invalid entitlement identity or payload",
    );
  for (const value of Object.values(p.limits))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new InvalidEntitlementEvent("invalid limit");
  for (const value of Object.values(p.features))
    if (typeof value !== "boolean")
      throw new InvalidEntitlementEvent("invalid feature");
  return e as Envelope;
}
// Feed-health heartbeat (ADR-0022): one per partition, no tenant, no plan data.
// Returns when it was emitted, or null for any other event type.
export function decodeHeartbeat(raw: Buffer): Date | null {
  let candidate: { event_type?: unknown; emitted_at?: unknown };
  try {
    candidate = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new InvalidEntitlementEvent("invalid JSON");
  }
  if (candidate?.event_type !== "entitlements.heartbeat") return null;
  const at =
    typeof candidate.emitted_at === "string"
      ? new Date(candidate.emitted_at)
      : new Date(Number.NaN);
  if (!Number.isFinite(at.getTime()))
    throw new InvalidEntitlementEvent("invalid heartbeat");
  return at;
}
