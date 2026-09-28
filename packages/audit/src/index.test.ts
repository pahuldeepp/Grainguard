import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createSignedAuditExport,
  redactAuditRow,
  verifySignedAuditExport,
  type AuditEnvelope,
} from "./index.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const row: AuditEnvelope = {
  auditId: "33333333-3333-4333-8333-333333333333",
  tenantId: tenant,
  occurredAt: "2026-09-25T12:00:00.000Z",
  actorId: "actor-1",
  action: "member.revoked",
  resourceType: "membership",
  resourceId: "member-1",
  outcome: "succeeded",
  email: "Alice@Example.com",
};
const keys = generateKeyPairSync("ed25519");

test("unprivileged audit export pseudonymizes email with a keyed HMAC and never serializes arbitrary payload", () => {
  const input = {
    ...row,
    token: "private-token",
    payload: { secret: "private" },
  };
  const pseudonym = {
    masterKey: "a-master-pseudonym-key-of-at-least-32-bytes!",
  };
  const redacted = redactAuditRow(input, false, pseudonym);
  assert.match(redacted.email ?? "", /^hmac-sha256:v1:[a-f0-9]{64}$/);
  assert.equal(
    redacted.email,
    redactAuditRow({ ...row, email: "alice@example.com" }, false, pseudonym)
      .email,
  );
  const result = createSignedAuditExport({
    tenantId: tenant,
    rows: [redacted],
    privateKey: keys.privateKey,
    publicKeyId: "local-1",
  });
  assert.doesNotMatch(
    result.file.toString(),
    /private-token|Alice@Example.com|private/,
  );
  assert.equal(
    verifySignedAuditExport({ ...result, publicKey: keys.publicKey }),
    true,
  );
  const reorderedManifest = Object.fromEntries(
    Object.entries(result.manifest).reverse(),
  ) as typeof result.manifest;
  assert.equal(
    verifySignedAuditExport({
      ...result,
      manifest: reorderedManifest,
      publicKey: keys.publicKey,
    }),
    true,
  );
  const unsafeRuntimeRow = { ...redacted, token: "secret-token" };
  const bypassedRedaction = createSignedAuditExport({
    tenantId: tenant,
    rows: [unsafeRuntimeRow],
    privateKey: keys.privateKey,
    publicKeyId: "local-1",
  });
  assert.doesNotMatch(bypassedRedaction.file.toString(), /secret-token/);
});

test("tampered file, manifest, signature and cross-tenant rows fail", () => {
  const redacted = redactAuditRow(row, true);
  const result = createSignedAuditExport({
    tenantId: tenant,
    rows: [redacted],
    privateKey: keys.privateKey,
    publicKeyId: "local-1",
  });
  assert.equal(redacted.email, row.email);
  assert.equal(
    verifySignedAuditExport({
      ...result,
      file: Buffer.from(
        result.file.toString().replace("succeeded", "rejected"),
      ),
      publicKey: keys.publicKey,
    }),
    false,
  );
  assert.equal(
    verifySignedAuditExport({
      ...result,
      manifest: { ...result.manifest, rowCount: 2 },
      publicKey: keys.publicKey,
    }),
    false,
  );
  assert.equal(
    verifySignedAuditExport({
      ...result,
      signature: "AAAA",
      publicKey: keys.publicKey,
    }),
    false,
  );
  assert.throws(
    () =>
      createSignedAuditExport({
        tenantId: tenant,
        rows: [{ ...redacted, tenantId: other }],
        privateKey: keys.privateKey,
        publicKeyId: "local-1",
      }),
    /cross-tenant/,
  );
});

test("empty export has a verifiable manifest", () => {
  const result = createSignedAuditExport({
    tenantId: tenant,
    rows: [],
    privateKey: keys.privateKey,
    publicKeyId: "local-1",
  });
  assert.equal(result.manifest.rowCount, 0);
  assert.equal(result.file.length, 0);
  assert.equal(
    verifySignedAuditExport({ ...result, publicKey: keys.publicKey }),
    true,
  );
});
