import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDb } from "../db/client.js";
import { withTenant } from "../db/tenant.js";
import { createTenant } from "../testing/fixtures.js";
import { applyInventoryCommand, type InventoryCommand } from "./inventory.js";

test("inventory saga activation, replay, compensation and tenant isolation", async (t) => {
  const url = process.env.INVENTORY_DATABASE_URL;
  if (!url) {
    t.skip("INVENTORY_DATABASE_URL is required");
    return;
  }
  const db = createDb(url);
  t.after(() => db.$disconnect());
  const ownerUrl = process.env.INVENTORY_MIGRATION_URL;
  if (!ownerUrl) {
    t.skip("INVENTORY_MIGRATION_URL is required to inspect append-only outbox");
    return;
  }
  const owner = createDb(ownerUrl);
  t.after(() => owner.$disconnect());
  const tenant = randomUUID(),
    other = randomUUID();
  const site = randomUUID(),
    device = randomUUID(),
    asset = randomUUID(),
    saga = randomUUID();
  await createTenant(db, tenant, "saga test");
  await withTenant(db, tenant, async (tx) => {
    await tx.$executeRaw`INSERT INTO sites(tenant_id,site_id,name) VALUES(${tenant}::uuid,${site}::uuid,'saga site')`;
    await tx.$executeRaw`INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,asset_id)
      VALUES(${tenant}::uuid,${device}::uuid,${site}::uuid,${`saga-${device}`},'provisioning',${asset}::uuid)`;
  });
  const reserve: InventoryCommand = {
    tenant_id: tenant,
    saga_id: saga,
    command_id: randomUUID(),
    step: "inventory.activate",
    saga_version: 3,
    fencing_token: 1,
    payload: { device_id: device, asset_id: asset },
  };
  const activated = await applyInventoryCommand(db, reserve);
  assert.equal(activated.outcome, "succeeded");
  assert.deepEqual(await applyInventoryCommand(db, reserve), activated);
  await withTenant(db, tenant, async (tx) => {
    const rows = await tx.$queryRaw<
      { status: string; binding_version: bigint }[]
    >`
      SELECT status,binding_version FROM devices WHERE tenant_id=${tenant}::uuid AND device_id=${device}::uuid`;
    assert.deepEqual(rows, [{ status: "active", binding_version: 1n }]);
  });
  await withTenant(owner, tenant, async (tx) => {
    const events = await tx.$queryRaw<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events WHERE tenant_id=${tenant}::uuid AND aggregate_id=${device}::uuid`;
    assert.deepEqual(
      events.map((e) => e.event_type),
      ["device.registered"],
    );
  });
  const wrongTenant = {
    ...reserve,
    tenant_id: other,
    command_id: randomUUID(),
  };
  assert.equal(
    (await applyInventoryCommand(db, wrongTenant)).outcome,
    "rejected",
  );
  const release: InventoryCommand = {
    ...reserve,
    command_id: randomUUID(),
    step: "inventory.deactivate",
    saga_version: 5,
  };
  const deactivated = await applyInventoryCommand(db, release);
  assert.equal(deactivated.outcome, "succeeded");
  assert.deepEqual(await applyInventoryCommand(db, release), deactivated);
  await withTenant(db, tenant, async (tx) => {
    const rows = await tx.$queryRaw<
      { status: string; binding_version: bigint }[]
    >`
      SELECT status,binding_version FROM devices WHERE tenant_id=${tenant}::uuid AND device_id=${device}::uuid`;
    assert.deepEqual(rows, [{ status: "disabled", binding_version: 2n }]);
  });
  await withTenant(owner, tenant, async (tx) => {
    const events = await tx.$queryRaw<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events WHERE tenant_id=${tenant}::uuid AND aggregate_id=${device}::uuid
      ORDER BY aggregate_version`;
    assert.deepEqual(
      events.map((e) => e.event_type),
      ["device.registered", "device.status_changed"],
    );
  });
});

test("deadline deactivation of a never-activated device is a no-op success", async (t) => {
  const url = process.env.INVENTORY_DATABASE_URL;
  if (!url) {
    t.skip("INVENTORY_DATABASE_URL is required");
    return;
  }
  const db = createDb(url);
  t.after(() => db.$disconnect());
  const tenant = randomUUID(),
    site = randomUUID(),
    device = randomUUID(),
    asset = randomUUID();
  await createTenant(db, tenant, "saga timeout");
  await withTenant(db, tenant, async (tx) => {
    await tx.$executeRaw`INSERT INTO sites(tenant_id,site_id,name) VALUES(${tenant}::uuid,${site}::uuid,'s')`;
    await tx.$executeRaw`INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,asset_id)
      VALUES(${tenant}::uuid,${device}::uuid,${site}::uuid,${`timeout-${device}`},'provisioning',${asset}::uuid)`;
  });
  const undo: InventoryCommand = {
    tenant_id: tenant,
    saga_id: randomUUID(),
    command_id: randomUUID(),
    step: "inventory.deactivate",
    saga_version: 4,
    fencing_token: 1,
    payload: { device_id: device, asset_id: asset },
  };
  assert.equal((await applyInventoryCommand(db, undo)).outcome, "succeeded");
  await withTenant(db, tenant, async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM devices WHERE tenant_id=${tenant}::uuid AND device_id=${device}::uuid`;
    assert.deepEqual(rows, [{ status: "provisioning" }]);
  });
});
