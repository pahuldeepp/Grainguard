import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { LockNotAvailableError, postgresCode } from "../db/errors.js";
import { withTenant } from "../db/tenant.js";
import {
  adminQuery,
  context,
  pooledDb,
  seedTenant,
  type TenantFixture,
} from "../testing/fixtures.js";
import {
  DeviceNotFoundError,
  DuplicateBinError,
  DuplicateSerialError,
  IdempotencyConflictError,
  InvalidInputError,
  VersionConflictError,
} from "./errors.js";
import {
  changeDeviceBinding,
  createBin,
  createTenant,
  createSite,
  listDevices,
  lockDevice,
  MAX_PAGE_SIZE,
  registerDevice,
  setDeviceStatus,
} from "./repository.js";

let db: Db;
let t: TenantFixture;
before(async () => {
  db = pooledDb(8);
  t = await seedTenant(db);
});
after(() => db.$disconnect());

const counts = async (deviceId: string) => {
  const [row] = await adminQuery<Record<string, string>>(
    `SELECT (SELECT count(*) FROM devices WHERE device_id = $1) AS devices,
            (SELECT count(*) FROM outbox_events WHERE aggregate_id = $1) AS events,
            (SELECT count(*) FROM audit_events WHERE resource_id = $1) AS audits`,
    [deviceId],
  );
  return row;
};

const newDevice = (serial = `SN-${randomUUID()}`) => ({
  serialNumber: serial,
  siteId: t.siteId,
  binId: t.binId,
});

test("registration writes device, outbox event, audit and receipt together", async () => {
  const ctx = context(t.tenantId);
  const input = newDevice();
  const result = await registerDevice(db, ctx, input);
  assert.equal(result.bindingVersion, "1");
  assert.equal(result.status, "active");
  assert.deepEqual(await counts(result.deviceId), {
    devices: "1",
    events: "1",
    audits: "1",
  });
  const [event] = await adminQuery<Record<string, unknown>>(
    `SELECT event_id, event_type, aggregate_version::text AS version, correlation_id, payload
       FROM outbox_events WHERE aggregate_id = $1`,
    [result.deviceId],
  );
  assert.deepEqual(event, {
    event_id: result.eventId,
    event_type: "device.registered",
    version: "1",
    correlation_id: ctx.correlationId,
    payload: {
      device_id: result.deviceId,
      serial_number: input.serialNumber,
      site_id: t.siteId,
      bin_id: t.binId,
      status: "active",
      binding_version: "1",
    },
  });
  const [audit] = await adminQuery<{ event_id: string; action: string }>(
    "SELECT event_id, action FROM audit_events WHERE resource_id = $1",
    [result.deviceId],
  );
  assert.deepEqual(audit, {
    event_id: result.eventId,
    action: "device.register",
  });
});

test("a retry with the same idempotency key returns the original result", async () => {
  const ctx = context(t.tenantId);
  const input = newDevice();
  const first = await registerDevice(db, ctx, input);
  const again = await registerDevice(
    db,
    { ...ctx, correlationId: randomUUID() },
    input,
  );
  assert.deepEqual(again, first);
  assert.deepEqual(await counts(first.deviceId), {
    devices: "1",
    events: "1",
    audits: "1",
  });
});

test("concurrent retries of one command create exactly one device", async () => {
  const ctx = context(t.tenantId);
  const input = newDevice();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => registerDevice(db, ctx, input)),
  );
  assert.equal(new Set(results.map((r) => r.deviceId)).size, 1);
  assert.deepEqual(await counts(results[0].deviceId), {
    devices: "1",
    events: "1",
    audits: "1",
  });
});

test("reusing an idempotency key for a different request is rejected", async () => {
  const ctx = context(t.tenantId);
  await registerDevice(db, ctx, newDevice());
  await assert.rejects(
    registerDevice(db, ctx, newDevice()),
    IdempotencyConflictError,
  );
});

test("a duplicate serial number under a new key is rejected", async () => {
  const serial = `SN-${randomUUID()}`;
  await registerDevice(db, context(t.tenantId), newDevice(serial));
  await assert.rejects(
    registerDevice(db, context(t.tenantId), newDevice(serial)),
    DuplicateSerialError,
  );
});

test("other database errors are passed through unchanged", async () => {
  await assert.rejects(
    registerDevice(db, context(t.tenantId), newDevice("x".repeat(200))),
    (error) => postgresCode(error) === "23514",
  );
});

test("optimistic: a stale version changes nothing and reports the current one", async () => {
  const device = await registerDevice(db, context(t.tenantId), newDevice());
  const change = (expectedVersion: string, siteId: string) =>
    changeDeviceBinding(db, context(t.tenantId), {
      deviceId: device.deviceId,
      expectedVersion,
      siteId,
      binId: null,
    });
  const moved = await change("1", t.otherSiteId);
  assert.equal(moved.bindingVersion, "2");
  await assert.rejects(change("1", t.siteId), (error) => {
    assert.ok(error instanceof VersionConflictError);
    assert.equal(error.currentVersion, "2");
    return true;
  });
  const [row] = await adminQuery<{ site_id: string; v: string }>(
    "SELECT site_id, binding_version::text AS v FROM devices WHERE device_id = $1",
    [device.deviceId],
  );
  assert.deepEqual(row, { site_id: t.otherSiteId, v: "2" });
  const events = await adminQuery<{ event_type: string; v: string }>(
    `SELECT event_type, aggregate_version::text AS v FROM outbox_events
      WHERE aggregate_id = $1 ORDER BY aggregate_version`,
    [device.deviceId],
  );
  assert.deepEqual(events, [
    { event_type: "device.registered", v: "1" },
    { event_type: "device.binding_changed", v: "2" },
  ]);
});

test("optimistic: of two concurrent edits from the same version, exactly one wins", async () => {
  const device = await registerDevice(db, context(t.tenantId), newDevice());
  const results = await Promise.allSettled(
    [t.siteId, t.otherSiteId].map((siteId) =>
      changeDeviceBinding(db, context(t.tenantId), {
        deviceId: device.deviceId,
        expectedVersion: "1",
        siteId,
        binId: null,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" &&
      rejected.reason instanceof VersionConflictError,
  );
});

test("optimistic: an unknown device is reported as not found", async () => {
  await assert.rejects(
    changeDeviceBinding(db, context(t.tenantId), {
      deviceId: randomUUID(),
      expectedVersion: "1",
      siteId: t.siteId,
      binId: null,
    }),
    DeviceNotFoundError,
  );
});

test("pessimistic: status change locks the row, bumps the version and emits an event", async () => {
  const device = await registerDevice(db, context(t.tenantId), newDevice());
  const changed = await setDeviceStatus(db, context(t.tenantId), {
    deviceId: device.deviceId,
    status: "disabled",
  });
  assert.equal(changed.bindingVersion, "2");
  const [row] = await adminQuery<{ status: string }>(
    "SELECT status FROM devices WHERE device_id = $1",
    [device.deviceId],
  );
  assert.equal(row.status, "disabled");
  await assert.rejects(
    setDeviceStatus(db, context(t.tenantId), {
      deviceId: randomUUID(),
      status: "disabled",
    }),
    DeviceNotFoundError,
  );
});

test("pessimistic: a held lock fails fast with NOWAIT and times out otherwise", async () => {
  const device = await registerDevice(db, context(t.tenantId), newDevice());
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = withTenant(db, t.tenantId, async (tx) => {
    assert.ok(await lockDevice(tx, t.tenantId, device.deviceId));
    locked();
    await released;
  });
  await isLocked;
  try {
    await assert.rejects(
      setDeviceStatus(db, context(t.tenantId), {
        deviceId: device.deviceId,
        status: "disabled",
        noWait: true,
      }),
      LockNotAvailableError,
    );
    await assert.rejects(
      setDeviceStatus(
        db,
        context(t.tenantId),
        { deviceId: device.deviceId, status: "disabled" },
        { lockTimeoutMs: 100 },
      ),
      LockNotAvailableError,
    );
    // Options without a lock timeout still get the bounded default.
    const started = Date.now();
    await assert.rejects(
      setDeviceStatus(
        db,
        context(t.tenantId),
        { deviceId: device.deviceId, status: "disabled" },
        { isolationLevel: "ReadCommitted" },
      ),
      LockNotAvailableError,
    );
    assert.ok(Date.now() - started < 10_000);
  } finally {
    release();
    await holder;
  }
  const changed = await setDeviceStatus(db, context(t.tenantId), {
    deviceId: device.deviceId,
    status: "disabled",
    noWait: true,
  });
  assert.equal(changed.bindingVersion, "2");
});

test("receipt, outbox event and audit record share one command ID", async () => {
  const result = await registerDevice(db, context(t.tenantId), newDevice());
  const [ids] = await adminQuery<Record<string, string>>(
    `SELECT (SELECT command_id FROM command_receipts r
              WHERE r.response_body->>'deviceId' = $1::text) AS receipt,
            (SELECT causation_id FROM outbox_events WHERE aggregate_id = $1::uuid) AS event,
            (SELECT command_id FROM audit_events WHERE resource_id = $1::uuid) AS audit`,
    [result.deviceId],
  );
  assert.ok(ids.receipt);
  assert.equal(ids.event, ids.receipt);
  assert.equal(ids.audit, ids.receipt);
});

test("a duplicate bin is reported as a duplicate bin", async () => {
  await assert.rejects(
    createBin(db, t.tenantId, {
      binId: t.binId,
      siteId: t.siteId,
      name: "again",
    }),
    DuplicateBinError,
  );
});

test("device lists are bounded keyset pages", async () => {
  const tenantId = randomUUID();
  const siteId = randomUUID();
  await createTenant(db, tenantId, "paging");
  await createSite(db, tenantId, siteId, "yard");
  for (let i = 0; i < 3; i++)
    await registerDevice(db, context(tenantId), {
      serialNumber: `P-${i}`,
      siteId,
    });
  const all = (
    await listDevices(db, tenantId, { limit: MAX_PAGE_SIZE * 10 })
  ).map((d) => d.deviceId);
  assert.deepEqual(all, [...all].sort());
  assert.equal(all.length, 3);
  const first = await listDevices(db, tenantId, { limit: 2 });
  assert.deepEqual(
    first.map((d) => d.deviceId),
    all.slice(0, 2),
  );
  const next = await listDevices(db, tenantId, {
    limit: 2,
    afterDeviceId: first[1].deviceId,
  });
  assert.deepEqual(
    next.map((d) => d.deviceId),
    all.slice(2),
  );
  assert.equal((await listDevices(db, tenantId, { limit: 0 })).length, 1);
  assert.equal(
    (await listDevices(db, tenantId, { limit: Number.NaN })).length,
    1,
  );
});

test("malformed versions and cursors are rejected as invalid input", async () => {
  for (const expectedVersion of [
    "abc",
    "1.5",
    "0",
    "-1",
    "99999999999999999999",
  ])
    await assert.rejects(
      changeDeviceBinding(db, context(t.tenantId), {
        deviceId: t.deviceId,
        expectedVersion,
        siteId: t.siteId,
        binId: null,
      }),
      InvalidInputError,
    );
  await assert.rejects(
    listDevices(db, t.tenantId, { limit: 10, afterDeviceId: "not-a-uuid" }),
    InvalidInputError,
  );
});
