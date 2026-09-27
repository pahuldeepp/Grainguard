import type { Tx } from "../db/tenant.js";

export class EntitlementExceededError extends Error {
  readonly code = "entitlement_exceeded";
  constructor(readonly planVersion: string) {
    super("Device limit exceeded");
  }
}

// Called inside the same transaction as the device insert. The tenant row lock
// serializes distinct idempotency keys before the count, including saga reserve.
export async function assertDeviceCapacity(
  tx: Tx,
  tenantId: string,
): Promise<string> {
  const tenant = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT inventory_lock_tenant_for_quota(${tenantId}::uuid) AS locked`;
  if (tenant[0]?.locked !== true) throw new Error("tenant_projection_missing");
  const rows = await tx.$queryRaw<{ limit: number; plan_version: bigint }[]>`
    SELECT COALESCE(
      CASE WHEN entitlement_feed_fresh()
        AND (limits->>'devices.max') ~ '^[0-9]+$'
        THEN LEAST((limits->>'devices.max')::numeric, 1000000)::int
      END, 10) AS limit,
      CASE WHEN entitlement_feed_fresh() THEN plan_version ELSE 1 END AS plan_version
    FROM tenant_entitlements WHERE tenant_id = ${tenantId}::uuid`;
  const limit = rows[0]?.limit ?? 10;
  const planVersion = String(rows[0]?.plan_version ?? 1n);
  const count = await tx.device.count({
    where: { tenantId, status: { not: "deleted" } },
  });
  if (count >= limit) throw new EntitlementExceededError(planVersion);
  return planVersion;
}
