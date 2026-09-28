import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { validateTenantRoute } from "@greenguard/membership-client";
import { inScope } from "../db/session.js";
import {
  adminQuery,
  asRuntime,
  runtimeDb,
  uniqueSubject,
} from "../testing/fixtures.js";
import { createOrganization, insertOrganization, type Actor } from "./store.js";
import {
  beginPlacementMove,
  compareAndSetPlacement,
  finishPlacementMove,
  placementMove,
  preparePlacementMove,
  recordPlacementMoveReceipt,
  resolveTenant,
  PlacementConflictError,
  PlacementUnavailableError,
} from "./placement.js";
import {
  IdempotencyConflictError,
  InvalidInputError,
  NotFoundError,
} from "./errors.js";

const db = runtimeDb(8);
after(() => db.$disconnect());
const command = () => ({
  idempotencyKey: randomUUID(),
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});
async function organization() {
  const actor: Actor = {
    issuer: "https://placement.test",
    subject: uniqueSubject("placement"),
  };
  const created = await createOrganization(
    db,
    actor,
    { name: "placement farm" },
    command(),
  );
  const tenantId = created.body.tenantId as string;
  const route = await resolveTenant(db, tenantId);
  return {
    actor,
    tenantId,
    route,
    target: route.shardId === "s4" ? "s1" : "s4",
  };
}
async function prepared(tenantId: string, op: string) {
  for (const key of ["source_fenced", "target_prepared", "copy_verified"])
    await recordPlacementMoveReceipt(
      db,
      tenantId,
      op,
      key,
      await receipt(tenantId, op, key),
    );
}
async function receipt(tenantId: string, operationId: string, phase: string) {
  const move = await placementMove(db, tenantId, operationId);
  const common = {
    tenantId,
    operationId,
    phase,
    sourceShardId: move.sourceShardId,
    sourceIncarnation: "11111111-1111-4111-8111-111111111111",
    sourceEpoch: move.expectedEpoch,
    targetShardId: move.targetShardId,
    targetIncarnation: "22222222-2222-4222-8222-222222222222",
    targetEpoch: (BigInt(move.expectedEpoch) + 1n).toString(),
  };
  if (phase === "source_fenced")
    return {
      ...common,
      shardId: move.sourceShardId,
      incarnation: common.sourceIncarnation,
      epoch: move.expectedEpoch,
      state: "fenced",
    };
  if (phase === "target_prepared")
    return {
      ...common,
      shardId: move.targetShardId,
      incarnation: common.targetIncarnation,
      epoch: common.targetEpoch,
      state: "prepared",
    };
  if (phase === "target_activated")
    return {
      ...common,
      shardId: move.targetShardId,
      incarnation: common.targetIncarnation,
      epoch: common.targetEpoch,
      state: "active",
    };
  if (phase === "copy_verified" || phase === "baseline_copied")
    return {
      ...common,
      sourceSha256: "a".repeat(64),
      targetSha256: "a".repeat(64),
      rowCount: "0",
      tableCount: 1,
    };
  if (phase === "targets_unactivated")
    return {
      ...common,
      shardId: move.targetShardId,
      incarnation: common.targetIncarnation,
      state: "absent",
    };
  if (phase === "source_reactivated")
    return {
      ...common,
      shardId: move.sourceShardId,
      incarnation: common.sourceIncarnation,
      epoch: common.targetEpoch,
      state: "active",
    };
  throw new Error(`unknown receipt phase ${phase}`);
}
test("registry seeds four stable IDs; legacy organizations retain s1 and all metadata is protected", async () => {
  // Only registry/domain behavior is exercised here. Physical readiness is a
  // separate bootstrap gate; reset the isolated fixture before testing admission.
  await adminQuery(
    "UPDATE shard_registry SET state='offline' WHERE shard_id<>'s1'",
  );
  assert.deepEqual(
    (
      await adminQuery<{ shard_id: string }>(
        "SELECT shard_id FROM shard_registry ORDER BY shard_id",
      )
    ).map((r) => r.shard_id),
    ["s1", "s2", "s3", "s4"],
  );
  const legacy = await adminQuery<{ shard_id: string }>(
    "SELECT shard_id FROM organizations WHERE initial_placement_method='legacy'",
  );
  assert.ok(legacy.length > 0);
  for (const row of legacy) assert.equal(row.shard_id, "s1");
  for (const table of [
    "shard_registry",
    "placement_ring_versions",
    "placement_policy",
    "placement_moves",
  ]) {
    const [row] = await adminQuery<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity enabled,relforcerowsecurity forced FROM pg_class WHERE relname=$1`,
      [table],
    );
    assert.deepEqual(row, { enabled: true, forced: true });
  }
  await assert.rejects(
    asRuntime({}, "UPDATE shard_registry SET state='offline'"),
    /permission denied/,
  );
  await assert.rejects(
    asRuntime({}, "UPDATE placement_policy SET ring_version=2"),
    /permission denied/,
  );
  const legacyReady = await organization();
  assert.equal(legacyReady.route.shardId, "s1");
  await assert.rejects(
    beginPlacementMove(db, legacyReady.tenantId, "1", "s2", randomUUID()),
    PlacementUnavailableError,
  );
  // Subsequent move tests use prepared registry metadata as a test fixture only.
  await adminQuery(
    "UPDATE shard_registry SET state='active' WHERE shard_id<>'s1'",
  );
});
test("editing the onboarding ring affects only new tenants and immutable history preserves prior decisions", async () => {
  const existing = await organization();
  await adminQuery(
    "INSERT INTO placement_ring_versions VALUES (2,'sha256-v1',128,ARRAY['s1']) ON CONFLICT DO NOTHING",
  );
  await adminQuery(
    "UPDATE placement_policy SET ring_version=2 WHERE policy_id='default'",
  );
  try {
    const created = await organization();
    assert.equal(created.route.shardId, "s1");
    const [row] = await adminQuery<{ version: string }>(
      "SELECT initial_placement_ring_version::text AS version FROM organizations WHERE tenant_id=$1",
      [created.tenantId],
    );
    assert.equal(row.version, "2");
    assert.equal(
      (await resolveTenant(db, existing.tenantId)).shardId,
      existing.route.shardId,
    );
    assert.equal(
      await inScope(db, { tenantId: existing.tenantId }, (tx) =>
        insertOrganization(
          tx,
          existing.tenantId,
          "retry",
          randomUUID(),
          command(),
          { shardId: "missing" },
        ),
      ),
      false,
    );
    await assert.rejects(
      adminQuery(
        "UPDATE placement_ring_versions SET virtual_nodes=256 WHERE ring_version=1",
      ),
      /immutable/,
    );
  } finally {
    await adminQuery(
      "UPDATE placement_policy SET ring_version=1 WHERE policy_id='default'",
    );
  }
});
test("onboarding persists one ring suggestion and runtime resolution never rehashes", async () => {
  const { actor, tenantId, route } = await organization();
  assert.ok(["s1", "s2", "s3", "s4"].includes(route.shardId));
  const [row] = await adminQuery<{ version: string; method: string }>(
    "SELECT initial_placement_ring_version::text AS version,initial_placement_method AS method FROM organizations WHERE tenant_id=$1",
    [tenantId],
  );
  assert.deepEqual(row, { version: "1", method: "ring" });
  validateTenantRoute(route, tenantId);
  assert.equal(
    (await resolveTenant(db, tenantId, actor)).shardId,
    route.shardId,
  );
  await assert.rejects(
    resolveTenant(db, tenantId, { issuer: actor.issuer, subject: "outsider" }),
    NotFoundError,
  );
  await assert.rejects(resolveTenant(db, randomUUID()), NotFoundError);
  await assert.rejects(resolveTenant(db, "invalid"), InvalidInputError);
  const op = randomUUID();
  const target = route.shardId === "s3" ? "s2" : "s3";
  await beginPlacementMove(db, tenantId, "1", target, op);
  await prepared(tenantId, op);
  await compareAndSetPlacement(db, tenantId, "1", target, op);
  assert.equal((await resolveTenant(db, tenantId)).shardId, target);
});
test("trusted onboarding override persists provenance without a public routing hint", async () => {
  const tenantId = randomUUID();
  await inScope(db, { tenantId }, (tx) =>
    insertOrganization(tx, tenantId, "dedicated", randomUUID(), command(), {
      shardId: "s3",
    }),
  );
  assert.equal((await resolveTenant(db, tenantId)).shardId, "s3");
  const [row] = await adminQuery<{ method: string }>(
    "SELECT initial_placement_method AS method FROM organizations WHERE tenant_id=$1",
    [tenantId],
  );
  assert.equal(row.method, "override");
  const bad = randomUUID();
  await assert.rejects(
    inScope(db, { tenantId: bad }, (tx) =>
      insertOrganization(tx, bad, "invalid", randomUUID(), command(), {
        shardId: "missing",
      }),
    ),
    PlacementUnavailableError,
  );
});
test("resolver serializes epochs beyond JS precision and rejects offline shard ownership", async () => {
  const { tenantId, route } = await organization();
  await adminQuery(
    "UPDATE organizations SET routing_epoch=9007199254740993 WHERE tenant_id=$1",
    [tenantId],
  );
  assert.equal(
    (await resolveTenant(db, tenantId)).placementEpoch,
    "9007199254740993",
  );
  await adminQuery(
    "UPDATE shard_registry SET state='offline' WHERE shard_id=$1",
    [route.shardId],
  );
  try {
    await assert.rejects(
      resolveTenant(db, tenantId),
      PlacementUnavailableError,
    );
  } finally {
    await adminQuery(
      "UPDATE shard_registry SET state='active' WHERE shard_id=$1",
      [route.shardId],
    );
  }
});
test("registry incarnation is authoritative; replacements rotate only offline with the next version", async () => {
  const { tenantId, route } = await organization();
  const next = randomUUID();
  assert.match(route.shardIncarnation, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    adminQuery(
      "UPDATE shard_registry SET shard_incarnation=$2,configuration_version=configuration_version+1 WHERE shard_id=$1",
      [route.shardId, next],
    ),
    /offline shard/,
  );
  await adminQuery(
    "UPDATE shard_registry SET state='offline' WHERE shard_id=$1",
    [route.shardId],
  );
  try {
    await assert.rejects(
      resolveTenant(db, tenantId),
      PlacementUnavailableError,
    );
    await assert.rejects(
      adminQuery(
        "UPDATE shard_registry SET shard_incarnation=$2 WHERE shard_id=$1",
        [route.shardId, next],
      ),
      /next configuration version/,
    );
    await adminQuery(
      "UPDATE shard_registry SET shard_incarnation=$2,configuration_version=configuration_version+1 WHERE shard_id=$1",
      [route.shardId, next],
    );
  } finally {
    await adminQuery(
      "UPDATE shard_registry SET state='active' WHERE shard_id=$1",
      [route.shardId],
    );
  }
  assert.equal((await resolveTenant(db, tenantId)).shardIncarnation, next);
  assert.equal(
    (await resolveTenant(db, tenantId)).placementEpoch,
    route.placementEpoch,
  );
});
test("move CAS advances once, requires receipts, blocks admission until activated and replays durably", async () => {
  const { tenantId, target } = await organization();
  const op = randomUUID();
  const begin = await beginPlacementMove(db, tenantId, "1", target, op);
  assert.equal(begin.state, "quiescing");
  assert.deepEqual(
    await beginPlacementMove(db, tenantId, "1", target, op),
    begin,
  );
  assert.equal((await resolveTenant(db, tenantId)).state, "quiescing");
  await assert.rejects(
    compareAndSetPlacement(db, tenantId, "1", target, op),
    PlacementConflictError,
  );
  await prepared(tenantId, op);
  const switched = await compareAndSetPlacement(db, tenantId, "1", target, op);
  assert.equal(switched.resultingEpoch, "2");
  assert.equal(switched.state, "switched");
  assert.deepEqual(
    await compareAndSetPlacement(db, tenantId, "1", target, op),
    switched,
  );
  assert.equal((await resolveTenant(db, tenantId)).state, "activating");
  await assert.rejects(
    finishPlacementMove(db, tenantId, op, "completed"),
    PlacementConflictError,
  );
  await assert.rejects(
    finishPlacementMove(db, tenantId, op, "aborted"),
    PlacementConflictError,
  );
  await recordPlacementMoveReceipt(
    db,
    tenantId,
    op,
    "target_activated",
    await receipt(tenantId, op, "target_activated"),
  );
  const done = await finishPlacementMove(db, tenantId, op, "completed");
  assert.equal(done.state, "completed");
  assert.equal((await resolveTenant(db, tenantId)).state, "active");
  assert.deepEqual(
    await finishPlacementMove(db, tenantId, op, "completed"),
    done,
  );
  assert.deepEqual(
    await compareAndSetPlacement(db, tenantId, "1", target, op),
    done,
  );
  // Change a UUID character outside its version/variant nibbles so the
  // conflicting operation is guaranteed to differ from `op`.
  const conflictingOperationId = `${op[0] === "0" ? "1" : "0"}${op.slice(1)}`;
  await assert.rejects(
    beginPlacementMove(db, tenantId, "1", target, conflictingOperationId),
    PlacementConflictError,
  );
});
test("baseline preparation is durable while writes stay active; quiescing starts only for cutover", async () => {
  const { tenantId, target } = await organization();
  const op = randomUUID();
  const prepared = await preparePlacementMove(db, tenantId, "1", target, op);
  assert.equal(prepared.state, "preparing");
  assert.equal((await resolveTenant(db, tenantId)).state, "active");
  assert.deepEqual(
    await preparePlacementMove(db, tenantId, "1", target, op),
    prepared,
  );
  await assert.rejects(
    preparePlacementMove(db, tenantId, "1", target, randomUUID()),
    PlacementConflictError,
  );
  await assert.rejects(
    beginPlacementMove(db, tenantId, "1", target, randomUUID()),
    PlacementConflictError,
  );
  await assert.rejects(
    compareAndSetPlacement(db, tenantId, "1", target, op),
    PlacementConflictError,
  );
  await recordPlacementMoveReceipt(
    db,
    tenantId,
    op,
    "baseline_copied",
    await receipt(tenantId, op, "baseline_copied"),
  );
  assert.equal(
    (await beginPlacementMove(db, tenantId, "1", target, op)).state,
    "quiescing",
  );
  assert.equal((await resolveTenant(db, tenantId)).state, "quiescing");
});
test("empty or negative receipts never permit ownership switch or runtime reactivation", async () => {
  const { tenantId, target } = await organization();
  const op = randomUUID();
  await beginPlacementMove(db, tenantId, "1", target, op);
  for (const key of ["source_fenced", "target_prepared", "copy_verified"])
    await recordPlacementMoveReceipt(db, tenantId, op, key, {
      ...(await receipt(tenantId, op, key)),
      state: "invalid",
    });
  await assert.rejects(
    compareAndSetPlacement(db, tenantId, "1", target, op),
    PlacementConflictError,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      "UPDATE organizations SET placement_state='active',routing_epoch=2 WHERE tenant_id=$1",
      [tenantId],
    ),
    /matching durable move/,
  );
  assert.equal((await resolveTenant(db, tenantId)).state, "quiescing");
  assert.equal((await placementMove(db, tenantId, op)).state, "quiescing");
});
test("operation-bound receipt with a forged target identity cannot authorize placement CAS", async () => {
  const { tenantId, target } = await organization();
  const op = randomUUID();
  await beginPlacementMove(db, tenantId, "1", target, op);
  await recordPlacementMoveReceipt(
    db,
    tenantId,
    op,
    "source_fenced",
    await receipt(tenantId, op, "source_fenced"),
  );
  const forged = await receipt(tenantId, op, "target_prepared");
  await recordPlacementMoveReceipt(db, tenantId, op, "target_prepared", {
    ...forged,
    shardId: "s3",
    targetShardId: "s3",
  });
  await recordPlacementMoveReceipt(
    db,
    tenantId,
    op,
    "copy_verified",
    await receipt(tenantId, op, "copy_verified"),
  );
  await assert.rejects(
    compareAndSetPlacement(db, tenantId, "1", target, op),
    PlacementConflictError,
  );
  const move = await placementMove(db, tenantId, op);
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      "UPDATE organizations SET shard_id=$2,routing_epoch=2,placement_state='activating' WHERE tenant_id=$1",
      [tenantId, target],
    ),
    /matching switched move receipt/,
  );
  assert.equal(move.state, "quiescing");
});
test("only one concurrent move per tenant wins and conflicting operation reuse is rejected", async () => {
  const { tenantId, route } = await organization();
  const targets = ["s1", "s2", "s3", "s4"].filter((s) => s !== route.shardId);
  const ops = [randomUUID(), randomUUID()];
  const result = await Promise.allSettled(
    ops.map((op, i) => beginPlacementMove(db, tenantId, "1", targets[i]!, op)),
  );
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const index = result.findIndex((r) => r.status === "fulfilled");
  await assert.rejects(
    beginPlacementMove(db, tenantId, "2", targets[index]!, ops[index]!),
    IdempotencyConflictError,
  );
  await assert.rejects(
    beginPlacementMove(
      db,
      tenantId,
      "1",
      targets[(index + 1) % 2]!,
      ops[index]!,
    ),
    IdempotencyConflictError,
  );
});
test("pre-switch abort requires positive receipts and fences old epochs", async () => {
  const { tenantId, target, route } = await organization();
  const op = randomUUID();
  await beginPlacementMove(db, tenantId, "1", target, op);
  await assert.rejects(
    finishPlacementMove(db, tenantId, op, "aborted"),
    PlacementConflictError,
  );
  for (const key of ["targets_unactivated", "source_reactivated"])
    await recordPlacementMoveReceipt(
      db,
      tenantId,
      op,
      key,
      await receipt(tenantId, op, key),
    );
  const aborted = await finishPlacementMove(db, tenantId, op, "aborted");
  assert.equal(aborted.resultingEpoch, "2");
  const restored = await resolveTenant(db, tenantId);
  assert.equal(restored.shardId, route.shardId);
  assert.equal(restored.state, "active");
  assert.equal(restored.placementEpoch, "2");
  await assert.rejects(
    compareAndSetPlacement(db, tenantId, "1", target, op),
    PlacementConflictError,
  );
});
test("immutable receipts and forced RLS isolate move ledgers", async () => {
  const a = await organization(),
    b = await organization();
  const op = randomUUID();
  await beginPlacementMove(db, a.tenantId, "1", a.target, op);
  const immutableProof = await receipt(a.tenantId, op, "source_fenced");
  await recordPlacementMoveReceipt(
    db,
    a.tenantId,
    op,
    "source_fenced",
    immutableProof,
  );
  await recordPlacementMoveReceipt(db, a.tenantId, op, "source_fenced", {
    ...immutableProof,
  });
  await assert.rejects(
    recordPlacementMoveReceipt(db, a.tenantId, op, "source_fenced", {
      ...immutableProof,
      epoch: "9",
    }),
    IdempotencyConflictError,
  );
  assert.equal((await placementMove(db, a.tenantId, op)).expectedEpoch, "1");
  await assert.rejects(placementMove(db, b.tenantId, op), NotFoundError);
  assert.equal(
    (
      await asRuntime(
        { "app.tenant_id": b.tenantId },
        "SELECT * FROM placement_moves WHERE tenant_id=$1",
        [a.tenantId],
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": b.tenantId },
      "INSERT INTO placement_moves (tenant_id,operation_id,expected_epoch,source_shard_id,target_shard_id,state) VALUES ($1,$2,1,'s1','s2','quiescing')",
      [a.tenantId, randomUUID()],
    ),
    /row-level security/,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": a.tenantId },
      "DELETE FROM placement_moves WHERE tenant_id=$1",
      [a.tenantId],
    ),
    /permission denied/,
  );
});
test("database enforces registry references, epoch monotonicity, and one live move", async () => {
  const { tenantId, target, route } = await organization();
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      "UPDATE organizations SET shard_id=$2 WHERE tenant_id=$1",
      [tenantId, target],
    ),
    /epoch must advance/,
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      "UPDATE organizations SET shard_id='missing',routing_epoch=2 WHERE tenant_id=$1",
      [tenantId],
    ),
    /matching switched move receipt/,
  );
  const unknown = randomUUID();
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": unknown },
      "INSERT INTO organizations (tenant_id,name,created_by,shard_id) VALUES ($1,'unknown',$1,'missing')",
      [unknown],
    ),
    /foreign key/,
  );
  await adminQuery(
    "UPDATE organizations SET routing_epoch=2 WHERE tenant_id=$1",
    [tenantId],
  );
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      "UPDATE organizations SET routing_epoch=1 WHERE tenant_id=$1",
      [tenantId],
    ),
    /epoch must advance/,
  );
  await beginPlacementMove(db, tenantId, "2", target, randomUUID());
  await assert.rejects(
    asRuntime(
      { "app.tenant_id": tenantId },
      "INSERT INTO placement_moves (tenant_id,operation_id,expected_epoch,source_shard_id,target_shard_id,state) VALUES ($1,$2,2,$3,$4,'quiescing')",
      [tenantId, randomUUID(), route.shardId, target],
    ),
    /unique constraint/,
  );
});
