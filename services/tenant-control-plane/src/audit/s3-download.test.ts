import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExportStorageError,
  exportObject,
  type ExportStorage,
  type StoredObject,
} from "@greenguard/audit";
import { NotFoundError } from "../domain/errors.js";
import { issueExportLinks } from "./s3-download.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const sha = "ab".repeat(32);
const now = Date.parse("2026-09-25T12:00:00Z");
const job = (extra: Record<string, unknown> = {}) => ({
  tenant_id: tenantId,
  job_id: jobId,
  format: "jsonl" as const,
  file_sha256: sha,
  expires_at: new Date(now + 7 * 86_400_000),
  ...extra,
});

function storageWith(stored: (key: string) => StoredObject | null) {
  const presigned: { key: string; ttl: number; filename: string }[] = [];
  const storage: ExportStorage = {
    kind: "s3",
    put: () => Promise.reject(new Error("unused")),
    head: async (key) => stored(key),
    presignGet: async (key, ttl, options) => {
      presigned.push({ key, ttl, filename: options.filename });
      return `https://bucket.example/${key}?sig=${ttl}`;
    },
  };
  return { storage, presigned };
}
const good = (key: string): StoredObject => ({
  key,
  size: 10,
  sha256: sha,
  checksumSha256: sha,
  tenantId,
  jobId,
  encryption: "AES256",
});

test("S3D1 links are issued for export, manifest and signature with the digest", async () => {
  const { storage, presigned } = storageWith(good);
  const links = await issueExportLinks(storage, job(), 300, now);
  assert.equal(links.sha256, sha);
  assert.equal(links.expiresAt, new Date(now + 300_000).toISOString());
  assert.equal(
    links.url,
    `https://bucket.example/${exportObject(tenantId, jobId, "jsonl", "export").key}?sig=300`,
  );
  assert.match(links.manifestUrl, /manifest\.json/);
  assert.match(links.signatureUrl, /\/signature\?/);
  assert.equal(presigned.length, 3);
  assert.deepEqual([...new Set(presigned.map((p) => p.ttl))], [300]);
});

test("S3D2 wrong-tenant or wrong-job object metadata is refused before anything is presigned", async () => {
  for (const drift of [
    { tenantId: otherTenant },
    { jobId: otherTenant },
    { tenantId: null },
  ]) {
    const { storage, presigned } = storageWith((key) => ({
      ...good(key),
      ...drift,
    }));
    await assert.rejects(
      issueExportLinks(storage, job(), 300, now),
      NotFoundError,
    );
    assert.equal(presigned.length, 0);
  }
});

test("S3D3 a missing object, an altered digest or a storage error yield not found", async () => {
  const cases = [() => null, (key: string) => ({ ...good(key), sha256: "00" })];
  for (const stored of cases) {
    const { storage, presigned } = storageWith(stored);
    await assert.rejects(
      issueExportLinks(storage, job(), 300, now),
      NotFoundError,
    );
    assert.equal(presigned.length, 0);
  }
  const failing: ExportStorage = {
    ...storageWith(good).storage,
    head: () => Promise.reject(new ExportStorageError("invalid_key", "x")),
  };
  await assert.rejects(
    issueExportLinks(failing, job(), 300, now),
    NotFoundError,
  );
});

test("S3D4 TTL is the smaller of the configured value, 300 seconds and the export lifetime", async () => {
  const { storage, presigned } = storageWith(good);
  await issueExportLinks(storage, job(), 60, now);
  assert.equal(presigned.at(-1)!.ttl, 60);
  await issueExportLinks(storage, job(), 9999, now);
  assert.equal(presigned.at(-1)!.ttl, 300);
  const links = await issueExportLinks(
    storage,
    job({ expires_at: new Date(now + 45_500) }),
    300,
    now,
  );
  assert.equal(presigned.at(-1)!.ttl, 45);
  assert.equal(links.expiresAt, new Date(now + 45_000).toISOString());
  await assert.rejects(
    issueExportLinks(
      storage,
      job({ expires_at: new Date(now + 500) }),
      300,
      now,
    ),
    NotFoundError,
  );
  await assert.rejects(
    issueExportLinks(storage, job({ expires_at: new Date(now - 1) }), 300, now),
    NotFoundError,
  );
});

test("S3D5 an export whose recorded digest is missing is not downloadable", async () => {
  const { storage, presigned } = storageWith(good);
  await assert.rejects(
    issueExportLinks(storage, job({ file_sha256: null }), 300, now),
    NotFoundError,
  );
  assert.equal(presigned.length, 0);
});
