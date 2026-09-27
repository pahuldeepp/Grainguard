import {
  applyEntitlementHeartbeat,
  applyEntitlementProjection,
  startEntitlementProjector,
  type Envelope,
} from "@greenguard/entitlements";
import { createDb, type Db } from "../db/client.js";
import { inScope } from "../db/session.js";
export async function applyEntitlement(
  db: Db,
  event: Envelope,
): Promise<boolean> {
  return inScope(db, { tenantId: event.tenant_id }, async (tx) => {
    return applyEntitlementProjection(
      (query, ...values) => tx.$executeRawUnsafe(query, ...values),
      event,
    );
  });
}
// Feed health (ADR-0022): monotonic per partition, no tenant data, never touches plan rows.
export async function applyHeartbeat(
  db: Db,
  partition: number,
  emittedAt: Date,
): Promise<void> {
  await applyEntitlementHeartbeat(
    (query, ...values) => db.$executeRawUnsafe(query, ...values),
    partition,
    emittedAt,
  );
}
if (process.argv[1]?.endsWith("/entitlements/projector.js")) {
  await startEntitlementProjector({
    databaseUrl: process.env.CONTROL_ENTITLEMENT_PROJECTOR_URL,
    databaseUrlName: "CONTROL_ENTITLEMENT_PROJECTOR_URL",
    brokers: process.env.KAFKA_BROKERS,
    groupId: "greenguard-control-entitlements-v1",
    clientId: "control-entitlements",
    createDatabase: createDb,
    apply: applyEntitlement,
    heartbeat: applyHeartbeat,
  });
}
