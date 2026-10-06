import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  adminQuery,
  asRuntime,
  createActiveTenantFixture,
  runtimeDb,
  uniqueSubject,
} from "../testing/fixtures.js";
import {
  beginPlacementMove,
  compareAndSetPlacement,
  placementMove,
  preparePlacementMove,
  recordPlacementMoveReceipt,
  resolveTenant,
} from "./placement.js";

const db = runtimeDb(4);
after(() => db.$disconnect());

test("control_app can quiesce for read safety but cannot forge owner receipts or switch/advance placement", async () => {
  const created = await createActiveTenantFixture(
    db,
    {
      issuer: "https://placement-boundary.test",
      subject: uniqueSubject("deny-move"),
    },
    "untrusted mover boundary",
    {
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
  );
  const tenantId = created.body.tenantId as string;
  const initial = await resolveTenant(db, tenantId);
  const target = initial.shardId === "s4" ? "s1" : "s4";
  const operationId = randomUUID();
  const [targetShard] = await adminQuery<{ state: string }>(
    "SELECT state FROM shard_registry WHERE shard_id=$1",
    [target],
  );
  assert.ok(targetShard, `target shard ${target} must be registered`);
  await adminQuery(
    "UPDATE shard_registry SET state='active' WHERE shard_id=$1",
    [target],
  );

  try {
    assert.equal(
      (
        await preparePlacementMove(
          db,
          tenantId,
          initial.placementEpoch,
          target,
          operationId,
        )
      ).state,
      "preparing",
    );
    assert.equal(
      (
        await beginPlacementMove(
          db,
          tenantId,
          initial.placementEpoch,
          target,
          operationId,
        )
      ).state,
      "quiescing",
    );
    assert.equal((await resolveTenant(db, tenantId)).state, "quiescing");

    const synthetic = {
      tenantId,
      operationId,
      phase: "source_fenced",
      sourceShardId: initial.shardId,
      sourceIncarnation: randomUUID(),
      sourceEpoch: initial.placementEpoch,
      targetShardId: target,
      targetIncarnation: randomUUID(),
      targetEpoch: (BigInt(initial.placementEpoch) + 1n).toString(),
      shardId: initial.shardId,
      incarnation: randomUUID(),
      epoch: initial.placementEpoch,
      state: "fenced",
      ownerReceipts: Object.fromEntries(
        [
          "telemetry",
          "projection",
          "jobs",
          "saga",
          "hardware",
          "inventory",
          "alerts",
          "risk",
          "notifications",
        ].map((owner) => [owner, { owner }]),
      ),
    };

    await assert.rejects(
      recordPlacementMoveReceipt(
        db,
        tenantId,
        operationId,
        "source_fenced",
        synthetic,
      ),
      /trusted all-owner mover required for receipt or cutover mutation|permission denied/i,
    );
    await assert.rejects(
      asRuntime(
        { "app.tenant_id": tenantId },
        "UPDATE placement_moves SET receipts=receipts || $3::jsonb WHERE tenant_id=$1::uuid AND operation_id=$2::uuid",
        [tenantId, operationId, JSON.stringify({ source_fenced: synthetic })],
      ),
      /trusted all-owner mover required for receipt or cutover mutation|permission denied/i,
    );
    await assert.rejects(
      compareAndSetPlacement(
        db,
        tenantId,
        initial.placementEpoch,
        target,
        operationId,
      ),
      /operation-bound placement evidence is missing or invalid/,
    );
    await assert.rejects(
      asRuntime(
        { "app.tenant_id": tenantId },
        "UPDATE organizations SET shard_id=$2,routing_epoch=$3,placement_state='activating' WHERE tenant_id=$1::uuid",
        [tenantId, target, BigInt(initial.placementEpoch) + 1n],
      ),
      /permission denied|trusted all-owner mover required/i,
    );

    const after = await resolveTenant(db, tenantId);
    assert.deepEqual(
      {
        tenantId: after.tenantId,
        shardId: after.shardId,
        shardIncarnation: after.shardIncarnation,
        placementEpoch: after.placementEpoch,
        state: after.state,
      },
      {
        tenantId: initial.tenantId,
        shardId: initial.shardId,
        shardIncarnation: initial.shardIncarnation,
        placementEpoch: initial.placementEpoch,
        state: "quiescing",
      },
    );
    assert.equal(
      (await placementMove(db, tenantId, operationId)).state,
      "quiescing",
    );
    assert.equal(
      (await resolveTenant(db, tenantId)).placementEpoch,
      initial.placementEpoch,
    );
  } finally {
    await adminQuery("UPDATE shard_registry SET state=$2 WHERE shard_id=$1", [
      target,
      targetShard.state,
    ]);
  }
});
