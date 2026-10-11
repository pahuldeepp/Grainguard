import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  createActiveTenantFixture,
  runtimeDb,
  uniqueSubject,
} from "../testing/fixtures.js";
import { setFeedAge } from "../testing/entitlements.js";
import { inviteMember, acceptInvitation, type Actor } from "./store.js";
import { createApiKey } from "./api-keys.js";
import { SeatLimitError, ApiKeyLimitError } from "./entitlements.js";
import { createDb } from "../db/client.js";
import { applyEntitlement, applyHeartbeat } from "../entitlements/projector.js";
const db = runtimeDb(8);
after(() => db.$disconnect());
const cmd = () => ({
  idempotencyKey: randomUUID(),
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});
const actor = (s: string): Actor => {
  const subject = uniqueSubject(s);
  return {
    issuer: "https://issuer.test",
    subject,
    email: `${subject}@example.test`,
    emailVerified: true,
  };
};
async function org() {
  const admin = actor("quota-admin");
  const created = await createActiveTenantFixture(db, admin, "quota", cmd());
  return { admin, tenantId: created.body.tenantId as string };
}
async function entitlement(
  tenant: string,
  seats: number,
  keys: number,
  version: number,
) {
  await setFeedAge(0);
  await adminQuery(
    `INSERT INTO tenant_entitlements(tenant_id,plan_key,plan_version,limits,features,source_version)
 VALUES($1,'standard',2,jsonb_build_object('seats.max',$2::int,'api_keys.max',$3::int),'{}'::jsonb,$4)
 ON CONFLICT(tenant_id) DO UPDATE SET limits=excluded.limits,source_version=excluded.source_version,applied_at=now()
 WHERE tenant_entitlements.source_version<excluded.source_version`,
    [tenant, seats, keys, version],
  );
}
test("ENT-08 concurrent invitation accepts never exceed seats.max", async () => {
  const o = await org();
  await entitlement(o.tenantId, 2, 1, 1);
  const invite = async () => {
    const who = actor("join");
    const i = await inviteMember(
      db,
      o.admin,
      o.tenantId,
      { email: `${who.subject}@example.test`, role: "viewer" },
      cmd(),
    );
    return { who, token: i.body.token as string };
  };
  const [a, b] = await Promise.all([invite(), invite()]);
  const results = await Promise.allSettled([
    acceptInvitation(db, a.who, { token: a.token }, cmd()),
    acceptInvitation(db, b.who, { token: b.token }, cmd()),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (x) => x.status === "rejected" && x.reason instanceof SeatLimitError,
    ).length,
    1,
  );
  const [row] = await adminQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM memberships WHERE tenant_id=$1 AND state='active'",
    [o.tenantId],
  );
  assert.equal(row.n, "2");
});
test("api_keys.max is tenant-scoped and rejects over-limit issuance", async () => {
  const a = await org(),
    b = await org();
  await entitlement(a.tenantId, 3, 1, 1);
  await entitlement(b.tenantId, 3, 2, 1);
  const pepper =
    "a long server side pepper for testing only, more than 32 bytes";
  const input = () => ({
    name: "quota",
    kind: "usr" as const,
    scopes: ["read:telemetry"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  await createApiKey(db, pepper, a.admin, a.tenantId, input(), cmd());
  await assert.rejects(
    createApiKey(db, pepper, a.admin, a.tenantId, input(), cmd()),
    ApiKeyLimitError,
  );
  await createApiKey(db, pepper, b.admin, b.tenantId, input(), cmd());
  await createApiKey(db, pepper, b.admin, b.tenantId, input(), cmd());
});
test("ENT-10 a paid plan applied an hour ago is still honored while the feed is healthy", async () => {
  const o = await org();
  await entitlement(o.tenantId, 3, 2, 1);
  await adminQuery(
    "UPDATE tenant_entitlements SET applied_at=now()-interval '1 hour' WHERE tenant_id=$1",
    [o.tenantId],
  );
  const pepper =
    "a long server side pepper for testing only, more than 32 bytes";
  const input = () => ({
    name: "old-plan",
    kind: "usr" as const,
    scopes: ["read:telemetry"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const first = await createApiKey(
    db,
    pepper,
    o.admin,
    o.tenantId,
    input(),
    cmd(),
  );
  const second = await createApiKey(
    db,
    pepper,
    o.admin,
    o.tenantId,
    input(),
    cmd(),
  );
  assert.notEqual(first.keyId, second.keyId);
});
test("ENT-11 a stale feed fails closed to the free key default and a heartbeat restores the plan", async () => {
  const o = await org();
  await entitlement(o.tenantId, 3, 2, 1);
  const pepper =
    "a long server side pepper for testing only, more than 32 bytes";
  const input = () => ({
    name: "stale",
    kind: "usr" as const,
    scopes: ["read:telemetry"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  await setFeedAge(3600);
  await createApiKey(db, pepper, o.admin, o.tenantId, input(), cmd());
  await assert.rejects(
    createApiKey(db, pepper, o.admin, o.tenantId, input(), cmd()),
    ApiKeyLimitError,
  );
  await setFeedAge(0);
  await createApiKey(db, pepper, o.admin, o.tenantId, input(), cmd());
});
test("ENT-12 heartbeat never regresses a newer plan and never touches another tenant", async () => {
  const a = await org(),
    b = await org();
  await entitlement(a.tenantId, 3, 2, 5);
  await entitlement(b.tenantId, 3, 9, 3);
  const projector = createDb(process.env.CONTROL_ENTITLEMENT_PROJECTOR_URL!);
  try {
    const snapshot = () =>
      adminQuery<{ tenant_id: string; v: string; age: string }>(
        "SELECT tenant_id::text,source_version::text AS v,(now()-applied_at)::text AS age FROM tenant_entitlements WHERE tenant_id IN ($1,$2) ORDER BY 1",
        [a.tenantId, b.tenantId],
      );
    const before = await snapshot();
    const now = new Date();
    for (const at of [
      now,
      new Date(now.getTime() - 3_600_000),
      new Date(now.getTime() + 3_600_000),
    ])
      await applyHeartbeat(projector, 7, at);
    const [beat] = await adminQuery<{ ago: string }>(
      "SELECT extract(epoch FROM now()-verified_at)::text AS ago FROM entitlement_feed_health WHERE partition_id=7",
    );
    assert.ok(Number(beat.ago) >= -1 && Number(beat.ago) < 60);
    assert.deepEqual(
      (await snapshot()).map((r) => [r.tenant_id, r.v]),
      before.map((r) => [r.tenant_id, r.v]),
    );
    await adminQuery(
      "DELETE FROM entitlement_feed_health WHERE partition_id=7",
    );
    assert.equal(
      await applyEntitlement(projector, {
        event_id: randomUUID(),
        event_type: "entitlements.changed",
        tenant_id: a.tenantId,
        aggregate_type: "entitlement",
        aggregate_id: a.tenantId,
        aggregate_version: "4",
        payload: {
          tenant_id: a.tenantId,
          plan_key: "free",
          plan_version: "1",
          source_version: "4",
          limits: { "api_keys.max": 1 },
          features: {},
          effective_at: new Date().toISOString(),
        },
      }),
      false,
    );
  } finally {
    await projector.$disconnect();
  }
});
