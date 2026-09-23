import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "./client.js";
import { InvalidTenantError, postgresCode } from "./errors.js";
import { assertTenantId, withTenant } from "./tenant.js";
import {
  env,
  pooledDb,
  seedTenant,
  type TenantFixture,
} from "../testing/fixtures.js";

test("tenant IDs must be lowercase, non-nil UUIDs", () => {
  assert.doesNotThrow(() => assertTenantId(randomUUID()));
  for (const bad of [
    "",
    "not-a-uuid",
    randomUUID().toUpperCase(),
    "00000000-0000-0000-0000-000000000000",
    "' OR 1=1 --",
  ])
    assert.throws(() => assertTenantId(bad), InvalidTenantError);
});

test("postgresCode only reads the driver adapter SQLSTATE", () => {
  assert.equal(postgresCode(undefined), undefined);
  assert.equal(postgresCode({ code: "P2002" }), undefined);
  assert.equal(
    postgresCode({
      meta: { driverAdapterError: { cause: { originalCode: 23505 } } },
    }),
    undefined,
  );
  assert.equal(
    postgresCode({
      meta: { driverAdapterError: { cause: { originalCode: "23505" } } },
    }),
    "23505",
  );
});

test("an invalid tenant is rejected before any database call", async () => {
  await assert.rejects(
    withTenant({} as Db, "tenant-a", async () => 1),
    InvalidTenantError,
  );
});

// D03 runs over one direct session (same backend proven by its PID) and over
// PgBouncer transaction pooling, where the server connection is shared.
const connections: [string, () => Db][] = [
  ["direct session", () => createDb(env("INVENTORY_DIRECT_URL"), 1)],
  ["PgBouncer", () => pooledDb(1)],
];

for (const [label, connect] of connections) {
  describe(`D03 over ${label}`, () => {
    let db: Db;
    let a: TenantFixture;
    let b: TenantFixture;
    before(async () => {
      db = connect();
      [a, b] = [await seedTenant(db), await seedTenant(db)];
    });
    after(() => db.$disconnect());

    const unscopedDevices = () =>
      db.device.findMany({ select: { tenantId: true } });
    const backendPid = async () =>
      (await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
        .pid;

    test("tenant context ends with its transaction on a reused connection", async () => {
      const pid = await backendPid();
      const scoped = await withTenant(db, a.tenantId, (tx) =>
        tx.device.findMany(),
      );
      assert.deepEqual(
        scoped.map((d) => d.tenantId),
        [a.tenantId],
      );
      assert.deepEqual(await unscopedDevices(), []);
      const [{ tenant }] = await db.$queryRaw<{ tenant: string | null }[]>`
        SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant`;
      assert.equal(tenant, null);
      if (label === "direct session") assert.equal(await backendPid(), pid);
    });

    test("a failed transaction does not leave its tenant context behind", async () => {
      await assert.rejects(
        withTenant(db, a.tenantId, async (tx) => {
          await tx.device.findMany();
          throw new Error("handler failed");
        }),
        /handler failed/,
      );
      assert.deepEqual(await unscopedDevices(), []);
    });

    test("alternating tenants only ever see their own rows", async () => {
      const pids = new Set<number>();
      for (let i = 0; i < 10; i++) {
        const tenant = i % 2 === 0 ? a : b;
        const rows = await withTenant(db, tenant.tenantId, async (tx) => {
          pids.add(
            (
              await tx.$queryRaw<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            )[0].pid,
          );
          return tx.device.findMany({ select: { tenantId: true } });
        });
        assert.deepEqual(
          new Set(rows.map((r) => r.tenantId)),
          new Set([tenant.tenantId]),
        );
      }
      if (label === "direct session") assert.equal(pids.size, 1);
    });
  });
}
