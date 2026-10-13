import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateEvent } from "@greenguard/contracts";
import type { Db } from "../db/client.js";
import { withTenant } from "../db/tenant.js";
import { postgresCode } from "../db/errors.js";
import {
  context,
  pooledDb,
  seedTenant,
  adminQuery,
  appQuery,
  type TenantFixture,
} from "../testing/fixtures.js";
import {
  changeDeviceBinding,
  createBin,
  registerDevice,
  registerPendingDevice,
  setDeviceStatus,
} from "./repository.js";
import {
  CableNotFoundError,
  createCable,
  changeCable,
  getCable,
  listCables,
  removeCable,
} from "./cables.js";
import {
  InvalidReferenceError,
  VersionConflictError,
  IdempotencyConflictError,
} from "./errors.js";

let db: Db;
let a: TenantFixture;
let b: TenantFixture;
before(async () => {
  db = pooledDb();
  a = await seedTenant(db);
  b = await seedTenant(db);
});
after(async () => {
  await db.$disconnect();
});
const input = (owner = a) => ({
  binId: owner.binId,
  deviceId: owner.deviceId,
  label: "Cable",
  sensors: [
    { label: "Low", position: 2, depthM: 2.5 },
    { label: "High", position: 1, depthM: null },
  ],
});
const create = () => createCable(db, context(a.tenantId), input());
async function events(cableId: string) {
  return adminQuery<{
    aggregate_version: string;
    payload: {
      cable_id: string;
      cable_version: string;
      operation: string;
      bin_id: string;
      device_id: string;
      sensors: {
        sensor_id: string;
        position: number;
        label: string;
        depth_m: number | null;
      }[];
    };
    event_type: string;
  }>(
    "SELECT aggregate_version::text, payload, event_type FROM outbox_events WHERE aggregate_type='cable' AND aggregate_id=$1 ORDER BY aggregate_version",
    [cableId],
  );
}

test("cable creation retries retain owner-assigned identities and one atomic snapshot/audit", async () => {
  const ctx = context(a.tenantId);
  const first = await createCable(db, ctx, input());
  assert.deepEqual(await createCable(db, ctx, input()), first);
  await assert.rejects(
    createCable(db, ctx, { ...input(), label: "Changed" }),
    IdempotencyConflictError,
  );
  assert.equal(first.cableVersion, "1");
  assert.deepEqual(
    first.sensors.map((s) => s.position),
    [1, 2],
  );
  const snapshots = await events(first.cableId);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].event_type, "cable.layout_changed");
  assert.deepEqual(
    snapshots[0].payload.sensors.map((s) => s.depth_m),
    [null, 2.5],
  );
  const [audit] = await adminQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM audit_events WHERE resource_type='cable' AND resource_id=$1",
    [first.cableId],
  );
  assert.equal(audit.n, "1");
});

test("layout edits keep sensor IDs, allow position swaps, retire omissions and reject stale edits", async () => {
  const first = await create();
  const sensors = first.sensors.map((s) => ({
    ...s,
    position: 3 - s.position,
  }));
  const second = await changeCable(
    db,
    context(a.tenantId),
    first.cableId,
    "1",
    { ...input(), sensors },
  );
  assert.deepEqual(
    second.sensors.map((s) => s.sensorId),
    first.sensors.map((s) => s.sensorId).reverse(),
  );
  await assert.rejects(
    changeCable(db, context(a.tenantId), first.cableId, "1", input()),
    VersionConflictError,
  );
  assert.equal((await events(first.cableId)).length, 2);
  const third = await changeCable(db, context(a.tenantId), first.cableId, "2", {
    ...input(),
    sensors: [second.sensors[0]],
  });
  assert.equal(third.sensors.length, 1);
  const [retained] = await adminQuery<{ status: string }>(
    "SELECT status FROM cable_sensors WHERE tenant_id=$1 AND sensor_id=$2",
    [a.tenantId, second.sensors[1].sensorId],
  );
  assert.equal(retained.status, "removed");
  await assert.rejects(
    changeCable(db, context(a.tenantId), first.cableId, "3", {
      ...input(),
      sensors: second.sensors,
    }),
    InvalidReferenceError,
  );
  assert.equal(
    (await getCable(db, a.tenantId, first.cableId)).cableVersion,
    "3",
  );
});

test("concurrent edits have exactly one winner and no failed-command owner event", async () => {
  const first = await create();
  const attempts = await Promise.allSettled(
    ["one", "two"].map((label) =>
      changeCable(db, context(a.tenantId), first.cableId, "1", {
        ...input(),
        label,
        sensors: first.sensors,
      }),
    ),
  );
  assert.equal(attempts.filter((s) => s.status === "fulfilled").length, 1);
  assert.equal(
    attempts.filter(
      (s) =>
        s.status === "rejected" && s.reason instanceof VersionConflictError,
    ).length,
    1,
  );
  assert.deepEqual(
    (await events(first.cableId)).map((s) => s.aggregate_version),
    ["1", "2"],
  );
});

test("cross-tenant cable reads, edits, removals, sensor claims and references are denied", async () => {
  const first = await create();
  const foreign = await createCable(db, context(b.tenantId), input(b));
  await assert.rejects(
    getCable(db, b.tenantId, first.cableId),
    CableNotFoundError,
  );
  await assert.rejects(
    listCables(db, b.tenantId, a.binId, 20),
    CableNotFoundError,
  );
  await assert.rejects(
    changeCable(db, context(b.tenantId), first.cableId, "1", input(b)),
    CableNotFoundError,
  );
  await assert.rejects(
    removeCable(db, context(b.tenantId), first.cableId, "1"),
    CableNotFoundError,
  );
  await assert.rejects(
    createCable(db, context(b.tenantId), input(a)),
    InvalidReferenceError,
  );
  await assert.rejects(
    createCable(db, context(b.tenantId), { ...input(b), deviceId: a.deviceId }),
    InvalidReferenceError,
  );
  await assert.rejects(
    changeCable(db, context(a.tenantId), first.cableId, "1", {
      ...input(),
      sensors: foreign.sensors,
    }),
    InvalidReferenceError,
  );
  const ownOther = await create();
  await assert.rejects(
    changeCable(db, context(a.tenantId), first.cableId, "1", {
      ...input(),
      sensors: ownOther.sensors,
    }),
    InvalidReferenceError,
  );
  assert.equal((await events(first.cableId)).length, 1);
});

test("forced RLS protects both layout tables without application predicates; identity/delete privileges remain denied", async () => {
  const first = await create();
  for (const table of ["bin_cables", "cable_sensors"]) {
    const rows = await withTenant(db, b.tenantId, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT * FROM ${table} WHERE tenant_id = $1::uuid`,
        a.tenantId,
      ),
    );
    assert.deepEqual(rows, []);
    const [{ n }] = await appQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`,
    );
    assert.equal(n, "0");
    const [flags] = await adminQuery<{ forced: boolean }>(
      "SELECT relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE relname=$1",
      [table],
    );
    assert.equal(flags.forced, true);
    await assert.rejects(
      withTenant(db, a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE ${table} SET tenant_id=$1::uuid`,
          b.tenantId,
        ),
      ),
      (e) => postgresCode(e) === "42501",
    );
    await assert.rejects(
      withTenant(db, a.tenantId, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM ${table}`),
      ),
      (e) => postgresCode(e) === "42501",
    );
  }
  await assert.rejects(
    withTenant(db, b.tenantId, (tx) =>
      tx.binCable.create({
        data: {
          tenantId: a.tenantId,
          cableId: randomUUID(),
          binId: a.binId,
          deviceId: a.deviceId,
          label: "Forged",
        },
      }),
    ),
    (e) => postgresCode(e) === "42501",
  );
  await assert.rejects(
    withTenant(db, b.tenantId, (tx) =>
      tx.cableSensor.create({
        data: {
          tenantId: a.tenantId,
          sensorId: randomUUID(),
          cableId: first.cableId,
          label: "Forged",
          position: 3,
        },
      }),
    ),
    (e) => postgresCode(e) === "42501",
  );
  await assert.rejects(
    withTenant(db, b.tenantId, (tx) =>
      tx.cableSensor.create({
        data: {
          tenantId: b.tenantId,
          sensorId: randomUUID(),
          cableId: first.cableId,
          label: "Foreign parent",
          position: 3,
        },
      }),
    ),
    (e) => postgresCode(e) === "23503",
  );
});

test("cables require an active provisioned device bound to the requested bin; physical asset cannot act as a bin", async () => {
  const other = await registerDevice(db, context(a.tenantId), {
    serialNumber: randomUUID(),
    siteId: a.siteId,
  });
  await assert.rejects(
    createCable(db, context(a.tenantId), {
      ...input(),
      deviceId: other.deviceId,
    }),
    InvalidReferenceError,
  );
  const pending = await registerPendingDevice(db, context(a.tenantId), {
    serialNumber: randomUUID(),
    siteId: a.siteId,
    binId: a.binId,
    assetId: randomUUID(),
  });
  await assert.rejects(
    createCable(db, context(a.tenantId), {
      ...input(),
      deviceId: pending.deviceId,
    }),
    InvalidReferenceError,
  );
  await assert.rejects(
    createCable(db, context(a.tenantId), {
      ...input(),
      binId: pending.assetId,
    }),
    InvalidReferenceError,
  );
});

test("device moves and deletion emit versioned owner snapshots while retaining sample identities", async () => {
  const owner = await seedTenant(db);
  const first = await createCable(db, context(owner.tenantId), input(owner));
  const binId = randomUUID();
  await createBin(db, context(owner.tenantId), {
    binId,
    siteId: owner.otherSiteId,
    name: "Moved bin",
  });
  await changeDeviceBinding(db, context(owner.tenantId), {
    deviceId: owner.deviceId,
    expectedVersion: "1",
    siteId: owner.otherSiteId,
    binId,
  });
  const moved = await getCable(db, owner.tenantId, first.cableId);
  assert.equal(moved.binId, binId);
  assert.equal(moved.cableVersion, "2");
  assert.deepEqual(
    moved.sensors.map((s) => s.sensorId),
    first.sensors.map((s) => s.sensorId),
  );
  await setDeviceStatus(db, context(owner.tenantId), {
    deviceId: owner.deviceId,
    status: "deleted",
  });
  const deleted = await getCable(db, owner.tenantId, first.cableId);
  assert.equal(deleted.status, "removed");
  assert.equal(deleted.cableVersion, "3");
  assert.deepEqual(deleted.sensors, []);
  const snapshots = await events(first.cableId);
  assert.deepEqual(
    snapshots.map((e) => [e.payload.cable_version, e.payload.operation]),
    [
      ["1", "upsert"],
      ["2", "upsert"],
      ["3", "deleted"],
    ],
  );
  assert.deepEqual(
    snapshots[0].payload.sensors.map((s) => s.sensor_id),
    first.sensors.map((s) => s.sensorId),
  );
  assert.deepEqual(snapshots[2].payload.sensors, []);
});

test("device unbinding and explicit cable removal each revoke sensors through a deleted snapshot", async () => {
  const owner = await seedTenant(db);
  const first = await createCable(db, context(owner.tenantId), input(owner));
  await changeDeviceBinding(db, context(owner.tenantId), {
    deviceId: owner.deviceId,
    expectedVersion: "1",
    siteId: owner.siteId,
    binId: null,
  });
  assert.equal(
    (await getCable(db, owner.tenantId, first.cableId)).status,
    "removed",
  );
  const another = await create();
  await assert.rejects(
    removeCable(db, context(a.tenantId), another.cableId, "2"),
    VersionConflictError,
  );
  const removed = await removeCable(
    db,
    context(a.tenantId),
    another.cableId,
    "1",
  );
  assert.equal(removed.cableVersion, "2");
  assert.deepEqual(removed.sensors, []);
  assert.equal(
    (await listCables(db, a.tenantId, a.binId, 20)).some(
      (c) => c.cableId === another.cableId,
    ),
    false,
  );
});

test("cable reassignment preserves sensor IDs and emits the new device association", async () => {
  const owner = await seedTenant(db);
  const first = await createCable(db, context(owner.tenantId), input(owner));
  const other = await registerDevice(db, context(owner.tenantId), {
    serialNumber: randomUUID(),
    siteId: owner.siteId,
    binId: owner.binId,
  });
  const moved = await changeCable(
    db,
    context(owner.tenantId),
    first.cableId,
    "1",
    { ...input(owner), deviceId: other.deviceId, sensors: first.sensors },
  );
  assert.equal(moved.deviceId, other.deviceId);
  assert.deepEqual(
    moved.sensors.map((s) => s.sensorId),
    first.sensors.map((s) => s.sensorId),
  );
  assert.equal(
    (await events(first.cableId))[1].payload.device_id,
    other.deviceId,
  );
});

test("an owner outbox failure rolls back cable, sensors, audit and receipt", async () => {
  const owner = await seedTenant(db);
  const ctx = context(owner.tenantId);
  await adminQuery(
    `CREATE FUNCTION task3_reject_cable_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_type='cable' AND NEW.tenant_id='${owner.tenantId}'::uuid THEN RAISE EXCEPTION 'task3-outbox-failure'; END IF; RETURN NEW; END $$`,
  );
  await adminQuery(
    "CREATE TRIGGER task3_reject_cable BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION task3_reject_cable_event()",
  );
  try {
    await assert.rejects(createCable(db, ctx, input(owner)));
    for (const table of ["bin_cables", "cable_sensors"]) {
      const [row] = await adminQuery<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id=$1`,
        [owner.tenantId],
      );
      assert.equal(row.n, "0");
    }
    const [row] = await adminQuery<{ n: string }>(
      "SELECT count(*)::text AS n FROM command_receipts WHERE tenant_id=$1 AND command_type='cable.create'",
      [owner.tenantId],
    );
    assert.equal(row.n, "0");
    const [audit] = await adminQuery<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE tenant_id=$1 AND resource_type='cable'",
      [owner.tenantId],
    );
    assert.equal(audit.n, "0");
  } finally {
    await adminQuery("DROP TRIGGER task3_reject_cable ON outbox_events");
    await adminQuery("DROP FUNCTION task3_reject_cable_event()");
  }
});

test("database depth checks deny nonfinite and negative values even without API validation", async () => {
  const first = await create();
  for (const depth of [-1, NaN, Infinity, -Infinity])
    await assert.rejects(
      withTenant(db, a.tenantId, (tx) =>
        tx.cableSensor.create({
          data: {
            tenantId: a.tenantId,
            cableId: first.cableId,
            sensorId: randomUUID(),
            label: "Invalid",
            position: 3,
            depthM: depth,
          },
        }),
      ),
      (e) => postgresCode(e) === "23514",
    );
});

test("every emitted cable owner event satisfies the frozen strict JSON contract", async () => {
  const rows = await adminQuery<{ event: unknown }>(
    `SELECT json_build_object('event_id',event_id,'event_type',event_type,'schema_version',schema_version,'occurred_at',to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'tenant_id',tenant_id,'aggregate_type',aggregate_type,'aggregate_id',aggregate_id,'aggregate_version',aggregate_version::text,'correlation_id',correlation_id,'causation_id',causation_id,'traceparent',traceparent,'payload',payload) AS event FROM outbox_events WHERE aggregate_type='cable'`,
  );
  assert.ok(rows.length > 0);
  for (const { event } of rows)
    assert.deepEqual(validateEvent(event), { ok: true, event });
});
