import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pooledDb, createTenant } from "../testing/fixtures.js";
import { withTenant } from "./tenant.js";
const db = pooledDb();
after(() => db.$disconnect());
test("ENT-10 tenant transaction cancels a synthetic slow statement", async () => {
  const tenant = randomUUID();
  await createTenant(db, tenant, "timeout-test");
  await assert.rejects(
    withTenant(
      db,
      tenant,
      async (tx) => {
        await tx.$queryRaw`SELECT pg_sleep(0.2)`;
      },
      { statementTimeoutMs: 50 },
    ),
    (error) =>
      String(error).includes("57014") ||
      String(error).includes("statement timeout"),
  );
});
