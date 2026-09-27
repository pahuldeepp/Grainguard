import { randomUUID } from "node:crypto";
import { createDb } from "../db/client.js";
import { applyEntitlement, applyHeartbeat } from "../entitlements/projector.js";
import { adminQuery, env } from "./fixtures.js";

// Test seeding goes through the production projector (ADR-0022), so the plan row and the
// feed-health heartbeat are written by the same code the consumers rely on.
const withProjector = async <T>(
  run: (db: ReturnType<typeof createDb>) => Promise<T>,
) => {
  const db = createDb(env("CONTROL_ENTITLEMENT_PROJECTOR_URL"), 2);
  try {
    return await run(db);
  } finally {
    await db.$disconnect();
  }
};

/**
 * Make the feed exactly `ageSeconds` old on partition 0, or absent when null.
 * Other partitions are cleared first so the oldest heartbeat is the one under test.
 */
export async function setFeedAge(ageSeconds: number | null): Promise<void> {
  await adminQuery("DELETE FROM entitlement_feed_health");
  if (ageSeconds === null) return;
  await withProjector((db) =>
    applyHeartbeat(db, 0, new Date(Date.now() - ageSeconds * 1000)),
  );
}

/** Apply a plan row and a fresh heartbeat, so the plan is honored. */
export async function seedPlan(
  tenantId: string,
  limits: Record<string, number>,
  features: Record<string, boolean> = {},
  version = 1,
): Promise<void> {
  await withProjector((db) =>
    applyEntitlement(db, {
      event_id: randomUUID(),
      event_type: "entitlements.changed",
      tenant_id: tenantId,
      aggregate_type: "entitlement",
      aggregate_id: tenantId,
      aggregate_version: String(version),
      payload: {
        tenant_id: tenantId,
        plan_key: "standard",
        plan_version: "2",
        source_version: String(version),
        limits,
        features,
        effective_at: new Date().toISOString(),
      },
    }),
  );
  await setFeedAge(0);
}
