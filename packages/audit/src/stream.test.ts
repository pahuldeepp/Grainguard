import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifySignedAuditExport, type ExportRow } from "./index.js";
import { writeSignedAuditExport } from "./stream.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const keys = generateKeyPairSync("ed25519");
const row = (auditId: string, occurredAt: string): ExportRow => ({
  tenantId,
  auditId,
  occurredAt,
  actorId: "actor",
  action: "member.revoked",
  resourceType: "membership",
  resourceId: "member",
  outcome: "succeeded",
});

async function* rows(...items: ExportRow[]) {
  for (const item of items) yield item;
}

test("large-export writer streams ordered rows and publishes one signed directory", async () => {
  const destinationDirectory = mkdtempSync(
    path.join(tmpdir(), "gg-audit-stream-"),
  );
  try {
    const result = await writeSignedAuditExport({
      tenantId,
      rows: rows(
        row("11111111-1111-4111-8111-111111111111", "2026-09-25T00:00:00Z"),
        row("22222222-2222-4222-8222-222222222222", "2026-09-25T00:00:01Z"),
      ),
      destinationDirectory,
      jobId: "job-1",
      privateKey: keys.privateKey,
      publicKeyId: "test-key",
    });
    const file = await readFile(path.join(result.directory, "audit.jsonl"));
    assert.equal(result.manifest.rowCount, 2);
    assert.equal(
      verifySignedAuditExport({
        file,
        manifest: result.manifest,
        signature: result.signature,
        publicKey: keys.publicKey,
      }),
      true,
    );
    assert.deepEqual(await readdir(destinationDirectory), ["job-1"]);
    assert.equal(
      await readFile(path.join(result.directory, "signature"), "utf8"),
      result.signature,
    );
    const shouldNotBeRead: AsyncIterable<ExportRow> = {
      [Symbol.asyncIterator]() {
        throw new Error("retry consumed source rows");
      },
    };
    const retry = await writeSignedAuditExport({
      tenantId,
      rows: shouldNotBeRead,
      destinationDirectory,
      jobId: "job-1",
      privateKey: keys.privateKey,
      publicKeyId: "test-key",
    });
    assert.equal(retry.directory, result.directory);
    assert.equal(retry.signature, result.signature);
    await writeFile(path.join(result.directory, "audit.jsonl"), "tampered\n");
    await assert.rejects(
      writeSignedAuditExport({
        tenantId,
        rows: shouldNotBeRead,
        destinationDirectory,
        jobId: "job-1",
        privateKey: keys.privateKey,
        publicKeyId: "test-key",
      }),
      /corrupted/,
    );
  } finally {
    await rm(destinationDirectory, { recursive: true, force: true });
  }
});

test("foreign and out-of-order rows fail without publishing partial output", async () => {
  const destinationDirectory = mkdtempSync(
    path.join(tmpdir(), "gg-audit-stream-"),
  );
  try {
    const base = {
      tenantId,
      destinationDirectory,
      privateKey: keys.privateKey,
      publicKeyId: "test-key",
    };
    await assert.rejects(
      writeSignedAuditExport({
        ...base,
        jobId: "foreign",
        rows: rows({
          ...row(
            "11111111-1111-4111-8111-111111111111",
            "2026-09-25T00:00:00Z",
          ),
          tenantId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
      /cross-tenant/,
    );
    await assert.rejects(
      writeSignedAuditExport({
        ...base,
        jobId: "unordered",
        rows: rows(
          row("22222222-2222-4222-8222-222222222222", "2026-09-25T00:00:01Z"),
          row("11111111-1111-4111-8111-111111111111", "2026-09-25T00:00:00Z"),
        ),
      }),
      /keyset order/,
    );
    assert.deepEqual(await readdir(destinationDirectory), []);
    await assert.rejects(
      writeSignedAuditExport({ ...base, jobId: "../unsafe", rows: rows() }),
      /invalid job ID/,
    );
  } finally {
    await rm(destinationDirectory, { recursive: true, force: true });
  }
});
