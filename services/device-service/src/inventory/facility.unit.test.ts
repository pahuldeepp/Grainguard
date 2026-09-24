import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import type { Tx } from "../db/tenant.js";
import { context } from "../testing/fixtures.js";
import { createBin, createSite } from "./repository.js";
import { IdempotencyConflictError } from "./errors.js";

function database() {
  const writes: { table: string; data: Record<string, unknown> }[] = [];
  let receipt: Record<string, unknown> | null = null;
  const record =
    (table: string) =>
    async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ table, data });
      return data;
    };
  const tx = {
    $executeRaw: async () => 1,
    site: { create: record("site") },
    bin: { create: record("bin") },
    outboxEvent: { createMany: record("outbox") },
    auditEvent: { createMany: record("audit") },
    commandReceipt: {
      findUnique: async () => receipt,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        receipt = data;
        return data;
      },
    },
  };
  const db = {
    $transaction: async (run: (value: Tx) => Promise<unknown>) =>
      run(tx as unknown as Tx),
  } as unknown as Db;
  return { db, writes, tx };
}

for (const kind of ["site", "bin"] as const) {
  test(`H6 unit: ${kind} uses one tenant transaction and replays original result`, async () => {
    const { db, writes } = database();
    const ctx = context(randomUUID());
    const id = randomUUID();
    const siteId = randomUUID();
    const create = (name: string) =>
      kind === "site"
        ? createSite(db, ctx, id, name)
        : createBin(db, ctx, { binId: id, siteId, name });
    const first = await create("test");
    assert.deepEqual(await create("test"), first);
    await assert.rejects(create("changed"), IdempotencyConflictError);
    assert.deepEqual(
      writes.map((value) => value.table),
      [kind, "outbox", "audit"],
    );
    assert.equal(writes[0].data.tenantId, ctx.tenantId);
    const event = (writes[1].data as unknown as Record<string, unknown>[])[0];
    assert.equal(event.aggregateType, kind);
    assert.equal(event.aggregateId, id);
    assert.equal(event.aggregateVersion, 1n);
    assert.equal(event.eventId, first.eventId);
    assert.equal(event.correlationId, ctx.correlationId);
    assert.equal(event.traceparent, ctx.traceparent);
    assert.equal(event.tenantId, ctx.tenantId);
    assert.deepEqual(
      event.payload,
      kind === "site"
        ? { site_id: id, name: "test", site_version: "1" }
        : { bin_id: id, site_id: siteId, name: "test", bin_version: "1" },
    );
  });

  test(`H6 unit: failed ${kind} write never attempts outbox insertion`, async () => {
    const { db, writes, tx } = database();
    const failure = new Error("write failed");
    tx[kind].create = async () => {
      throw failure;
    };
    const ctx = context(randomUUID());
    await assert.rejects(
      kind === "site"
        ? createSite(db, ctx, randomUUID(), "test")
        : createBin(db, ctx, {
            binId: randomUUID(),
            siteId: randomUUID(),
            name: "test",
          }),
      failure,
    );
    assert.deepEqual(writes, []);
  });
}
