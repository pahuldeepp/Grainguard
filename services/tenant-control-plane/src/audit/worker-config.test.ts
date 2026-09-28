import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { auditWorkerIdentityFromEnv } from "./worker.js";

const pair = () => generateKeyPairSync("ed25519");
const pem = (value: string | Buffer) => value.toString();

test("audit worker accepts a matching Ed25519 signing identity", () => {
  const keys = pair();
  const identity = auditWorkerIdentityFromEnv({
    AUDIT_EXPORT_PRIVATE_KEY_PEM: pem(
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    ),
    AUDIT_EXPORT_PUBLIC_KEY_PEM: pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    ),
    AUDIT_EXPORT_PUBLIC_KEY_ID: "audit-key-v1",
  });
  assert.equal(identity.privateKey.asymmetricKeyType, "ed25519");
  assert.equal(identity.publicKeyId, "audit-key-v1");
});

test("audit worker rejects mismatched signing keys and invalid identities", () => {
  const privatePair = pair();
  const otherPair = pair();
  const valid = {
    AUDIT_EXPORT_PRIVATE_KEY_PEM: pem(
      privatePair.privateKey.export({ type: "pkcs8", format: "pem" }),
    ),
    AUDIT_EXPORT_PUBLIC_KEY_PEM: pem(
      privatePair.publicKey.export({ type: "spki", format: "pem" }),
    ),
    AUDIT_EXPORT_PUBLIC_KEY_ID: "audit-key-v1",
  };
  assert.throws(
    () =>
      auditWorkerIdentityFromEnv({
        ...valid,
        AUDIT_EXPORT_PUBLIC_KEY_PEM: pem(
          otherPair.publicKey.export({ type: "spki", format: "pem" }),
        ),
      }),
    /key pair does not match/,
  );
  assert.throws(
    () =>
      auditWorkerIdentityFromEnv({
        ...valid,
        AUDIT_EXPORT_PUBLIC_KEY_ID: "bad key",
      }),
    /identity is incomplete/,
  );
  assert.throws(
    () =>
      auditWorkerIdentityFromEnv({
        ...valid,
        AUDIT_EXPORT_PRIVATE_KEY_PEM: undefined,
      }),
    /identity is incomplete/,
  );
  assert.throws(
    () =>
      auditWorkerIdentityFromEnv({
        ...valid,
        AUDIT_EXPORT_PRIVATE_KEY_PEM: "not a PEM secret",
      }),
    /identity is invalid/,
  );
});
