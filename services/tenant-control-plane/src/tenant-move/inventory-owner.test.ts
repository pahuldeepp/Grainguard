import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  abortInventoryMoveTarget,
  activateInventoryMoveTarget,
  assertInventoryMoveEffectsDrained,
  assertInventoryMoveSchema,
  fenceInventoryMoveSource,
  prepareInventoryMoveTarget,
  reactivateInventoryMoveSource,
} from "./inventory-owner.js";

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
  owner: "inventory",
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
  effects = { has_cdc_history: false, has_pending_saga_effects: false };

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }

  async query(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    if (sql.includes("FROM pg_class")) return { rows: this.tables };
    if (sql.includes("has_cdc_history")) return { rows: [this.effects] };
    return { rows: [{ receipt: this.receipt }] };
  }
}

function pool(receipt: Record<string, unknown>) {
  const value = new FakePool();
  value.receipt = receipt;
  return value;
}

test("inventory adapter calls owner-local procedures and validates their receipts", async () => {
  const targetPool = pool({
    ...identities,
    phase: "target_prepared",
    shardId: target.shardId,
    epoch: target.epoch,
    state: "prepared",
  });
  const prepared = await prepareInventoryMoveTarget(
    targetPool as unknown as Pool,
    tenant,
    operation,
    source,
    target,
  );
  assert.equal(prepared.owner, "inventory");
  assert.match(targetPool.calls[0]!.sql, /prepare_tenant_move_target/);

  const sourcePool = pool({
    ...identities,
    phase: "source_fenced",
    shardId: source.shardId,
    epoch: source.epoch,
    state: "fenced",
  });
  const fenced = await fenceInventoryMoveSource(
    sourcePool as unknown as Pool,
    tenant,
    operation,
    source,
    target,
  );
  assert.equal(fenced.phase, "source_fenced");
  assert.match(
    sourcePool.calls.find((call) =>
      call.sql.includes("fence_tenant_move_source"),
    )!.sql,
    /fence_tenant_move_source/,
  );

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
    activateInventoryMoveTarget(
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
  const activated = await activateInventoryMoveTarget(
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
  const targetAbsent = await abortInventoryMoveTarget(
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
  const reactivated = await reactivateInventoryMoveSource(
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

test("inventory copy preflight accepts exact nonpartitioned schema and rejects drift", async () => {
  const names = [
    "audit_events",
    "bin_cables",
    "bin_occupancies",
    "bins",
    "cable_sensors",
    "command_receipts",
    "devices",
    "grain_lots",
    "inventory_import_state",
    "inventory_saga_receipts",
    "inventory_saga_result_outbox",
    "outbox_events",
    "sites",
    "tenant_entitlements",
    "tenants",
  ];
  const sourcePool = new FakePool();
  sourcePool.tables = names.map((table_name) => ({
    table_name,
    relkind: "r",
    is_partition: false,
  }));
  await assertInventoryMoveSchema(sourcePool as unknown as Pool);

  const partitioned = new FakePool();
  partitioned.tables = sourcePool.tables.map((row) => ({ ...row }));
  partitioned.tables[9]!.is_partition = true;
  await assert.rejects(
    assertInventoryMoveSchema(partitioned as unknown as Pool),
    /schema differs/,
  );

  const drifted = new FakePool();
  drifted.tables = sourcePool.tables.slice(1);
  await assert.rejects(
    assertInventoryMoveSchema(drifted as unknown as Pool),
    /schema differs/,
  );
});

test("inventory move preflight refuses historical CDC and pending saga effects", async () => {
  const historical = new FakePool();
  historical.effects.has_cdc_history = true;
  await assert.rejects(
    assertInventoryMoveEffectsDrained(historical as unknown as Pool, tenant),
    /CDC outbox history/,
  );
  assert.match(historical.calls[0]!.sql, /BEGIN/);
  assert.match(historical.calls[1]!.sql, /set_config\('app\.tenant_id'/);
  assert.deepEqual(historical.calls[1]!.values, [tenant]);
  assert.match(historical.calls[2]!.sql, /public\.outbox_events/);
  assert.match(historical.calls.at(-1)!.sql, /ROLLBACK/);

  const pending = new FakePool();
  pending.effects.has_pending_saga_effects = true;
  await assert.rejects(
    assertInventoryMoveEffectsDrained(pending as unknown as Pool, tenant),
    /pending saga result effects/,
  );
  assert.match(pending.calls[2]!.sql, /published_at IS NULL/);
  assert.match(pending.calls.at(-1)!.sql, /ROLLBACK/);

  const drained = new FakePool();
  await assertInventoryMoveEffectsDrained(drained as unknown as Pool, tenant);
  assert.match(drained.calls.at(-1)!.sql, /COMMIT/);
});
