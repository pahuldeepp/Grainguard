import { DEFAULT_LIMITS } from "@greenguard/entitlements";
import type { Tx } from "../db/client.js";

export class SeatLimitError extends Error {
  constructor(readonly planVersion: string) {
    super("seat_limit");
  }
}
export class ApiKeyLimitError extends Error {
  constructor(readonly planVersion: string) {
    super("api_key_limit");
  }
}

/** Limits readable through the feed-health-aware reader; fallbacks are the free-plan defaults. */
export type EnforcedLimit = "seats.max" | "api_keys.max" | "exports.per_day";
export async function limit(tx: Tx, tenantId: string, key: EnforcedLimit) {
  const fallback = DEFAULT_LIMITS[key];
  const [row] = await tx.$queryRaw<{ limit: number; plan_version: bigint }[]>`
    SELECT COALESCE(CASE WHEN entitlement_feed_fresh()
      AND (limits->>${key}) ~ '^[0-9]+$' THEN
      LEAST((limits->>${key})::numeric, 1000000)::int END,
      ${fallback}::int) AS limit,
      CASE WHEN entitlement_feed_fresh() THEN plan_version ELSE 1 END AS plan_version
    FROM tenant_entitlements WHERE tenant_id=${tenantId}::uuid`;
  return {
    max: row?.limit ?? fallback,
    version: String(row?.plan_version ?? 1n),
  };
}
// Call only after the organization row is locked in the same transaction.
export async function assertSeatCapacity(
  tx: Tx,
  tenantId: string,
  identityId: string,
) {
  const [existing] = await tx.$queryRaw<{ state: string }[]>`
    SELECT state FROM memberships WHERE tenant_id=${tenantId}::uuid AND identity_id=${identityId}::uuid`;
  if (existing?.state === "active") return;
  const { max, version } = await limit(tx, tenantId, "seats.max");
  const [usage] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM memberships WHERE tenant_id=${tenantId}::uuid AND state='active'`;
  if (Number(usage?.n ?? 0n) >= max) throw new SeatLimitError(version);
}
export async function assertApiKeyCapacity(tx: Tx, tenantId: string) {
  const { max, version } = await limit(tx, tenantId, "api_keys.max");
  const [usage] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM api_keys WHERE tenant_id=${tenantId}::uuid
      AND revoked_at IS NULL AND rotated_to IS NULL AND expires_at>now()`;
  if (Number(usage?.n ?? 0n) >= max) throw new ApiKeyLimitError(version);
}
