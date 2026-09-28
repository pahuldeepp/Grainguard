import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, after } from "node:test";
import pg from "pg";
import { postgresHistoryEntitlements } from "./postgres.js";
import { applyEntitlement, applyHeartbeat } from "./projector.js";
const admin = process.env.POSTGRES_ADMIN_URL,
  query = process.env.READ_QUERY_DATABASE_URL,
  projector = process.env.READ_ENTITLEMENT_PROJECTOR_URL;
const live = Boolean(admin && query && projector);
const withDb = (url: string) => {
  const u = new URL(url);
  u.pathname = "/greenguard_read";
  return u.toString();
};
const adminPool = live
  ? new pg.Pool({ connectionString: withDb(admin!), max: 2 })
  : undefined;
const queryPool = live
  ? new pg.Pool({ connectionString: query, max: 2 })
  : undefined;
const projPool = live
  ? new pg.Pool({ connectionString: projector, max: 2 })
  : undefined;
after(async () => {
  await Promise.all([adminPool?.end(), queryPool?.end(), projPool?.end()]);
});
const feedAge = (seconds: number) =>
  adminPool!.query(
    `INSERT INTO read.entitlement_feed_health(partition_id,verified_at)
 VALUES(0,now()-make_interval(secs=>$1)),(1,now()-make_interval(secs=>$1))
 ON CONFLICT(partition_id) DO UPDATE SET verified_at=excluded.verified_at`,
    [seconds],
  );
async function plan(tenant: string, days: number, version: string) {
  await applyEntitlement(projPool!, {
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
      limits: { "history.range_days": days },
      features: {},
      effective_at: new Date().toISOString(),
    },
  });
}
test(
  "ENT-10/11 history range honors an old plan while the feed is healthy and fails closed when it is stale",
  { skip: !live },
  async () => {
    const t = randomUUID();
    await plan(t, 30, "1");
    await adminPool!.query(
      "UPDATE read.tenant_entitlements SET applied_at=now()-interval '1 hour' WHERE tenant_id=$1",
      [t],
    );
    const stale: string[] = [];
    const reader = postgresHistoryEntitlements(queryPool!, (x) =>
      stale.push(x),
    );
    await feedAge(0);
    assert.equal((await reader.rangeDays(t)).days, 30);
    await feedAge(3600);
    assert.equal((await reader.rangeDays(t)).days, 7);
    assert.deepEqual(stale, [t]);
    await applyHeartbeat(projPool!, 0, new Date());
    await applyHeartbeat(projPool!, 1, new Date());
    assert.equal((await reader.rangeDays(t)).days, 30);
  },
);
test(
  "ENT-12 heartbeat leaves plan rows untouched and another tenant unreadable",
  { skip: !live },
  async () => {
    const a = randomUUID(),
      b = randomUUID();
    await plan(a, 30, "5");
    await plan(b, 60, "3");
    await applyHeartbeat(projPool!, 7, new Date());
    await applyHeartbeat(projPool!, 7, new Date(Date.now() - 3_600_000));
    await adminPool!.query(
      "DELETE FROM read.entitlement_feed_health WHERE partition_id=7",
    );
    const rows = await adminPool!.query(
      "SELECT tenant_id::text,source_version::text FROM read.tenant_entitlements WHERE tenant_id IN ($1,$2) ORDER BY 2",
      [a, b],
    );
    assert.deepEqual(
      rows.rows.map((r) => r.source_version),
      ["3", "5"],
    );
  },
);
