import type { Envelope } from "./event.js";

type SqlValue = string | bigint | number | Date;
export type EntitlementSqlExecutor = (
  statement: string,
  ...values: SqlValue[]
) => Promise<number>;

const APPLY_ENTITLEMENT = `
INSERT INTO tenant_entitlements(tenant_id,plan_key,plan_version,limits,features,source_version,applied_at)
VALUES($1::uuid,$2,$3::bigint,$4::jsonb,$5::jsonb,$6::bigint,clock_timestamp())
ON CONFLICT(tenant_id) DO UPDATE SET plan_key=excluded.plan_key,plan_version=excluded.plan_version,
limits=excluded.limits,features=excluded.features,source_version=excluded.source_version,applied_at=excluded.applied_at
WHERE tenant_entitlements.source_version<excluded.source_version`;

const APPLY_HEARTBEAT = `
INSERT INTO entitlement_feed_health(partition_id,verified_at)
VALUES($1,LEAST($2::timestamptz,clock_timestamp()))
ON CONFLICT(partition_id) DO UPDATE SET verified_at=GREATEST(entitlement_feed_health.verified_at,excluded.verified_at)`;

export async function applyEntitlementProjection(
  execute: EntitlementSqlExecutor,
  event: Envelope,
): Promise<boolean> {
  const { payload } = event;
  const changed = await execute(
    APPLY_ENTITLEMENT,
    event.tenant_id,
    payload.plan_key,
    BigInt(payload.plan_version),
    JSON.stringify(payload.limits),
    JSON.stringify(payload.features),
    BigInt(payload.source_version),
  );
  return changed === 1;
}

export async function applyEntitlementHeartbeat(
  execute: EntitlementSqlExecutor,
  partition: number,
  emittedAt: Date,
): Promise<void> {
  await execute(APPLY_HEARTBEAT, partition, emittedAt);
}
