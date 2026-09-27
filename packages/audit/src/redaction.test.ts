import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveTenantPseudonymKey,
  encodeCsvRow,
  redactAuditRow,
  verifySignedAuditExport,
  writeSignedAuditExport,
  type ExportRow,
} from "./index.js";
import { verifyFiles } from "./verify-cli.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const master = "a-master-pseudonym-key-of-at-least-32-bytes!";
const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  auditId: "a1",
  tenantId: tenantA,
  occurredAt: "2026-09-25T00:00:00Z",
  actorId: "actor",
  action: "member.revoked",
  resourceType: "membership",
  resourceId: "m",
  outcome: "succeeded",
  email: "Alice@Example.com",
  ...over,
});

test("R01 non-privileged email pseudonyms are per-tenant keyed HMACs, not bare SHA-256", () => {
  const pseudonym = { masterKey: master };
  const a = redactAuditRow(row(), false, pseudonym).email!;
  assert.match(a, /^hmac-sha256:v1:[a-f0-9]{64}$/);
  assert.notEqual(
    a.split(":")[2],
    createHash("sha256").update("alice@example.com").digest("hex"),
  );
  assert.equal(
    redactAuditRow(row({ email: " alice@example.COM " }), false, pseudonym)
      .email,
    a,
  );
  assert.notEqual(
    redactAuditRow(row({ tenantId: tenantB }), false, pseudonym).email,
    a,
  );
  assert.notEqual(
    redactAuditRow(row(), false, { masterKey: `${master}-other` }).email,
    a,
  );
  assert.match(
    redactAuditRow(row(), false, { masterKey: master, keyId: "v2" }).email!,
    /^hmac-sha256:v2:/,
  );
  assert.equal(deriveTenantPseudonymKey(master, tenantA).length, 32);
  assert.notDeepEqual(
    deriveTenantPseudonymKey(master, tenantA),
    deriveTenantPseudonymKey(master, tenantB),
  );
});

test("R02 pseudonymizing without a strong key fails closed; privileged rows need no key", () => {
  assert.throws(() => redactAuditRow(row(), false), /pseudonym/);
  assert.throws(
    () => redactAuditRow(row(), false, { masterKey: "short" }),
    /at least 32 bytes/,
  );
  assert.throws(
    () => redactAuditRow(row(), false, { masterKey: master, keyId: "bad id" }),
    /key ID/,
  );
  assert.equal(redactAuditRow(row(), true).email, "Alice@Example.com");
  assert.equal(
    redactAuditRow(row({ email: undefined }), false).email,
    undefined,
  );
});

test("R03 CSV cells that could run as spreadsheet formulas are neutralized inside the quotes", () => {
  const cell = (actorId: string) =>
    encodeCsvRow(row({ actorId })).split(",")[3];
  for (const dangerous of ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tcmd"])
    assert.equal(cell(dangerous), `"'${dangerous}"`, dangerous);
  assert.equal(cell("plain"), '"plain"');
  assert.equal(cell("a=b"), '"a=b"');
  assert.equal(cell('say "hi"'), '"say ""hi"""');
  assert.equal(cell("'=already"), `"'=already"`);
  assert.throws(() => encodeCsvRow(row({ actorId: "=1\n2" })), /newline/);
});

test("R04 a CSV export with formula-like cells still verifies through the library and the CLI", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-redaction-"));
  try {
    const keys = generateKeyPairSync("ed25519");
    async function* rows() {
      yield row({
        auditId: "a1",
        actorId: '=HYPERLINK("http://evil")',
        email: undefined,
      });
      yield row({
        auditId: "a2",
        occurredAt: "2026-09-25T00:00:01Z",
        actorId: "@SUM(1)",
        email: undefined,
      });
    }
    const result = await writeSignedAuditExport({
      tenantId: tenantA,
      jobId: "job-r04",
      rows: rows(),
      format: "csv",
      destinationDirectory: dir,
      privateKey: keys.privateKey,
      publicKeyId: "k",
    });
    const file = await readFile(path.join(result.directory, "audit.csv"));
    assert.match(file.toString(), /"'=HYPERLINK\(""http:\/\/evil""\)"/);
    assert.match(file.toString(), /"'@SUM\(1\)"/);
    assert.equal(
      verifySignedAuditExport({
        file,
        manifest: result.manifest,
        signature: result.signature,
        publicKey: keys.publicKey,
      }),
      true,
    );
    const pem = path.join(dir, "public.pem");
    await writeFile(
      pem,
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    assert.equal(
      verifyFiles([
        path.join(result.directory, "audit.csv"),
        path.join(result.directory, "manifest.json"),
        path.join(result.directory, "signature"),
        pem,
      ]),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
