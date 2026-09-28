import {
  startProbeHealth,
  startEntitlementWorker,
  type Envelope,
} from "@greenguard/entitlements";
import { createDb, type Db } from "../db/client.js";
import { inScope } from "../db/session.js";
export async function applyEntitlement(
  db: Db,
  event: Envelope,
): Promise<boolean> {
  const p = event.payload;
  return inScope(db, { tenantId: event.tenant_id }, async (tx) => {
    const changed = await tx.$executeRaw`
   INSERT INTO tenant_entitlements(tenant_id,plan_key,plan_version,limits,features,source_version,applied_at)
   VALUES(${event.tenant_id}::uuid,${p.plan_key},${BigInt(p.plan_version)},${JSON.stringify(p.limits)}::jsonb,
     ${JSON.stringify(p.features)}::jsonb,${BigInt(p.source_version)},clock_timestamp())
   ON CONFLICT(tenant_id) DO UPDATE SET plan_key=excluded.plan_key,plan_version=excluded.plan_version,
    limits=excluded.limits,features=excluded.features,source_version=excluded.source_version,applied_at=excluded.applied_at
   WHERE tenant_entitlements.source_version<excluded.source_version`;
    return changed === 1;
  });
}
// Feed health (ADR-0022): monotonic per partition, no tenant data, never touches plan rows.
export async function applyHeartbeat(
  db: Db,
  partition: number,
  emittedAt: Date,
): Promise<void> {
  await db.$executeRaw`
  INSERT INTO entitlement_feed_health(partition_id,verified_at)
  VALUES(${partition},LEAST(${emittedAt}::timestamptz,clock_timestamp()))
  ON CONFLICT(partition_id) DO UPDATE SET verified_at=GREATEST(entitlement_feed_health.verified_at,excluded.verified_at)`;
}
if (process.argv[1]?.endsWith("/entitlements/projector.js")) {
  const url = process.env.CONTROL_ENTITLEMENT_PROJECTOR_URL,
    brokers = process.env.KAFKA_BROKERS;
  if (!url || !brokers)
    throw new Error(
      "CONTROL_ENTITLEMENT_PROJECTOR_URL and KAFKA_BROKERS required",
    );
  const db = createDb(url);
  const health = await startProbeHealth();
  const stop = await startEntitlementWorker({
    brokers: brokers.split(","),
    groupId: "greenguard-control-entitlements-v1",
    clientId: "control-entitlements",
    apply: (event) => applyEntitlement(db, event),
    heartbeat: (partition, at) => applyHeartbeat(db, partition, at),
    onGroupAssigned: health.ready,
    onGroupUnavailable: health.notReady,
    onFatal: (error) => {
      console.error(error);
      process.exit(1);
    },
  });
  const shutdown = () => {
    void stop()
      .finally(() => health.close())
      .finally(() => db.$disconnect());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
