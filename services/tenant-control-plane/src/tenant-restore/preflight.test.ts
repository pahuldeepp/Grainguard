import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INVENTORY_RESTORE_TABLES,
  deriveLocalShardIncarnation,
  preflightInventoryRestore,
} from "./preflight.js";
const tenant = "11111111-1111-4111-8111-111111111111";
const operation = "22222222-2222-4222-8222-222222222222";
const old = "33333333-3333-4333-8333-333333333333";
const sha = "a".repeat(64);
const now = Date.parse("2026-10-04T12:00:00.000Z");
const observedAt = "2026-10-04T11:59:59.500Z";
function fixture() {
  const incarnation = deriveLocalShardIncarnation(
    "greenguard-sharding-proof",
    "s1",
    "123456789",
  );
  const source = {
    tenantId: tenant,
    shardId: "s1",
    incarnation: old,
    epoch: "1",
  };
  const target = { ...source, incarnation };
  const authority = {
    identity: target,
    state: "active",
    observedAt,
    expiresAt: "2026-10-04T12:00:01.000Z",
  };
  const tables = INVENTORY_RESTORE_TABLES.map((name) => ({
    name,
    rowCount: name === "outbox_events" ? "30" : "1",
    sha256: sha,
  }));
  return {
    version: 1,
    operationId: operation,
    actor: {
      tenantId: tenant,
      userId: operation,
      kind: "human",
      role: "admin",
      membershipObservedAt: observedAt,
    },
    authorityBefore: {
      ...structuredClone(authority),
      observedAt: "2026-10-04T11:59:59.100Z",
    },
    authorityAfter: {
      ...structuredClone(authority),
      observedAt: "2026-10-04T11:59:59.900Z",
    },
    source,
    destination: {
      identity: target,
      physicalSystemIdentifier: "123456789",
      physicalShardId: "s1",
      composeProject: "greenguard-sharding-proof",
      observedAt,
      schemaSha256: sha,
      ownershipAbsent: true,
      tableCounts: Object.fromEntries(
        INVENTORY_RESTORE_TABLES.map((name) => [name, "0"]),
      ),
    },
    snapshot: {
      identity: structuredClone(source),
      schemaSha256: sha,
      snapshotSha256: sha,
      observedAt,
      tables,
    },
    fence: {
      identity: structuredClone(source),
      operationId: operation,
      observedAt,
      state: "fenced",
      receiptSha256: sha,
    },
    preservation: {
      identity: structuredClone(source),
      operationId: operation,
      observedAt,
      sourceRetained: true,
      backupSha256: sha,
      snapshotSha256: sha,
    },
    effects: {
      identity: structuredClone(source),
      operationId: operation,
      observedAt,
      historyRows: "30",
      pendingSagaRows: "0",
      sourcePublishersFenced: true,
      frontierSha256: sha,
      deduplicationReceiptSha256: sha,
    },
  };
}
test("complete attested manifest permits only disposable proof, deterministic metadata hash, and does not mutate input", () => {
  const input = fixture(),
    copy = structuredClone(input);
  const decision = preflightInventoryRestore(input, now);
  assert.equal(decision.status, "ready_for_disposable_proof");
  assert.equal(decision.executionAllowed, false);
  assert.match(decision.planSha256!, /^[a-f0-9]{64}$/);
  assert.deepEqual(input, copy);
  assert.deepEqual(preflightInventoryRestore(copy, now), decision);
  const serialized = JSON.stringify(decision);
  assert.ok(!serialized.includes(tenant));
  assert.ok(!serialized.includes(old));
});
test("unknown or extra fields, invalid versions, identities and epoch overflow fail closed", () => {
  for (const input of [
    null,
    [],
    {},
    { ...fixture(), password: "secret" },
    { ...fixture(), version: 2 },
    {
      ...fixture(),
      source: { ...fixture().source, epoch: "9223372036854775808" },
    },
  ])
    assert.equal(preflightInventoryRestore(input, now).status, "blocked");
  assert.equal(preflightInventoryRestore(fixture(), NaN).status, "blocked");
});
test("fresh verified human tenant and unchanged short-lived authority are mandatory", () => {
  for (const mutate of [
    (i: ReturnType<typeof fixture>) => {
      i.actor.tenantId = old;
    },
    (i: ReturnType<typeof fixture>) => {
      i.actor.kind = "service";
    },
    (i: ReturnType<typeof fixture>) => {
      i.actor.role = "viewer";
    },
    (i: ReturnType<typeof fixture>) => {
      i.actor.membershipObservedAt = "2026-10-03T12:00:00.000Z";
    },
    (i: ReturnType<typeof fixture>) => {
      i.authorityAfter.identity.epoch = "2";
    },
    (i: ReturnType<typeof fixture>) => {
      i.authorityAfter.state = "quiescing";
    },
    (i: ReturnType<typeof fixture>) => {
      i.authorityAfter.expiresAt = "2026-10-04T11:59:59.000Z";
    },
    (i: ReturnType<typeof fixture>) => {
      i.authorityBefore.observedAt = "2026-10-04T12:00:00.500Z";
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(preflightInventoryRestore(input, now).status, "blocked");
  }
});
test("current local conflict refuses missing canonical target despite reachable empty primaries", () => {
  const input = fixture();
  input.destination.identity.incarnation = old;
  assert.ok(
    preflightInventoryRestore(input, now).blockers.includes(
      "missing_canonical_target",
    ),
  );
  const physical = fixture();
  physical.destination.physicalSystemIdentifier = "987654321";
  assert.ok(
    preflightInventoryRestore(physical, now).blockers.includes(
      "missing_canonical_target",
    ),
  );
});
test("destination must be empty across exact reviewed inventory and have no ownership", () => {
  for (const mutate of [
    (i: ReturnType<typeof fixture>) => {
      i.destination.tableCounts.devices = "1";
    },
    (i: ReturnType<typeof fixture>) => {
      delete i.destination.tableCounts.audit_events;
    },
    (i: ReturnType<typeof fixture>) => {
      i.destination.ownershipAbsent = false;
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.ok(
      preflightInventoryRestore(input, now).blockers.includes(
        "destination_not_empty",
      ),
    );
  }
});
test("snapshot table omission, foreign tenant, schema drift and invalid counts are denied", () => {
  for (const mutate of [
    (i: ReturnType<typeof fixture>) => {
      i.snapshot.tables.pop();
    },
    (i: ReturnType<typeof fixture>) => {
      i.snapshot.identity.tenantId = old;
    },
    (i: ReturnType<typeof fixture>) => {
      i.snapshot.schemaSha256 = "b".repeat(64);
    },
    (i: ReturnType<typeof fixture>) => {
      i.snapshot.tables[0]!.rowCount = "-1";
    },
    (i: ReturnType<typeof fixture>) => {
      i.snapshot.tables[0]!.sha256 = "invalid";
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(preflightInventoryRestore(input, now).status, "blocked");
  }
});
test("fence and preserved backup receipts bind tenant, operation, identity and snapshot", () => {
  for (const mutate of [
    (i: ReturnType<typeof fixture>) => {
      i.fence.operationId = old;
    },
    (i: ReturnType<typeof fixture>) => {
      i.fence.state = "active";
    },
    (i: ReturnType<typeof fixture>) => {
      i.fence.identity.tenantId = old;
    },
    (i: ReturnType<typeof fixture>) => {
      i.preservation.sourceRetained = false;
    },
    (i: ReturnType<typeof fixture>) => {
      i.preservation.snapshotSha256 = "b".repeat(64);
    },
    (i: ReturnType<typeof fixture>) => {
      i.preservation.backupSha256 = "";
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.equal(preflightInventoryRestore(input, now).status, "blocked");
  }
});
test("historical CDC requires deduplication and frontier receipts with publishers fenced and saga effects drained", () => {
  for (const mutate of [
    (i: ReturnType<typeof fixture>) => {
      i.effects.deduplicationReceiptSha256 = "";
    },
    (i: ReturnType<typeof fixture>) => {
      i.effects.frontierSha256 = "";
    },
    (i: ReturnType<typeof fixture>) => {
      i.effects.sourcePublishersFenced = false;
    },
    (i: ReturnType<typeof fixture>) => {
      i.effects.pendingSagaRows = "1";
    },
    (i: ReturnType<typeof fixture>) => {
      i.effects.historyRows = "0";
    },
    (i: ReturnType<typeof fixture>) => {
      i.effects.operationId = old;
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.ok(
      preflightInventoryRestore(input, now).blockers.includes(
        "cdc_deduplication_unproven",
      ),
    );
  }
});

test("fence must precede snapshot and preservation proof must follow snapshot", () => {
  const lateFence = fixture();
  lateFence.fence.observedAt = "2026-10-04T11:59:59.900Z";
  assert.ok(
    preflightInventoryRestore(lateFence, now).blockers.includes(
      "source_not_fenced",
    ),
  );
  const earlyBackup = fixture();
  earlyBackup.preservation.observedAt = "2026-10-04T11:59:59.100Z";
  assert.ok(
    preflightInventoryRestore(earlyBackup, now).blockers.includes(
      "source_not_preserved",
    ),
  );
});

test("authority observations enclose all restore receipts and foreign identities fail their own gates", () => {
  for (const key of [
    "destination",
    "snapshot",
    "fence",
    "preservation",
    "effects",
  ] as const) {
    for (const stamp of [
      "2026-10-04T11:59:59.000Z",
      "2026-10-04T12:00:00.000Z",
    ]) {
      const input = fixture();
      input[key].observedAt = stamp;
      assert.ok(
        preflightInventoryRestore(input, now).blockers.includes(
          "stale_or_changed_authority",
        ),
      );
    }
  }
  const foreignSnapshot = fixture();
  foreignSnapshot.snapshot.identity.tenantId = old;
  assert.ok(
    preflightInventoryRestore(foreignSnapshot, now).blockers.includes(
      "invalid_snapshot",
    ),
  );
  assert.equal(foreignSnapshot.source.tenantId, tenant);
  const foreignFence = fixture();
  foreignFence.fence.identity.tenantId = old;
  assert.ok(
    preflightInventoryRestore(foreignFence, now).blockers.includes(
      "source_not_fenced",
    ),
  );
  assert.equal(foreignFence.source.tenantId, tenant);
});

test("local physical identity formula keeps the reviewed vector and rejects invalid source metadata", () => {
  assert.equal(
    deriveLocalShardIncarnation("greenguard-sharding-proof", "s1", "123456789"),
    "ea926f9a-0578-45bb-8548-438fc263e51d",
  );
  for (const [project, shard, system] of [
    ["untrusted", "s1", "1"],
    ["greenguard-sharding-proof", "s9", "1"],
    ["greenguard-sharding-proof", "s1", "0"],
  ])
    assert.throws(() => deriveLocalShardIncarnation(project!, shard!, system!));
});
