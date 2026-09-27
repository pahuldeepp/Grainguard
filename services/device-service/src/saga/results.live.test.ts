import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDb, type Db } from "../db/client.js";
import { withTenant } from "../db/tenant.js";
import { applyInventoryCommand, type InventoryResult } from "./inventory.js";
import {
  MAX_RESULTS_PER_TENANT,
  MAX_TENANTS_PER_PASS,
  publishResultsPass,
  rejectTenantList,
} from "./worker.js";

// A command for a device that does not exist is a durable business rejection,
// which leaves one unpublished result row for the tenant.
async function pendingResult(db: Db, tenant: string): Promise<void> {
  await applyInventoryCommand(db, {
    tenant_id: tenant,
    saga_id: randomUUID(),
    command_id: randomUUID(),
    step: "inventory.activate",
    saga_version: 1,
    fencing_token: 1,
    payload: { device_id: randomUUID(), asset_id: randomUUID() },
  });
}

test("retired tenant list is rejected at startup", () => {
  assert.throws(
    () => rejectTenantList({ INVENTORY_SAGA_TENANT_IDS: randomUUID() }),
    /retired/,
  );
  assert.doesNotThrow(() => rejectTenantList({}));
});

test("ID-only tenant discovery is bounded, fair and never crosses tenants", async (t) => {
  const url = process.env.INVENTORY_DATABASE_URL;
  if (!url) {
    t.skip("INVENTORY_DATABASE_URL is required");
    return;
  }
  const db = createDb(url);
  t.after(() => db.$disconnect());
  const ours = Array.from({ length: MAX_TENANTS_PER_PASS + 20 }, () =>
    randomUUID(),
  );
  for (const tenant of ours) await pendingResult(db, tenant);
  // One tenant with more rows than a pass may publish for it.
  const heavy = ours[0] as string;
  for (let i = 0; i < MAX_RESULTS_PER_TENANT + 5; i++)
    await pendingResult(db, heavy);

  const columns = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM inventory_saga_result_tenants(NULL, 1000)`;
  assert.ok(columns.length <= MAX_TENANTS_PER_PASS, "selector batch clamped");
  for (const row of columns)
    assert.deepEqual(
      Object.keys(row),
      ["tenant_id"],
      "selector returns IDs only",
    );
  const unscoped = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM inventory_saga_result_outbox`;
  assert.equal(unscoped[0]?.n, 0n, "runtime role cannot enumerate rows");

  // The shared database may hold other suites' rows; publish only ours while
  // still walking the real selector and cursor.
  const mine = new Set<string>(ours);
  const include = (id: string) => mine.has(id);
  const published: { key: string; result: InventoryResult }[] = [];
  const publish = (key: string, value: string) => {
    published.push({ key, result: JSON.parse(value) as InventoryResult });
    return Promise.resolve();
  };
  const backlog = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM inventory_saga_result_tenants(NULL, 100)`;
  let cursor: string | null = null;
  let passes = 0;
  const reached = new Set<string>();
  while (reached.size < ours.length && passes < 50) {
    cursor = await publishResultsPass(db, cursor, publish, include);
    for (const p of published) reached.add(p.result.tenant_id);
    passes++;
  }
  assert.equal(
    reached.size,
    ours.length,
    `all tenants reached in ${passes} passes`,
  );
  for (const { key, result } of published) {
    assert.ok(mine.has(result.tenant_id));
    assert.equal(key, `${result.tenant_id}:${result.saga_id}`);
  }
  const heavyFirstPass = published.filter((p) => p.result.tenant_id === heavy);
  assert.ok(heavyFirstPass.length >= 1);
  // Rows remaining for the heavy tenant drain on later passes.
  while (passes < 60) {
    cursor = await publishResultsPass(db, cursor, publish, include);
    passes++;
    const left = await withTenant(
      db,
      heavy,
      (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM inventory_saga_result_outbox
        WHERE tenant_id=${heavy}::uuid AND published_at IS NULL`,
    );
    if (left[0]?.n === 0n) break;
  }
  const heavyTotal = published.filter((p) => p.result.tenant_id === heavy);
  assert.equal(heavyTotal.length, MAX_RESULTS_PER_TENANT + 6);
  assert.equal(
    new Set(published.map((p) => p.result.result_id)).size,
    published.length,
    "no result published twice",
  );
  t.diagnostic(
    `tenants=${ours.length} passes=${passes} initial_selector_batch=${backlog[0]?.n}`,
  );
});
