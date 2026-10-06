import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { lookupMembership } from "./domain/store.js";
import { inScope } from "./db/session.js";
import { seedFromMembershipFile } from "./seed.js";
import { adminQuery, runtimeDb } from "./testing/fixtures.js";

const db = runtimeDb(3);
after(() => db.$disconnect());

const file = readFileSync(
  new URL("../../../infra/oidc/memberships.json", import.meta.url),
  "utf8",
);
const entries = JSON.parse(file) as {
  issuer: string;
  subject: string;
  tenantId: string;
  roles: string[];
}[];

test("the dev Dex memberships seed the store idempotently, keeping existing tenant IDs", async () => {
  await seedFromMembershipFile(db, file);
  for (const entry of entries) {
    await inScope(db, { tenantId: entry.tenantId }, async (tx) => {
      await tx.$executeRaw`UPDATE organizations SET state='active'
        WHERE tenant_id=${entry.tenantId}::uuid AND state='provisioning'`;
    });
  }
  const first = await seedFromMembershipFile(db, file);
  const countEvents = () =>
    adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox_events WHERE tenant_id = ANY($1::uuid[])`,
      [entries.map((e) => e.tenantId)],
    );
  const [before] = await countEvents();
  const second = await seedFromMembershipFile(db, file);
  const [afterRun] = await countEvents();
  assert.equal(afterRun?.n, before?.n);
  assert.equal(second.created, 0);
  assert.ok(first.created + first.existing === entries.length);
  for (const entry of entries)
    assert.deepEqual(await lookupMembership(db, entry.issuer, entry.subject), {
      tenantId: entry.tenantId,
      roles: entry.roles,
      version: "1",
      state: "active",
    });
});

test("a seed entry with a device role or several roles is refused before any write", async () => {
  const bad = (roles: string[]) =>
    JSON.stringify([
      {
        issuer: "https://i",
        subject: "s",
        tenantId: entries[0]!.tenantId,
        roles,
      },
    ]);
  await assert.rejects(
    seedFromMembershipFile(db, bad(["device"])),
    /exactly one human role/,
  );
  await assert.rejects(
    seedFromMembershipFile(db, bad(["viewer", "admin"])),
    /exactly one human role/,
  );
});

test("seed keys split on the first pipe, so Auth0-style subjects survive", async () => {
  const tenantId = randomUUID();
  const issuer = "https://auth0.example.test/";
  const subject = `auth0|${randomUUID()}`;
  const json = JSON.stringify([
    { issuer, subject, tenantId, roles: ["viewer"] },
  ]);
  await seedFromMembershipFile(db, json);
  assert.equal(await lookupMembership(db, issuer, subject), null);
  // A trusted test activation represents completed owner bootstrap. Importing
  // static membership itself must never activate a provisioning tenant.
  await inScope(db, { tenantId }, async (tx) => {
    await tx.$executeRaw`UPDATE organizations SET state='active'
      WHERE tenant_id=${tenantId}::uuid AND state='provisioning'`;
  });
  await seedFromMembershipFile(db, json);
  assert.equal(
    (await lookupMembership(db, issuer, subject))?.tenantId,
    tenantId,
  );
});
