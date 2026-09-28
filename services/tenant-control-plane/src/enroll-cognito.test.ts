import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { lookupMembership } from "./domain/store.js";
import {
  enrollFirstCognitoAdmin,
  validateCognitoEnrollment,
} from "./enroll-cognito.js";
import { main } from "./enroll-cognito-cli.js";
import { runtimeDb } from "./testing/fixtures.js";

const db = runtimeDb(2);
after(() => db.$disconnect());

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Abc123";
const input = () => ({
  issuer,
  subject: randomUUID(),
  tenantId: randomUUID(),
  role: "admin" as const,
});

test("initial Cognito admin enrollment creates one active membership and replays exactly", async () => {
  const entry = input();
  assert.equal(await enrollFirstCognitoAdmin(db, entry), "created");
  assert.equal(await enrollFirstCognitoAdmin(db, entry), "existing");
  assert.deepEqual(await lookupMembership(db, entry.issuer, entry.subject), {
    tenantId: entry.tenantId,
    roles: ["admin"],
    version: "1",
    state: "active",
  });
  await assert.rejects(
    enrollFirstCognitoAdmin(db, { ...entry, subject: randomUUID() }),
    /tenant already exists/,
  );
});

test("input validation rejects forged issuer, invalid subject, non-admin roles and missing confirmation", async () => {
  const entry = input();
  assert.deepEqual(validateCognitoEnrollment(entry), entry);
  assert.throws(
    () =>
      validateCognitoEnrollment({ ...entry, issuer: "https://example.com" }),
    /issuer/,
  );
  assert.throws(
    () => validateCognitoEnrollment({ ...entry, subject: "alice" }),
    /sub/,
  );
  assert.throws(
    () => validateCognitoEnrollment({ ...entry, role: "viewer" }),
    /admin/,
  );
  await assert.rejects(
    main({
      ...{
        ENROLL_ISSUER: issuer,
        ENROLL_SUBJECT: entry.subject,
        ENROLL_TENANT_ID: entry.tenantId,
        ENROLL_ROLE: "admin",
        CONTROL_DIRECT_URL: "postgresql://invalid",
      },
    }),
    /ENROLL_CONFIRM/,
  );
});
