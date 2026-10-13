import { fixtureDb } from "../testing/fixtures.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import kafkaJs from "kafkajs";
import type { DomainEvent } from "@greenguard/contracts";
import { withTenant } from "../db/tenant.js";
import {
  applyTenantEvent,
  decodeTenantEvent,
  InvalidTenantProjectionEvent,
  startTenantProjector,
  serveTenantProjectorHealth,
  TenantProjectorHealth,
  TENANT_TOPIC,
} from "./worker.js";

const { Kafka, logLevel } = kafkaJs;

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
function event(tenant: string = randomUUID(), version = "1"): DomainEvent {
  return {
    event_id: randomUUID(),
    event_type: "tenant.created",
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    tenant_id: tenant,
    aggregate_type: "organization",
    aggregate_id: tenant,
    aggregate_version: version,
    correlation_id: randomUUID(),
    causation_id: randomUUID(),
    traceparent,
    payload: {
      tenant_id: tenant,
      organization_version: version,
      name: "North grain",
      state: "active",
      home_region: "local",
    },
  };
}
const key = (e: DomainEvent) => Buffer.from(`${e.tenant_id}:${e.aggregate_id}`);

test("M10 tenant projector probes become ready after Kafka assignment and stay ready while idle", async (t) => {
  const health = new TenantProjectorHealth();
  const server = serveTenantProjectorHealth(health, 0);
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);

  health.setAssigned(true);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  // No event is required: an assigned Kafka consumer may legitimately be idle.
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  health.setAssigned(false);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
});

test("M10 tenant event decoder accepts canonical key and rejects forged identity", () => {
  const e = event();
  assert.deepEqual(
    decodeTenantEvent(Buffer.from(JSON.stringify(e)), key(e)),
    e,
  );
  assert.throws(
    () =>
      decodeTenantEvent(
        Buffer.from(JSON.stringify(e)),
        Buffer.from(randomUUID()),
      ),
    InvalidTenantProjectionEvent,
  );
  assert.throws(
    () =>
      decodeTenantEvent(
        Buffer.from(
          JSON.stringify({
            ...e,
            payload: { ...e.payload, tenant_id: randomUUID() },
          }),
        ),
        key(e),
      ),
    InvalidTenantProjectionEvent,
  );
  assert.equal(
    decodeTenantEvent(
      Buffer.from(JSON.stringify({ event_type: "membership.changed" })),
      null,
    ),
    null,
  );
});

test("M10 live tenant projection converges under duplicate/reordered delivery; app cannot write", async (t) => {
  const projectorUrl = process.env.INVENTORY_PROJECTOR_DIRECT_URL;
  const appUrl = process.env.INVENTORY_DATABASE_URL;
  if (!projectorUrl || !appUrl) {
    t.skip("inventory projector and app DB URLs required");
    return;
  }
  const projector = fixtureDb(projectorUrl);
  const app = fixtureDb(appUrl);
  t.after(async () => {
    await projector.$disconnect();
    await app.$disconnect();
  });
  const v1 = event();
  const v2 = event(v1.tenant_id, "2");
  v2.payload.name = "Updated grain";
  assert.equal(await applyTenantEvent(projector, v1), true);
  assert.equal(await applyTenantEvent(projector, v1), false);
  assert.equal(await applyTenantEvent(projector, v2), true);
  assert.equal(await applyTenantEvent(projector, v1), false);
  const row = await withTenant(app, v1.tenant_id, (tx) =>
    tx.tenant.findUnique({ where: { tenantId: v1.tenant_id } }),
  );
  assert.equal(row?.name, "Updated grain");
  assert.equal(row?.version, 2n);
  await assert.rejects(
    withTenant(app, randomUUID(), (tx) =>
      tx.tenant.create({ data: { tenantId: randomUUID(), name: "forged" } }),
    ),
  );
  const otherTenant = event();
  assert.equal(await applyTenantEvent(projector, otherTenant), true);
  const hidden = await withTenant(app, v1.tenant_id, (tx) =>
    tx.tenant.findUnique({ where: { tenantId: otherTenant.tenant_id } }),
  );
  assert.equal(hidden, null);
});

test("M10 opt-in canonical Kafka tenant event survives projector restart and redelivery", async (t) => {
  if (process.env.INVENTORY_TENANT_KAFKA_LIVE !== "1") {
    t.skip("INVENTORY_TENANT_KAFKA_LIVE=1 enables the broker test");
    return;
  }
  const url = process.env.INVENTORY_PROJECTOR_DIRECT_URL;
  const broker = process.env.KAFKA_BROKERS;
  if (!url || !broker) {
    t.skip("projector DB and Kafka are required");
    return;
  }
  const db = fixtureDb(url);
  const kafka = new Kafka({
    clientId: `inventory-tenant-live-${randomUUID()}`,
    brokers: [broker],
    logLevel: logLevel.ERROR,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  t.after(async () => {
    await producer.disconnect();
    await db.$disconnect();
  });
  const group = `inventory-tenant-live-${randomUUID()}`;
  const e = event();
  let fatal: Error | undefined;
  const start = () =>
    startTenantProjector(db, [broker], group, (error) => {
      fatal = error;
    });
  let stop = await start();
  const publish = (value: DomainEvent) =>
    producer.send({
      topic: TENANT_TOPIC,
      acks: -1,
      messages: [{ key: key(value), value: JSON.stringify(value) }],
    });
  const waitFor = async (expected: bigint) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fatal) throw fatal;
      const row = await withTenant(db, e.tenant_id, (tx) =>
        tx.tenant.findUnique({ where: { tenantId: e.tenant_id } }),
      );
      if (row?.version === expected) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`tenant projection did not reach version ${expected}`);
  };
  try {
    await publish(e);
    assert.equal((await waitFor(1n)).name, "North grain");
    await stop();
    stop = await start();
    const next = event(e.tenant_id, "2");
    next.payload.name = "After restart";
    await publish(e);
    await publish(next);
    assert.equal((await waitFor(2n)).name, "After restart");
  } finally {
    await stop();
  }
});
