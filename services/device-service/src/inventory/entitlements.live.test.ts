import { adminTenantQuery } from "../testing/fixtures.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  appQuery,
  context,
  pooledDb,
  seedTenant,
} from "../testing/fixtures.js";
import { seedPlan, setFeedAge } from "../testing/entitlements.js";
import { EntitlementExceededError } from "./entitlements.js";
import { registerDevice, registerPendingDevice } from "./repository.js";
const db = pooledDb(8);
after(() => db.$disconnect());
const setLimit = (tenantId: string, max: number, version: number) =>
  seedPlan(tenantId, { "devices.max": max }, version);
test("ENT-01/02 concurrent registrations serialize and downgrade preserves existing devices", async () => {
  const t = await seedTenant(db);
  await setLimit(t.tenantId, 2, 1);
  const input = () => ({
    serialNumber: `SN-${randomUUID()}`,
    siteId: t.siteId,
  });
  const results = await Promise.allSettled([
    registerDevice(db, context(t.tenantId), input()),
    registerDevice(db, context(t.tenantId), input()),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (x) =>
        x.status === "rejected" && x.reason instanceof EntitlementExceededError,
    ).length,
    1,
  );
  await setLimit(t.tenantId, 4, 2);
  await registerDevice(db, context(t.tenantId), input());
  await setLimit(t.tenantId, 1, 3);
  await assert.rejects(
    registerDevice(db, context(t.tenantId), input()),
    EntitlementExceededError,
  );
  const [row] = await adminQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM devices WHERE tenant_id=$1",
    [t.tenantId],
  );
  assert.equal(row.n, "3");
});
test("ENT-05 tenant B cannot spend tenant A limit; pending saga obeys same lock", async () => {
  const a = await seedTenant(db),
    b = await seedTenant(db);
  await setLimit(a.tenantId, 100, 1);
  await setLimit(b.tenantId, 1, 1);
  await assert.rejects(
    registerPendingDevice(db, context(b.tenantId), {
      serialNumber: `SN-${randomUUID()}`,
      siteId: b.siteId,
      assetId: randomUUID(),
    }),
    EntitlementExceededError,
  );
  await registerPendingDevice(db, context(a.tenantId), {
    serialNumber: `SN-${randomUUID()}`,
    siteId: a.siteId,
    assetId: randomUUID(),
  });
  const rows = await appQuery("SELECT * FROM tenant_entitlements");
  assert.equal(rows.length, 0);
});
test("ENT-10 a paid plan applied an hour ago is still honored while the feed is healthy", async () => {
  const t = await seedTenant(db);
  await setLimit(t.tenantId, 2, 1); // seedTenant already owns one device
  await adminTenantQuery(
    t.tenantId,
    "UPDATE tenant_entitlements SET applied_at=now()-interval '1 hour' WHERE tenant_id=$1",
    [t.tenantId],
  );
  const input = () => ({
    serialNumber: `SN-${randomUUID()}`,
    siteId: t.siteId,
  });
  await registerDevice(db, context(t.tenantId), input());
  await assert.rejects(
    registerDevice(db, context(t.tenantId), input()),
    EntitlementExceededError,
  );
});
test("ENT-11 a stale feed fails closed to the free device default; a new heartbeat restores the plan", async () => {
  const t = await seedTenant(db);
  await setLimit(t.tenantId, 2, 1); // seedTenant already owns one device
  await registerDevice(db, context(t.tenantId), {
    serialNumber: `SN-${randomUUID()}`,
    siteId: t.siteId,
  });
  await setFeedAge(3600);
  await registerDevice(db, context(t.tenantId), {
    serialNumber: `SN-${randomUUID()}`,
    siteId: t.siteId,
  });
  await setFeedAge(0);
  await assert.rejects(
    registerDevice(db, context(t.tenantId), {
      serialNumber: `SN-${randomUUID()}`,
      siteId: t.siteId,
    }),
    EntitlementExceededError,
  );
});
