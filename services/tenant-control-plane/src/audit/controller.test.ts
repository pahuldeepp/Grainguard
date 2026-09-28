import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import { RoleForbiddenError } from "../domain/errors.js";
import { checkToken, signedToken, type AuditOptions } from "./controller.js";

const options: AuditOptions = {
  directory: "/tmp/audit",
  publicKey: generateKeyPairSync("ed25519").publicKey,
  linkSecret: "test-secret-with-at-least-thirty-two-bytes",
};
test("A06 download tokens expire and are bound to tenant, job and actor", () => {
  const tenant = randomUUID(),
    job = randomUUID(),
    actor = randomUUID();
  const valid = signedToken(options, tenant, job, actor, Date.now() + 60_000);
  assert.doesNotThrow(() => checkToken(options, valid, tenant, job, actor));
  assert.throws(
    () => checkToken(options, valid, randomUUID(), job, actor),
    RoleForbiddenError,
  );
  assert.throws(
    () => checkToken(options, valid, tenant, randomUUID(), actor),
    RoleForbiddenError,
  );
  assert.throws(
    () => checkToken(options, valid, tenant, job, randomUUID()),
    RoleForbiddenError,
  );
  assert.throws(
    () => checkToken(options, valid + "x", tenant, job, actor),
    RoleForbiddenError,
  );
  const expired = signedToken(options, tenant, job, actor, Date.now() - 1);
  assert.throws(
    () => checkToken(options, expired, tenant, job, actor),
    RoleForbiddenError,
  );
});
