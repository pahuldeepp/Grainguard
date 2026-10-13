import { adminTenantQuery } from "../testing/fixtures.js";
import { fixtureDb } from "../testing/fixtures.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { adminQuery, createTenant } from "../testing/fixtures.js";
import { applyEntitlement, applyHeartbeat } from "./projector.js";
import type { Envelope } from "@greenguard/entitlements";
const db = fixtureDb(process.env.INVENTORY_PROJECTOR_DIRECT_URL!);
after(() => db.$disconnect());
function event(tenant: string, version: string, max: number): Envelope {
  return {
    event_id: randomUUID(),
    event_type: "entitlements.changed",
    tenant_id: tenant,
    aggregate_type: "entitlement",
    aggregate_id: tenant,
    aggregate_version: version,
    payload: {
      tenant_id: tenant,
      plan_key: "standard",
      plan_version: "2",
      source_version: version,
      limits: { "devices.max": max },
      features: { audit_export: true },
      effective_at: new Date().toISOString(),
    },
  };
}
test("ENT-03 projector keeps highest source version and tenant A never writes B", async () => {
  const a = randomUUID(),
    b = randomUUID();
  await createTenant(db, a, "A");
  await createTenant(db, b, "B");
  assert.equal(await applyEntitlement(db, event(a, "2", 100)), true);
  assert.equal(await applyEntitlement(db, event(a, "2", 1)), false);
  assert.equal(await applyEntitlement(db, event(a, "1", 1)), false);
  assert.equal(await applyEntitlement(db, event(b, "1", 3)), true);
  const rows = await adminQuery<{ tenant_id: string; max: string }>(
    "SELECT tenant_id::text,(limits->>'devices.max') AS max FROM tenant_entitlements WHERE tenant_id IN ($1,$2) ORDER BY tenant_id",
    [a, b],
  );
  assert.deepEqual(
    rows,
    [
      { tenant_id: a, max: "100" },
      { tenant_id: b, max: "3" },
    ].sort((x, y) => x.tenant_id.localeCompare(y.tenant_id)),
  );
});
test("ENT-12 heartbeat is monotonic, capped at the clock and leaves plan rows and other tenants untouched", async () => {
  const a = randomUUID(),
    b = randomUUID();
  await createTenant(db, a, "A");
  await createTenant(db, b, "B");
  await applyEntitlement(db, event(a, "5", 7));
  await applyEntitlement(db, event(b, "3", 9));
  for (const tenantId of [a, b])
    await adminTenantQuery(
      tenantId,
      "UPDATE tenant_entitlements SET applied_at=now()-interval '2 hours' WHERE tenant_id=$1",
      [tenantId],
    );
  const before = await adminQuery<{
    tenant_id: string;
    v: string;
    age: string;
  }>(
    "SELECT tenant_id::text,source_version::text AS v,(now()-applied_at>interval '119 minutes')::text AS age FROM tenant_entitlements WHERE tenant_id IN ($1,$2) ORDER BY 1",
    [a, b],
  );
  const now = new Date();
  for (const at of [
    now,
    new Date(now.getTime() - 3_600_000),
    new Date(now.getTime() + 3_600_000),
  ])
    await applyHeartbeat(db, 7, at);
  const [beat] = await adminQuery<{ ago: string }>(
    "SELECT extract(epoch FROM now()-verified_at)::text AS ago FROM entitlement_feed_health WHERE partition_id=7",
  );
  assert.ok(Number(beat.ago) >= -1 && Number(beat.ago) < 60);
  const after2 = await adminQuery<{
    tenant_id: string;
    v: string;
    age: string;
  }>(
    "SELECT tenant_id::text,source_version::text AS v,(now()-applied_at>interval '119 minutes')::text AS age FROM tenant_entitlements WHERE tenant_id IN ($1,$2) ORDER BY 1",
    [a, b],
  );
  await adminQuery("DELETE FROM entitlement_feed_health WHERE partition_id=7");
  assert.deepEqual(after2, before);
});
