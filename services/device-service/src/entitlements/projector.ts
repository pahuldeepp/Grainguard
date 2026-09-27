import {
  applyEntitlementHeartbeat,
  applyEntitlementProjection,
  startEntitlementProjector,
  type Envelope,
} from "@greenguard/entitlements";
import { createDb, type Db } from "../db/client.js";
import { withTenant } from "../db/tenant.js";

export async function applyEntitlement(
  db: Db,
  event: Envelope,
): Promise<boolean> {
  return withTenant(db, event.tenant_id, async (tx) => {
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
const url = process.env.INVENTORY_PROJECTOR_DIRECT_URL;
const brokers = process.env.KAFKA_BROKERS;
if (process.argv[1]?.endsWith("/entitlements/projector.js")) {
  await startEntitlementProjector({
    databaseUrl: url,
    databaseUrlName: "INVENTORY_PROJECTOR_DIRECT_URL",
    brokers,
    groupId: "greenguard-inventory-entitlements-v1",
    clientId: "inventory-entitlements",
    createDatabase: createDb,
    apply: applyEntitlement,
    heartbeat: applyHeartbeat,
  });
}
