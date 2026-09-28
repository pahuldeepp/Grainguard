import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  runtimeDb,
  adminQuery,
  asRuntime,
  uniqueSubject,
} from "../testing/fixtures.js";
import { createOrganization } from "./store.js";
import {
  acquireReadLease,
  admitReadLease,
  releaseReadLease,
} from "./read-leases.js";
import {
  beginPlacementMove,
  compareAndSetPlacement,
  placementMove,
  recordPlacementMoveReceipt,
  PlacementUnavailableError,
  PlacementConflictError,
} from "./placement.js";
const db = runtimeDb();
after(() => db.$disconnect());
async function fixture() {
  await adminQuery("UPDATE shard_registry SET state='active'");
  const created = await createOrganization(
    db,
    { issuer: "https://read-lease.test", subject: uniqueSubject("reader") },
    { name: "read lease farm" },
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
async function receipts(tenantId: string, operationId: string) {
  const move = await placementMove(db, tenantId, operationId);
  for (const key of ["source_fenced", "target_prepared", "copy_verified"]) {
    const common = { tenantId, operationId, phase: key, sourceShardId: move.sourceShardId, sourceIncarnation: "11111111-1111-4111-8111-111111111111", sourceEpoch: move.expectedEpoch, targetShardId: move.targetShardId, targetIncarnation: "22222222-2222-4222-8222-222222222222", targetEpoch: (BigInt(move.expectedEpoch) + 1n).toString() };
    const proof = key === "source_fenced"
      ? { ...common, shardId: move.sourceShardId, incarnation: common.sourceIncarnation, epoch: move.expectedEpoch, state: "fenced" }
      : key === "target_prepared"
        ? { ...common, shardId: move.targetShardId, incarnation: common.targetIncarnation, epoch: common.targetEpoch, state: "prepared" }
        : { ...common, sourceSha256: "a".repeat(64), targetSha256: "a".repeat(64), rowCount: "0", tableCount: 1 };
    await recordPlacementMoveReceipt(db, tenantId, operationId, key, proof);
  }
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
  await receipts(tenantId, operationId);
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
  const moved = await compareAndSetPlacement(
    db,
    tenantId,
    lease.route.placementEpoch,
    target,
    operationId,
  );
  assert.equal(
    moved.resultingEpoch,
    (BigInt(lease.route.placementEpoch) + 1n).toString(),
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
  await receipts(tenantId, operationId);
  assert.equal(
    (
      await compareAndSetPlacement(
        db,
        tenantId,
        lease.route.placementEpoch,
        target,
        operationId,
      )
    ).state,
    "switched",
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
