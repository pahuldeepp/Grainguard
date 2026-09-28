import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { lookupMembership } from "./domain/store.js";
import {
  enrollFirstAdmin,
  validateFirstAdminEnrollment,
} from "./enroll-first-admin.js";
import { runtimeDb } from "./testing/fixtures.js";

const db = runtimeDb(2);
after(() => db.$disconnect());

const issuer = "https://id.example.test/";
const input = () => ({
  issuer,
  subject: randomUUID(),
  tenantId: randomUUID(),
  role: "admin" as const,
});

test("initial OIDC admin enrollment accepts opaque external sub and replays exactly", async () => {
  const entry = { ...input(), subject: `auth0|operator-${randomUUID()}` };
  assert.equal(await enrollFirstAdmin(db, entry), "created");
  assert.equal(await enrollFirstAdmin(db, entry), "existing");
  assert.deepEqual(await lookupMembership(db, entry.issuer, entry.subject), {
    tenantId: entry.tenantId,
    roles: ["admin"],
    version: "1",
    state: "active",
  });
  await assert.rejects(
    enrollFirstAdmin(db, { ...entry, subject: "another-user" }),
    /tenant already exists/,
  );
});

test("input validation rejects invalid issuer, opaque-sub controls and non-admin roles", async () => {
  const entry = input();
  assert.deepEqual(validateFirstAdminEnrollment(entry), entry);
  assert.throws(
    () =>
      validateFirstAdminEnrollment({
        ...entry,
        issuer: "http://id.example.test",
      }),
    /issuer/,
  );
  assert.throws(
    () => validateFirstAdminEnrollment({ ...entry, subject: "alice\nadmin" }),
    /sub/,
  );
  assert.throws(
    () => validateFirstAdminEnrollment({ ...entry, role: "viewer" }),
    /admin/,
  );
});
