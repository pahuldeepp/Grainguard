import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  abortTelemetryMoveTarget,
  activateTelemetryMoveTarget,
  assertTelemetryMoveEffectsDrained,
  assertTelemetryMoveSchema,
  fenceTelemetryMoveSource,
  prepareTelemetryMoveTarget,
  reactivateTelemetryMoveSource,
} from "./telemetry-owner.js";

const tenant = "33333333-3333-4333-8333-333333333333";
const operation = "44444444-4444-4444-8444-444444444444";
const source = {
  shardId: "s1",
  incarnation: "11111111-1111-4111-8111-111111111111",
  epoch: "5",
};
const target = {
  shardId: "s2",
  incarnation: "22222222-2222-4222-8222-222222222222",
  epoch: "6",
};
const identities = {
  tenantId: tenant,
  operationId: operation,
  owner: "telemetry",
  sourceShardId: source.shardId,
  sourceIncarnation: source.incarnation,
  sourceEpoch: source.epoch,
  targetShardId: target.shardId,
  targetIncarnation: target.incarnation,
  targetEpoch: target.epoch,
};

class FakePool {
  calls: { sql: string; values?: unknown[] }[] = [];
  receipt: Record<string, unknown> = {};
  tables: { table_name: string; relkind: string; is_partition: boolean }[] = [];
  hasCdcHistory = false;

  async query(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    if (sql.includes("FROM pg_class")) return { rows: this.tables };
    if (sql.includes("has_cdc_history"))
      return { rows: [{ has_cdc_history: this.hasCdcHistory }] };
    return { rows: [{ receipt: this.receipt }] };
  }
}

function pool(receipt: Record<string, unknown>) {
  const value = new FakePool();
  value.receipt = receipt;
  return value;
}

test("telemetry adapter calls owner-local procedures and validates their receipts", async () => {
  const targetPool = pool({
    ...identities,
    phase: "target_prepared",
    shardId: target.shardId,
    epoch: target.epoch,
    state: "prepared",
  });
  const prepared = await prepareTelemetryMoveTarget(
    targetPool as unknown as Pool,
    tenant,
    operation,
    source,
    target,
  );
  assert.equal(prepared.owner, "telemetry");
  assert.match(targetPool.calls[0]!.sql, /prepare_tenant_move_target/);

  const sourcePool = pool({
    ...identities,
    phase: "source_fenced",
    shardId: source.shardId,
    epoch: source.epoch,
    state: "fenced",
  });
  const fenced = await fenceTelemetryMoveSource(
    sourcePool as unknown as Pool,
    tenant,
    operation,
    source,
    target,
  );
  assert.equal(fenced.phase, "source_fenced");
  assert.match(
    sourcePool.calls[0]!.sql,
    /greenguard_internal\.tenant_move_has_cdc_history/,
  );
  assert.match(sourcePool.calls[1]!.sql, /fence_tenant_move_source/);

  const activationPool = pool({
    ...identities,
    phase: "target_activated",
    shardId: target.shardId,
    epoch: target.epoch,
    state: "active",
    sourceSha256: "a".repeat(64),
    targetSha256: "a".repeat(64),
  });
  await assert.rejects(
    activateTelemetryMoveTarget(
      activationPool as unknown as Pool,
      tenant,
      operation,
      source,
      target,
      {
        tenantId: tenant,
        shardId: target.shardId,
        placementEpoch: "6",
        state: "quiescing",
      },
    ),
    /not switched/,
  );
  assert.equal(activationPool.calls.length, 0);
  const activated = await activateTelemetryMoveTarget(
    activationPool as unknown as Pool,
    tenant,
    operation,
    source,
    target,
    {
      tenantId: tenant,
      shardId: target.shardId,
      placementEpoch: "6",
      state: "activating",
    },
  );
  assert.equal(activated.state, "active");

  const abortPool = pool({
    ...identities,
    phase: "targets_unactivated",
    shardId: target.shardId,
    state: "absent",
  });
  const targetAbsent = await abortTelemetryMoveTarget(
    abortPool as unknown as Pool,
    tenant,
    operation,
    source,
    target,
  );
  const reactivatePool = pool({
    ...identities,
    phase: "source_reactivated",
    shardId: source.shardId,
    incarnation: source.incarnation,
    epoch: target.epoch,
    state: "active",
  });
  const reactivated = await reactivateTelemetryMoveSource(
    reactivatePool as unknown as Pool,
    tenant,
    operation,
    source,
    target,
    targetAbsent,
  );
  assert.equal(reactivated.epoch, target.epoch);
  assert.match(reactivatePool.calls[0]!.sql, /reactivate_tenant_move_source/);
});

test("telemetry copy preflight accepts exact nonpartitioned schema and rejects drift", async () => {
  const names = [
    "audit_events",
    "cable_layout_bindings",
    "consumer_inbox",
    "device_bindings",
    "device_streams",
    "ingest_quota_usage",
    "ingest_receipts",
    "ingest_rejection_samples",
    "outbox_events",
    "readings",
    "saga_binding_requests",
    "tenant_entitlements",
  ];
  const sourcePool = new FakePool();
  sourcePool.tables = names.map((table_name) => ({
    table_name,
    relkind: "r",
    is_partition: false,
  }));
  await assertTelemetryMoveSchema(sourcePool as unknown as Pool);

  const partitioned = new FakePool();
  partitioned.tables = sourcePool.tables.map((row) => ({ ...row }));
  partitioned.tables[9]!.is_partition = true;
  await assert.rejects(
    assertTelemetryMoveSchema(partitioned as unknown as Pool),
    /schema differs/,
  );

  const drifted = new FakePool();
  drifted.tables = sourcePool.tables.slice(1);
  await assert.rejects(
    assertTelemetryMoveSchema(drifted as unknown as Pool),
    /schema differs/,
  );
});

test("telemetry move refuses historical CDC outbox before source fence", async () => {
  const sourcePool = pool({
    ...identities,
    phase: "source_fenced",
    shardId: source.shardId,
    epoch: source.epoch,
    state: "fenced",
  });
  sourcePool.hasCdcHistory = true;
  await assert.rejects(
    fenceTelemetryMoveSource(
      sourcePool as unknown as Pool,
      tenant,
      operation,
      source,
      target,
    ),
    /CDC outbox history/,
  );
  assert.equal(sourcePool.calls.length, 1);
  assert.match(
    sourcePool.calls[0]!.sql,
    /greenguard_internal\.tenant_move_has_cdc_history/,
  );

  const malformed = pool({});
  await assert.rejects(
    assertTelemetryMoveEffectsDrained(
      malformed as unknown as Pool,
      "not-a-uuid",
    ),
    /invalid telemetry move tenant id/,
  );
  assert.equal(malformed.calls.length, 0);
});
