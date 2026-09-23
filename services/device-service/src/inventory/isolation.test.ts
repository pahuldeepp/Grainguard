import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { postgresCode } from "../db/errors.js";
import { withTenant } from "../db/tenant.js";
import {
  adminQuery,
  appQuery,
  context,
  pooledDb,
  seedTenant,
  type TenantFixture,
} from "../testing/fixtures.js";
import { DeviceNotFoundError, InvalidReferenceError } from "./errors.js";
import {
  changeDeviceBinding,
  createBin,
  getDevice,
  listDevices,
  registerDevice,
  setDeviceStatus,
} from "./repository.js";

const TABLES = [
  "audit_events",
  "bins",
  "command_receipts",
  "devices",
  "outbox_events",
  "sites",
  "tenants",
];

let db: Db;
let a: TenantFixture;
let b: TenantFixture;
before(async () => {
  db = pooledDb();
  [a, b] = [await seedTenant(db), await seedTenant(db)];
});
after(() => db.$disconnect());

const rejectsWithCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error) => postgresCode(error) === code);

test("D02: runtime role cannot bypass RLS and owns no tables", async () => {
  const [role] = await adminQuery<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'inventory_app'",
  );
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const tables = await adminQuery<{
    relname: string;
    owner: string;
    forced: boolean;
  }>(
    `SELECT relname, pg_get_userbyid(relowner) AS owner,
            relrowsecurity AND relforcerowsecurity AS forced
       FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname <> '_prisma_migrations'
      ORDER BY relname`,
  );
  assert.deepEqual(
    tables,
    TABLES.map((relname) => ({
      relname,
      owner: "inventory_migrator",
      forced: true,
    })),
  );
});

test("D02: without a tenant context the runtime role sees no rows", async () => {
  for (const table of [
    "tenants",
    "sites",
    "bins",
    "devices",
    "command_receipts",
  ]) {
    const [{ count }] = await appQuery<{ count: string }>(
      `SELECT count(*) FROM ${table}`,
    );
    assert.equal(count, "0", table);
  }
});

test("D02: tenant B cannot read tenant A", async () => {
  const visible = await listDevices(db, b.tenantId, { limit: 100 });
  assert.deepEqual(
    visible.map((d) => d.deviceId),
    [b.deviceId],
  );
  assert.equal(await getDevice(db, b.tenantId, a.deviceId), null);
  const sites = await withTenant(db, b.tenantId, (tx) =>
    tx.site.findMany({ where: { siteId: a.siteId } }),
  );
  assert.deepEqual(sites, []);
});

test("D02: tenant B cannot insert rows for tenant A", async () => {
  await rejectsWithCode(
    withTenant(db, b.tenantId, (tx) =>
      tx.device.create({
        data: {
          tenantId: a.tenantId,
          deviceId: randomUUID(),
          siteId: a.siteId,
          serialNumber: "forged",
          status: "active",
        },
      }),
    ),
    "42501",
  );
});

test("D02: tenant B cannot change tenant A's devices", async () => {
  const { count } = await withTenant(db, b.tenantId, (tx) =>
    tx.device.updateMany({
      where: { deviceId: a.deviceId },
      data: { status: "disabled" },
    }),
  );
  assert.equal(count, 0);
  const ctx = context(b.tenantId);
  await assert.rejects(
    changeDeviceBinding(db, ctx, {
      deviceId: a.deviceId,
      expectedVersion: "1",
      siteId: b.siteId,
      binId: null,
    }),
    DeviceNotFoundError,
  );
  await assert.rejects(
    setDeviceStatus(db, ctx, { deviceId: a.deviceId, status: "disabled" }),
    DeviceNotFoundError,
  );
  const [device] = await adminQuery<{ status: string }>(
    "SELECT status FROM devices WHERE device_id = $1",
    [a.deviceId],
  );
  assert.equal(device.status, "active");
});

test("D02: tenant B cannot reference tenant A's site or bin", async () => {
  await assert.rejects(
    registerDevice(db, context(b.tenantId), {
      serialNumber: "cross-tenant",
      siteId: a.siteId,
    }),
    InvalidReferenceError,
  );
  await assert.rejects(
    createBin(db, b.tenantId, {
      binId: randomUUID(),
      siteId: a.siteId,
      name: "x",
    }),
    InvalidReferenceError,
  );
});

test("a device's bin must belong to the device's site", async () => {
  await assert.rejects(
    registerDevice(db, context(a.tenantId), {
      serialNumber: `SN-${randomUUID()}`,
      siteId: a.otherSiteId,
      binId: a.binId,
    }),
    InvalidReferenceError,
  );
});

test("runtime role cannot delete, rewrite identity, or touch history", async () => {
  const run = (sql: string) =>
    withTenant(db, a.tenantId, (tx) => tx.$executeRawUnsafe(sql));
  await rejectsWithCode(run("DELETE FROM devices"), "42501");
  await rejectsWithCode(
    run(`UPDATE devices SET tenant_id = '${b.tenantId}'`),
    "42501",
  );
  await rejectsWithCode(
    run("UPDATE outbox_events SET payload = '{}'"),
    "42501",
  );
  await rejectsWithCode(
    run("UPDATE audit_events SET outcome = 'rejected'"),
    "42501",
  );
  await rejectsWithCode(
    withTenant(db, a.tenantId, (tx) =>
      tx.$queryRawUnsafe("SELECT * FROM outbox_events"),
    ),
    "42501",
  );
});
