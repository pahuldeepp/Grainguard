import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, QueryResultRow } from "pg";
import * as inventory from "./inventory-owner.js";
import * as telemetry from "./telemetry-owner.js";
import * as risk from "./risk-owner.js";
import type { MoveReceipt } from "./pg-owner.js";

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
const hash = "a".repeat(64);
const route = {
  tenantId: tenant,
  shardId: target.shardId,
  placementEpoch: target.epoch,
  state: "activating",
};
const bindings = [
  {
    owner: "inventory",
    tables: [
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
    ],
    prepare: inventory.prepareInventoryMoveTarget,
    fence: inventory.fenceInventoryMoveSource,
    copy: inventory.copyInventoryTenantSnapshot,
    activate: inventory.activateInventoryMoveTarget,
    abort: inventory.abortInventoryMoveTarget,
    reactivate: inventory.reactivateInventoryMoveSource,
  },
  {
    owner: "telemetry",
    tables: [
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
    ],
    prepare: telemetry.prepareTelemetryMoveTarget,
    fence: telemetry.fenceTelemetryMoveSource,
    copy: telemetry.copyTelemetryTenantSnapshot,
    activate: telemetry.activateTelemetryMoveTarget,
    abort: telemetry.abortTelemetryMoveTarget,
    reactivate: telemetry.reactivateTelemetryMoveSource,
  },
  {
    owner: "risk",
    tables: [
      "bin_lot_intervals",
      "consumer_inbox",
      "device_bindings",
      "device_risk_streams",
      "grain_policies",
      "outbox_events",
      "risk_assessment_invalidations",
      "risk_assessments",
    ],
    prepare: risk.prepareRiskMoveTarget,
    fence: risk.fenceRiskMoveSource,
    copy: risk.copyRiskTenantSnapshot,
    activate: risk.activateRiskMoveTarget,
    abort: risk.abortRiskMoveTarget,
    reactivate: risk.reactivateRiskMoveSource,
  },
] as const;
type Binding = (typeof bindings)[number];
type Event = {
  endpoint: "source" | "target";
  connection: "pool" | "client";
  sql: string;
  values?: unknown[];
};
const prepareSql =
  "SELECT greenguard_internal.prepare_tenant_move_target($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,$7::uuid,$8::bigint) AS receipt";
const fenceSql =
  "SELECT greenguard_internal.fence_tenant_move_source($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,$7::uuid,$8::bigint) AS receipt";
const copySql =
  "SELECT greenguard_internal.record_tenant_move_copy($1::uuid,$2::uuid,$3,$4,$5::bigint,$6::integer) AS receipt";
const moveValues = [
  tenant,
  operation,
  source.shardId,
  source.incarnation,
  source.epoch,
  target.shardId,
  target.incarnation,
  target.epoch,
];
function receipt(
  binding: Binding,
  phase: string,
  extra: Record<string, unknown> = {},
): MoveReceipt {
  return {
    owner: binding.owner,
    tenantId: tenant,
    operationId: operation,
    phase,
    sourceShardId: source.shardId,
    sourceIncarnation: source.incarnation,
    sourceEpoch: source.epoch,
    targetShardId: target.shardId,
    targetIncarnation: target.incarnation,
    targetEpoch: target.epoch,
    ...extra,
  };
}
function durableReceipt(binding: Binding) {
  return receipt(binding, "copy_verified", {
    sourceSha256: hash,
    targetSha256: hash,
    rowCount: "1",
    tableCount: binding.tables.length,
    verifiedAt: "2026-10-12T00:00:00.000Z",
  });
}

// No network-backed pool is constructed: every pool and checked-out client query
// is recorded, including the exact procedure SQL and its ordered parameters.
class OwnerPool {
  response: unknown;
  status: unknown;
  tables: { table_name: string; relkind: string; is_partition: boolean }[];
  effects: unknown = {
    has_cdc_history: false,
    has_pending_saga_effects: false,
  };
  connects = 0;
  releases = 0;
  copyMutation: Record<string, unknown> = {};
  pending = new Map<string, QueryResultRow[]>();
  constructor(
    readonly binding: Binding,
    readonly endpoint: "source" | "target",
    readonly events: Event[] = [],
  ) {
    this.tables = binding.tables.map((table_name) => ({
      table_name,
      relkind: "r",
      is_partition: false,
    }));
    this.status = {
      state: endpoint === "source" ? "source_fenced" : "copy_verified",
      receipt:
        endpoint === "source"
          ? receipt(binding, "source_fenced")
          : durableReceipt(binding),
    };
  }
  get pool() {
    return this as unknown as Pool;
  }
  async connect() {
    this.connects++;
    return {
      query: (sql: string, values?: unknown[]) =>
        this.run(sql, values, "client"),
      release: () => this.releases++,
    };
  }
  async query(sql: string, values?: unknown[]) {
    return this.run(sql, values, "pool");
  }
  async run(
    sql: string,
    values: unknown[] | undefined,
    connection: Event["connection"],
  ) {
    this.events.push({ endpoint: this.endpoint, connection, sql, values });
    if (sql.includes("AS status")) return { rows: [{ status: this.status }] };
    if (sql.includes("has_cdc_history"))
      return { rows: this.effects === undefined ? [] : [this.effects] };
    if (sql.includes("FROM pg_class")) {
      if (connection === "pool") return { rows: this.tables };
      return {
        rows: this.tables.flatMap((row) => [
          {
            ...row,
            column_name: "id",
            data_type: "uuid",
            is_primary_key: true,
          },
          {
            ...row,
            column_name: "tenant_id",
            data_type: "uuid",
            is_primary_key: false,
          },
        ]),
      };
    }
    if (sql.includes("FROM pg_constraint")) return { rows: [] };
    if (sql.includes("FROM greenguard_internal.tenant_ownership")) {
      const identity = this.endpoint === "source" ? source : target;
      return {
        rows: [
          {
            shard_id: identity.shardId,
            incarnation: identity.incarnation,
            epoch: identity.epoch,
            state: this.endpoint === "source" ? "fenced" : "prepared",
          },
        ],
      };
    }
    if (sql === copySql)
      return {
        rows: [
          {
            receipt: receipt(this.binding, "copy_verified", {
              sourceSha256: values![2],
              targetSha256: values![3],
              rowCount: values![4],
              tableCount: values![5],
              ...this.copyMutation,
            }),
          },
        ],
      };
    const table = /public\."([a-z_]+)"/.exec(sql)?.[1];
    if (table && sql.startsWith("SELECT 1")) return { rows: [], rowCount: 0 };
    if (table && sql.startsWith("INSERT")) {
      this.pending.set(table, [{ id: values![0], tenant_id: values![1] }]);
      return { rows: [], rowCount: 1 };
    }
    if (table && sql.startsWith("SELECT"))
      return {
        rows:
          this.endpoint === "source"
            ? [{ id: operation, tenant_id: tenant }]
            : (this.pending.get(table) ?? []),
      };
    if (sql === "ROLLBACK") this.pending.clear();
    return { rows: [{ receipt: this.response }] };
  }
}

for (const binding of bindings) {
  test(`${binding.owner}: exact lifecycle SQL, parameters and preflight ordering`, async () => {
    const pool = new OwnerPool(binding, "target");
    pool.response = receipt(binding, "target_prepared", {
      state: "prepared",
      shardId: target.shardId,
      epoch: target.epoch,
    });
    assert.equal(
      (await binding.prepare(pool.pool, tenant, operation, source, target))
        .owner,
      binding.owner,
    );
    assert.deepEqual(pool.events, [
      {
        endpoint: "target",
        connection: "pool",
        sql: prepareSql,
        values: moveValues,
      },
    ]);
    pool.events.length = 0;
    pool.response = receipt(binding, "source_fenced", {
      state: "fenced",
      shardId: source.shardId,
      epoch: source.epoch,
    });
    await binding.fence(pool.pool, tenant, operation, source, target);
    assert.deepEqual(pool.events.at(-1), {
      endpoint: "target",
      connection: "pool",
      sql: fenceSql,
      values: moveValues,
    });
    if (binding.owner === "inventory") {
      assert.deepEqual(
        pool.events.map((e) => e.sql),
        [
          "BEGIN",
          "SELECT set_config('app.tenant_id',$1,true)",
          "SELECT EXISTS(SELECT 1 FROM public.outbox_events WHERE tenant_id=$1::uuid) AS has_cdc_history,\n        EXISTS(SELECT 1 FROM public.inventory_saga_result_outbox WHERE tenant_id=$1::uuid AND published_at IS NULL) AS has_pending_saga_effects",
          "COMMIT",
          fenceSql,
        ],
      );
      assert.equal(pool.releases, 1);
    } else {
      assert.equal(
        pool.events[0]!.sql,
        "SELECT greenguard_internal.tenant_move_has_cdc_history($1::uuid) AS has_cdc_history",
      );
      assert.deepEqual(pool.events[0]!.values, [tenant]);
      assert.equal(pool.connects, 0);
    }
    pool.events.length = 0;
    pool.response = receipt(binding, "target_activated", {
      state: "active",
      shardId: target.shardId,
      epoch: target.epoch,
      sourceSha256: hash,
      targetSha256: hash,
    });
    await binding.activate(pool.pool, tenant, operation, source, target, route);
    assert.equal(
      pool.events[0]!.sql,
      "SELECT greenguard_internal.activate_tenant_move_target($1::uuid,$2::uuid) AS receipt",
    );
    assert.deepEqual(pool.events[0]!.values, [tenant, operation]);
    pool.response = receipt(binding, "targets_unactivated", {
      state: "absent",
      shardId: target.shardId,
    });
    const absent = await binding.abort(
      pool.pool,
      tenant,
      operation,
      source,
      target,
    );
    assert.equal(
      pool.events[1]!.sql,
      "SELECT greenguard_internal.abort_tenant_move_target($1::uuid,$2::uuid) AS receipt",
    );
    pool.response = receipt(binding, "source_reactivated", {
      state: "active",
      shardId: source.shardId,
      epoch: target.epoch,
    });
    // Each public adapter retains its own literal receipt owner type.
    const reactivate =
      binding.reactivate as typeof inventory.reactivateInventoryMoveSource;
    await reactivate(
      pool.pool,
      tenant,
      operation,
      source,
      target,
      absent as inventory.InventoryMoveReceipt,
    );
    assert.equal(
      pool.events[2]!.sql,
      binding.owner === "risk"
        ? "SELECT greenguard_internal.reactivate_tenant_move_source($1::uuid,$2::uuid,$3::jsonb) AS receipt"
        : "SELECT greenguard_internal.reactivate_tenant_move_source($1::uuid,$2::uuid) AS receipt",
    );
    assert.deepEqual(
      pool.events[2]!.values,
      binding.owner === "risk"
        ? [tenant, operation, JSON.stringify(absent)]
        : [tenant, operation],
    );
  });

  test(`${binding.owner}: receipt identities and lifecycle proof fields fail closed`, async () => {
    const base = receipt(binding, "target_prepared", {
      state: "prepared",
      shardId: target.shardId,
      epoch: target.epoch,
    });
    for (const key of [
      "owner",
      "tenantId",
      "operationId",
      "phase",
      "sourceShardId",
      "sourceIncarnation",
      "sourceEpoch",
      "targetShardId",
      "targetIncarnation",
      "targetEpoch",
    ]) {
      const pool = new OwnerPool(binding, "target");
      pool.response = {
        ...base,
        [key]:
          key === "owner"
            ? binding.owner === "risk"
              ? "inventory"
              : "risk"
            : "wrong",
      };
      await assert.rejects(
        binding.prepare(pool.pool, tenant, operation, source, target),
        {
          message: `${binding.owner} target_prepared receipt identity is invalid`,
        },
      );
    }
    for (const missing of [undefined, null, [], "receipt", 1]) {
      const pool = new OwnerPool(binding, "target");
      pool.response = missing;
      await assert.rejects(
        binding.prepare(pool.pool, tenant, operation, source, target),
        { message: `${binding.owner} owner procedure returned no receipt` },
      );
    }
    for (const mutation of [
      { state: "active" },
      { shardId: source.shardId },
      { epoch: source.epoch },
    ]) {
      const pool = new OwnerPool(binding, "target");
      pool.response = { ...base, ...mutation };
      await assert.rejects(
        binding.prepare(pool.pool, tenant, operation, source, target),
        { message: `${binding.owner} target preparation receipt is invalid` },
      );
    }
    const pool = new OwnerPool(binding, "target");
    for (const mutation of [
      { tenantId: operation },
      { shardId: source.shardId },
      { placementEpoch: source.epoch },
      { state: "quiescing" },
    ]) {
      await assert.rejects(
        binding.activate(pool.pool, tenant, operation, source, target, {
          ...route,
          ...mutation,
        }),
        {
          message: `control-plane placement is not switched to ${binding.owner} target`,
        },
      );
    }
    assert.equal(pool.events.length, 0);
  });

  test(`${binding.owner}: validation preserves malformed epoch and short circuit behavior`, async () => {
    const pool = new OwnerPool(binding, "target");
    for (const badTenant of ["", "not-a-uuid"])
      await assert.rejects(
        binding.prepare(pool.pool, badTenant, operation, source, target),
        { message: `invalid ${binding.owner} move tenant or operation id` },
      );
    await assert.rejects(
      binding.prepare(pool.pool, tenant, "bad", source, target),
      { message: `invalid ${binding.owner} move tenant or operation id` },
    );
    for (const mutation of [
      { shardId: "s5" },
      { shardId: source.shardId },
      { incarnation: "bad" },
      { epoch: "5" },
      { epoch: "7" },
    ])
      await assert.rejects(
        binding.prepare(pool.pool, tenant, operation, source, {
          ...target,
          ...mutation,
        }),
        { message: `invalid ${binding.owner} move placement identities` },
      );
    for (const epoch of ["0", "01", "-1", "1.5", "garbage"])
      await assert.rejects(
        binding.prepare(
          pool.pool,
          tenant,
          operation,
          { ...source, epoch },
          target,
        ),
        { message: `invalid ${binding.owner} move placement identities` },
      );
    for (const epoch of ["garbage", "6.1"])
      await assert.rejects(
        binding.prepare(pool.pool, tenant, operation, source, {
          ...target,
          epoch,
        }),
        SyntaxError,
      );
    assert.equal(pool.events.length, 0);
    // The existing adapter accepts BigInt's alternate target spellings. Preserve
    // this contract during extraction, including the literal SQL parameter.
    for (const epoch of ["06", " 6 ", "+6"]) {
      const alternate = { ...target, epoch };
      pool.response = {
        ...receipt(binding, "target_prepared"),
        state: "prepared",
        shardId: target.shardId,
        targetEpoch: epoch,
        epoch,
      };
      await binding.prepare(pool.pool, tenant, operation, source, alternate);
      assert.equal(pool.events.at(-1)!.values![7], epoch);
    }
  });

  test(`${binding.owner}: preflight failures never fence`, async () => {
    for (const effects of [
      undefined,
      { has_cdc_history: true, has_pending_saga_effects: false },
      ...(binding.owner === "inventory"
        ? [{ has_cdc_history: false, has_pending_saga_effects: true }]
        : []),
    ]) {
      const pool = new OwnerPool(binding, "source");
      pool.effects = effects;
      await assert.rejects(
        binding.fence(pool.pool, tenant, operation, source, target),
        effects === undefined ? /preflight returned no result/ : /move blocked/,
      );
      assert.equal(
        pool.events.some((e) => e.sql === fenceSql),
        false,
      );
      if (binding.owner === "inventory") {
        assert.equal(pool.events.at(-1)!.sql, "ROLLBACK");
        assert.equal(pool.releases, 1);
      }
    }
  });

  test(`${binding.owner}: durable copy retry verifies both roles without transactions`, async () => {
    const events: Event[] = [];
    const from = new OwnerPool(binding, "source", events);
    const to = new OwnerPool(binding, "target", events);
    const copied = await binding.copy(
      from.pool,
      to.pool,
      tenant,
      operation,
      source,
      target,
    );
    assert.deepEqual(copied.receipt, durableReceipt(binding));
    assert.deepEqual(copied.evidence, {
      tenantId: tenant,
      operationId: operation,
      source,
      target,
      tableCount: binding.tables.length,
      rowCount: "1",
      sourceSha256: hash,
      targetSha256: hash,
      verifiedAt: "2026-10-12T00:00:00.000Z",
    });
    assert.deepEqual(events.slice(2), [
      {
        endpoint: "source",
        connection: "pool",
        sql: "SELECT greenguard_internal.tenant_move_status($1::uuid,$2::uuid,'source') AS status",
        values: [tenant, operation],
      },
      {
        endpoint: "target",
        connection: "pool",
        sql: "SELECT greenguard_internal.tenant_move_status($1::uuid,$2::uuid,'target') AS status",
        values: [tenant, operation],
      },
    ]);
    assert.equal(from.connects + to.connects, 0);
  });

  test(`${binding.owner}: copy rejects schema drift on either endpoint before status or connection`, async () => {
    for (const endpoint of ["source", "target"] as const)
      for (const failure of [
        "missing",
        "extra",
        "reordered",
        "partition",
        "parent",
      ]) {
        const events: Event[] = [];
        const from = new OwnerPool(binding, "source", events);
        const to = new OwnerPool(binding, "target", events);
        const pool = endpoint === "source" ? from : to;
        if (failure === "missing") pool.tables.pop();
        if (failure === "extra")
          pool.tables.push({
            table_name: "unknown_tenant_table",
            relkind: "r",
            is_partition: false,
          });
        if (failure === "reordered") pool.tables.reverse();
        if (failure === "partition") pool.tables[0]!.is_partition = true;
        if (failure === "parent") pool.tables[0]!.relkind = "p";
        await assert.rejects(
          binding.copy(from.pool, to.pool, tenant, operation, source, target),
          {
            message: `${binding.owner} move schema differs from its reviewed table inventory; expected ${binding.tables.join(",")}, got ${pool.tables.map((row) => row.table_name).join(",")}`,
          },
        );
        assert.equal(events.length, 2);
        assert.equal(from.connects + to.connects, 0);
      }
  });

  test(`${binding.owner}: copy rejects role, owner and malformed durable evidence`, async () => {
    for (const endpoint of ["source", "target"] as const)
      for (const key of [
        "owner",
        "tenantId",
        "operationId",
        "phase",
        "sourceShardId",
        "sourceIncarnation",
        "sourceEpoch",
        "targetShardId",
        "targetIncarnation",
        "targetEpoch",
      ]) {
        const from = new OwnerPool(binding, "source");
        const to = new OwnerPool(binding, "target");
        const pool = endpoint === "source" ? from : to;
        pool.status = {
          state: endpoint === "source" ? "source_fenced" : "copy_verified",
          receipt: {
            ...(endpoint === "source"
              ? receipt(binding, "source_fenced")
              : durableReceipt(binding)),
            [key]: "wrong",
          },
        };
        await assert.rejects(
          binding.copy(from.pool, to.pool, tenant, operation, source, target),
          /receipt identity is invalid/,
        );
        assert.equal(from.connects + to.connects, 0);
      }
    for (const mutation of [
      { sourceSha256: "bad" },
      { sourceSha256: 1 },
      { targetSha256: "b".repeat(64) },
      { rowCount: 1 },
      { rowCount: "-1" },
      { tableCount: "1" },
      { tableCount: 1.5 },
      { verifiedAt: null },
    ]) {
      const from = new OwnerPool(binding, "source");
      const to = new OwnerPool(binding, "target");
      to.status = {
        state: "copy_verified",
        receipt: { ...durableReceipt(binding), ...mutation },
      };
      await assert.rejects(
        binding.copy(from.pool, to.pool, tenant, operation, source, target),
        { message: `durable ${binding.owner} copy receipt is invalid` },
      );
      assert.equal(from.connects + to.connects, 0);
    }
    for (const state of ["active", "absent"]) {
      const from = new OwnerPool(binding, "source");
      const to = new OwnerPool(binding, "target");
      to.status = { state, receipt: receipt(binding, "target_prepared") };
      await assert.rejects(
        binding.copy(from.pool, to.pool, tenant, operation, source, target),
        { message: `${binding.owner} target is not prepared for copy` },
      );
    }
    const from = new OwnerPool(binding, "source");
    const to = new OwnerPool(binding, "target");
    from.status = {
      state: "active",
      receipt: receipt(binding, "source_fenced"),
    };
    await assert.rejects(
      binding.copy(from.pool, to.pool, tenant, operation, source, target),
      { message: `${binding.owner} source is not durably fenced` },
    );
  });

  test(`${binding.owner}: copy proof uses target transaction before commits and rolls back on mismatch`, async () => {
    for (const fail of [false, true]) {
      const events: Event[] = [];
      const from = new OwnerPool(binding, "source", events);
      const to = new OwnerPool(binding, "target", events);
      to.status = {
        state: "prepared",
        receipt: receipt(binding, "target_prepared"),
      };
      if (fail) to.copyMutation = { targetSha256: "b".repeat(64) };
      const run = binding.copy(
        from.pool,
        to.pool,
        tenant,
        operation,
        source,
        target,
      );
      if (fail)
        await assert.rejects(run, {
          message:
            binding.owner === "risk"
              ? "Risk copy receipt differs from verified snapshot evidence"
              : `${binding.owner} copy receipt differs from verified snapshot`,
        });
      else {
        const copied = await run;
        assert.equal(copied.evidence.rowCount, String(binding.tables.length));
        assert.equal(copied.receipt.owner, binding.owner);
      }
      const proofIndex = events.findIndex((e) => e.sql === copySql);
      assert.ok(proofIndex > 0);
      const proof = events[proofIndex]!;
      assert.equal(proof.endpoint, "target");
      assert.equal(proof.connection, "client");
      assert.deepEqual(proof.values!.slice(0, 2), [tenant, operation]);
      assert.equal(proof.values![2], proof.values![3]);
      assert.deepEqual(proof.values!.slice(4), [
        String(binding.tables.length),
        binding.tables.length,
      ]);
      assert.deepEqual(
        events.slice(proofIndex + 1).map((e) => `${e.endpoint}:${e.sql}`),
        fail
          ? ["target:ROLLBACK", "source:ROLLBACK"]
          : ["target:COMMIT", "source:COMMIT"],
      );
      assert.equal(from.releases, 1);
      assert.equal(to.releases, 1);
      if (fail) assert.equal(to.pending.size, 0);
    }
  });
  test(`${binding.owner}: lifecycle state guards reject source-target substitutions`, async () => {
    const cases = [
      {
        invoke: binding.fence,
        phase: "source_fenced",
        good: { state: "fenced", shardId: source.shardId, epoch: source.epoch },
        mutations: [
          { state: "active" },
          { shardId: target.shardId },
          { epoch: target.epoch },
        ],
        error: `${binding.owner} source fence receipt is invalid`,
      },
      {
        invoke: (
          pool: Pool,
          tenantId: string,
          operationId: string,
          from: typeof source,
          to: typeof target,
        ) => binding.activate(pool, tenantId, operationId, from, to, route),
        phase: "target_activated",
        good: {
          state: "active",
          shardId: target.shardId,
          epoch: target.epoch,
          sourceSha256: hash,
          targetSha256: hash,
        },
        mutations: [
          { state: "prepared" },
          { shardId: source.shardId },
          { epoch: source.epoch },
          { sourceSha256: 1 },
          { sourceSha256: "bad", targetSha256: "bad" },
          { targetSha256: "b".repeat(64) },
        ],
        error: `${binding.owner} target activation receipt is invalid`,
      },
      {
        invoke: binding.abort,
        phase: "targets_unactivated",
        good: { state: "absent", shardId: target.shardId },
        mutations: [{ state: "active" }, { shardId: source.shardId }],
        error: `${binding.owner} target abort receipt is invalid`,
      },
    ];
    for (const value of cases)
      for (const mutation of value.mutations) {
        const pool = new OwnerPool(binding, "target");
        pool.response = receipt(binding, value.phase, {
          ...value.good,
          ...mutation,
        });
        await assert.rejects(
          value.invoke(pool.pool, tenant, operation, source, target),
          { message: value.error },
        );
      }
    const reactivate =
      binding.reactivate as typeof inventory.reactivateInventoryMoveSource;
    const absent = receipt(binding, "targets_unactivated", {
      state: "absent",
      shardId: target.shardId,
    });
    for (const mutation of [
      { state: "active" },
      { owner: "foreign" },
      { targetEpoch: source.epoch },
    ]) {
      const pool = new OwnerPool(binding, "source");
      await assert.rejects(
        reactivate(pool.pool, tenant, operation, source, target, {
          ...absent,
          ...mutation,
        } as inventory.InventoryMoveReceipt),
        {
          message:
            "state" in mutation
              ? `${binding.owner} target must be proven unactivated before source reactivation`
              : `${binding.owner} targets_unactivated receipt identity is invalid`,
        },
      );
      assert.equal(pool.events.length, 0);
    }
    for (const mutation of [
      { state: "fenced" },
      { shardId: target.shardId },
      { epoch: source.epoch },
    ]) {
      const pool = new OwnerPool(binding, "source");
      pool.response = receipt(binding, "source_reactivated", {
        state: "active",
        shardId: source.shardId,
        epoch: target.epoch,
        ...mutation,
      });
      await assert.rejects(
        reactivate(
          pool.pool,
          tenant,
          operation,
          source,
          target,
          absent as inventory.InventoryMoveReceipt,
        ),
        { message: `${binding.owner} source reactivation receipt is invalid` },
      );
    }
  });

  test(`${binding.owner}: missing and prepared status receipts are validated before copy`, async () => {
    for (const endpoint of ["source", "target"] as const) {
      const from = new OwnerPool(binding, "source");
      const to = new OwnerPool(binding, "target");
      const pool = endpoint === "source" ? from : to;
      pool.status =
        endpoint === "source" ? null : { state: "prepared", receipt: [] };
      await assert.rejects(
        binding.copy(from.pool, to.pool, tenant, operation, source, target),
        {
          message: `${binding.owner} ${endpoint === "source" ? "source_fenced" : "target_prepared"} procedure returned no receipt`,
        },
      );
      assert.equal(from.connects + to.connects, 0);
    }
    const from = new OwnerPool(binding, "source");
    const to = new OwnerPool(binding, "target");
    to.status = {
      state: "prepared",
      receipt: receipt(binding, "target_prepared", { owner: "foreign" }),
    };
    await assert.rejects(
      binding.copy(from.pool, to.pool, tenant, operation, source, target),
      {
        message: `${binding.owner} target_prepared receipt identity is invalid`,
      },
    );
    assert.equal(from.connects + to.connects, 0);
  });
}
