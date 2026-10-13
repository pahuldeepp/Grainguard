import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  runtimeDb,
  adminQuery,
  asRuntime,
  createActiveTenantFixture,
  uniqueSubject,
} from "../testing/fixtures.js";
import {
  acquireReadLease,
  admitReadLease,
  releaseReadLease,
} from "./read-leases.js";
import {
  beginPlacementMove,
  compareAndSetPlacement,
  placementMove,
  PlacementUnavailableError,
  PlacementConflictError,
} from "./placement.js";
const db = runtimeDb();
after(() => db.$disconnect());
async function fixture() {
  await adminQuery("UPDATE shard_registry SET state='active'");
  const created = await createActiveTenantFixture(
    db,
    { issuer: "https://read-lease.test", subject: uniqueSubject("reader") },
    "read lease farm",
    {
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
  );
  const tenantId = created.body.tenantId as string;
  const lease = await acquireReadLease(db, tenantId);
  const target = lease.route.shardId === "s4" ? "s1" : "s4";
  return { tenantId, lease, target, operationId: randomUUID() };
}
test("quiesce closes new leases, existing responses drain before epoch CAS", async () => {
  const { tenantId, lease, target, operationId } = await fixture();
  await admitReadLease(db, tenantId, lease.leaseId);
  await beginPlacementMove(
    db,
    tenantId,
    lease.route.placementEpoch,
    target,
    operationId,
  );
  await assert.rejects(
    acquireReadLease(db, tenantId),
    PlacementUnavailableError,
  );
  await admitReadLease(db, tenantId, lease.leaseId);
  await assert.rejects(
    compareAndSetPlacement(
      db,
      tenantId,
      lease.route.placementEpoch,
      target,
      operationId,
    ),
    /read leases must drain/,
  );
  await releaseReadLease(db, tenantId, lease.leaseId);
  await assert.rejects(
    admitReadLease(db, tenantId, lease.leaseId),
    PlacementConflictError,
  );
  await assert.rejects(
    compareAndSetPlacement(
      db,
      tenantId,
      lease.route.placementEpoch,
      target,
      operationId,
    ),
    /operation-bound placement evidence is missing or invalid/,
  );
  assert.equal(
    (await placementMove(db, tenantId, operationId)).state,
    "quiescing",
  );
});
test("expired/lost leases cannot admit a response or indefinitely block cutover", async () => {
  const { tenantId, lease, target, operationId } = await fixture();
  await adminQuery(
    "UPDATE placement_read_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1",
    [tenantId],
  );
  await assert.rejects(
    admitReadLease(db, tenantId, lease.leaseId),
    PlacementConflictError,
  );
  await beginPlacementMove(
    db,
    tenantId,
    lease.route.placementEpoch,
    target,
    operationId,
  );
  await assert.rejects(
    compareAndSetPlacement(
      db,
      tenantId,
      lease.route.placementEpoch,
      target,
      operationId,
    ),
    /operation-bound placement evidence is missing or invalid/,
  );
  assert.equal(
    (await placementMove(db, tenantId, operationId)).state,
    "quiescing",
  );
  await assert.rejects(
    acquireReadLease(db, tenantId),
    PlacementUnavailableError,
  );
});
test("lease RLS prevents another tenant from reading, releasing or using it", async () => {
  const first = await fixture(),
    second = await fixture();
  assert.equal(
    (
      await asRuntime(
        { "app.tenant_id": second.tenantId },
        "SELECT * FROM placement_read_leases WHERE tenant_id=$1",
        [first.tenantId],
      )
    ).rowCount,
    0,
  );
  await releaseReadLease(db, second.tenantId, first.lease.leaseId);
  await assert.rejects(
    admitReadLease(db, second.tenantId, first.lease.leaseId),
    PlacementConflictError,
  );
  await admitReadLease(db, first.tenantId, first.lease.leaseId);
  await releaseReadLease(db, first.tenantId, first.lease.leaseId);
  await releaseReadLease(db, second.tenantId, second.lease.leaseId);
});
