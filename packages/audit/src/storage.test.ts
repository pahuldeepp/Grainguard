import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  ExportStorageError,
  MAX_PRESIGN_TTL_SECONDS,
  S3ExportStorage,
  assertStoredMatches,
  exportObject,
  type PutMeta,
} from "./storage.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenant = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const otherJob = "44444444-4444-4444-8444-444444444444";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type Sent = { name: string; input: Record<string, unknown> };
type Handler = (sent: Sent) => unknown;

function fakeClient(handler: Handler) {
  const calls: Sent[] = [];
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test-access", secretAccessKey: "test-secret" },
  });
  (client as unknown as { send: (command: unknown) => Promise<unknown> }).send =
    async (command) => {
      const c = command as {
        constructor: { name: string };
        input: Record<string, unknown>;
      };
      const sent = { name: c.constructor.name, input: c.input };
      calls.push(sent);
      return handler(sent);
    };
  return { client, calls };
}

async function withFile<T>(content: string, run: (file: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-storage-"));
  try {
    const file = path.join(dir, "object.bin");
    await writeFile(file, content);
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const meta = (extra: Partial<PutMeta> = {}): PutMeta => ({
  tenantId,
  jobId,
  contentType: "application/x-ndjson",
  filename: `audit-${jobId}.jsonl`,
  ...extra,
});

test("S09 keys follow tenants/<tenant>/audit-exports/<job>/<file> and reject non-UUIDs", () => {
  const object = exportObject(tenantId, jobId, "jsonl", "export");
  assert.equal(
    object.key,
    `tenants/${tenantId}/audit-exports/${jobId}/audit.jsonl`,
  );
  assert.equal(object.filename, `audit-${jobId}.jsonl`);
  assert.equal(object.contentType, "application/x-ndjson");
  assert.equal(
    exportObject(tenantId, jobId, "csv", "export").contentType,
    "text/csv",
  );
  assert.equal(
    exportObject(tenantId, jobId, "csv", "manifest").key.endsWith(
      "/manifest.json",
    ),
    true,
  );
  assert.equal(
    exportObject(tenantId, jobId, "csv", "signature").key.endsWith(
      "/signature",
    ),
    true,
  );
  for (const bad of ["../x", "job-1", `${tenantId}/../${otherTenant}`, ""]) {
    assert.throws(
      () => exportObject(bad, jobId, "jsonl", "export"),
      ExportStorageError,
    );
    assert.throws(
      () => exportObject(tenantId, bad, "jsonl", "export"),
      ExportStorageError,
    );
  }
});

test("S01 put sends SSE-S3, content headers, tenant metadata and a SHA-256 checksum", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const storage = new S3ExportStorage({ client, bucket: "audit-bucket" });
  const key = exportObject(tenantId, jobId, "jsonl", "export").key;
  const body = "row-1\nrow-2\n";
  await withFile(body, (file) => storage.put(key, { path: file }, meta()));
  assert.equal(calls.length, 1);
  const put = calls[0]!;
  assert.equal(put.name, PutObjectCommand.name);
  assert.equal(put.input.Bucket, "audit-bucket");
  assert.equal(put.input.Key, key);
  assert.equal(put.input.ServerSideEncryption, "AES256");
  assert.equal(put.input.SSEKMSKeyId, undefined);
  assert.equal(put.input.ContentType, "application/x-ndjson");
  assert.equal(
    put.input.ContentDisposition,
    `attachment; filename="audit-${jobId}.jsonl"`,
  );
  assert.equal(
    put.input.ChecksumSHA256,
    createHash("sha256").update(body).digest("base64"),
  );
  assert.deepEqual(put.input.Metadata, {
    "tenant-id": tenantId,
    "job-id": jobId,
    sha256: sha(Buffer.from(body)),
  });
});

test("S02 KMS key switches encryption to aws:kms", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const storage = new S3ExportStorage({
    client,
    bucket: "b",
    kmsKeyId: "arn:aws:kms:eu-west-1:0:key/k",
  });
  const key = exportObject(tenantId, jobId, "jsonl", "export").key;
  await withFile("x", (file) => storage.put(key, { path: file }, meta()));
  assert.equal(calls[0]!.input.ServerSideEncryption, "aws:kms");
  assert.equal(calls[0]!.input.SSEKMSKeyId, "arn:aws:kms:eu-west-1:0:key/k");
});

test("S03 a body that differs from the expected SHA-256 is refused before any upload", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const storage = new S3ExportStorage({ client, bucket: "b" });
  const key = exportObject(tenantId, jobId, "jsonl", "export").key;
  await assert.rejects(
    withFile("actual", (file) =>
      storage.put(
        key,
        { path: file },
        meta({ expectedSha256: sha(Buffer.from("other")) }),
      ),
    ),
    (e: unknown) =>
      e instanceof ExportStorageError && e.code === "checksum_mismatch",
  );
  assert.equal(calls.length, 0);
});

test("S04 put refuses a key that is not this tenant's and job's", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const storage = new S3ExportStorage({ client, bucket: "b" });
  const foreign = exportObject(otherTenant, jobId, "jsonl", "export").key;
  await assert.rejects(
    withFile("x", (file) => storage.put(foreign, { path: file }, meta())),
    (e: unknown) => e instanceof ExportStorageError && e.code === "invalid_key",
  );
  assert.equal(calls.length, 0);
});

test("S05 head maps S3 metadata and reports absent objects as null", async () => {
  const body = Buffer.from("data");
  const present = exportObject(tenantId, jobId, "csv", "export").key;
  const absent = exportObject(tenantId, otherJob, "csv", "export").key;
  const { client, calls } = fakeClient(({ input }) => {
    if (input.Key === absent)
      throw Object.assign(new Error("nf"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
    return {
      ContentLength: body.length,
      ContentType: "text/csv",
      ServerSideEncryption: "AES256",
      ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
      Metadata: { "tenant-id": tenantId, "job-id": jobId, sha256: sha(body) },
    };
  });
  const storage = new S3ExportStorage({ client, bucket: "b" });
  const stored = await storage.head(present);
  assert.equal(calls[0]!.name, HeadObjectCommand.name);
  assert.equal(calls[0]!.input.ChecksumMode, "ENABLED");
  assert.deepEqual(stored, {
    key: present,
    size: 4,
    sha256: sha(body),
    checksumSha256: sha(body),
    tenantId,
    jobId,
    contentType: "text/csv",
    encryption: "AES256",
  });
  assert.equal(await storage.head(absent), null);
});

test("S06 assertStoredMatches detects size, hash, checksum, encryption and tenant drift", () => {
  const base = {
    key: "k",
    size: 4,
    sha256: "aa",
    checksumSha256: "aa",
    tenantId,
    jobId,
    contentType: "x",
    encryption: "AES256",
  };
  const expected = {
    size: 4,
    sha256: "aa",
    tenantId,
    jobId,
    encryption: "AES256",
  };
  assert.doesNotThrow(() => assertStoredMatches(base, expected));
  const codeOf = (stored: Parameters<typeof assertStoredMatches>[0]) => {
    try {
      assertStoredMatches(stored, expected);
    } catch (e) {
      return (e as ExportStorageError).code;
    }
    return "none";
  };
  assert.equal(codeOf({ ...base, size: 5 }), "checksum_mismatch");
  assert.equal(codeOf({ ...base, sha256: "bb" }), "checksum_mismatch");
  assert.equal(codeOf({ ...base, checksumSha256: "bb" }), "checksum_mismatch");
  assert.equal(
    codeOf({ ...base, encryption: undefined }),
    "encryption_mismatch",
  );
  assert.equal(codeOf({ ...base, tenantId: otherTenant }), "tenant_mismatch");
  assert.equal(codeOf({ ...base, jobId: otherTenant }), "tenant_mismatch");
  assert.equal(codeOf({ ...base, tenantId: null }), "tenant_mismatch");
  assert.equal(codeOf(null as never), "missing");
});

test("S07 presignGet signs a short-lived GET with a fixed download disposition", async () => {
  const { client, calls } = fakeClient(() => ({}));
  const storage = new S3ExportStorage({ client, bucket: "audit-bucket" });
  const object = exportObject(tenantId, jobId, "csv", "export");
  const url = new URL(await storage.presignGet(object.key, 120, object));
  assert.equal(calls.length, 0, "presigning must not call S3");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "120");
  assert.equal(
    url.searchParams.get("response-content-disposition"),
    `attachment; filename="audit-${jobId}.csv"`,
  );
  assert.equal(url.searchParams.get("response-content-type"), "text/csv");
  assert.equal(url.pathname.includes(object.key), true);
  assert.equal(url.searchParams.has("X-Amz-Signature"), true);
  assert.equal(GetObjectCommand.name, "GetObjectCommand");
});

test("S08 presign TTL above the 300 second ceiling, zero or fractional is refused", async () => {
  const { client } = fakeClient(() => ({}));
  const storage = new S3ExportStorage({ client, bucket: "b" });
  const object = exportObject(tenantId, jobId, "jsonl", "export");
  assert.equal(MAX_PRESIGN_TTL_SECONDS, 300);
  await assert.doesNotReject(storage.presignGet(object.key, 300, object));
  for (const ttl of [301, 0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      storage.presignGet(object.key, ttl, object),
      (e: unknown) =>
        e instanceof ExportStorageError && e.code === "invalid_ttl",
    );
  }
  assert.throws(
    () => new S3ExportStorage({ client, bucket: "b", presignTtlSeconds: 301 }),
    ExportStorageError,
  );
});

test("S09 listKeys pages through a tenant/job prefix and refuses anything off-layout", async () => {
  const prefix = `tenants/${tenantId}/audit-exports/${jobId}/`;
  const { client, calls } = fakeClient(({ input }) =>
    input.ContinuationToken
      ? { Contents: [{ Key: `${prefix}manifest.json` }], IsTruncated: false }
      : {
          Contents: [
            { Key: `${prefix}audit.jsonl` },
            { Key: `${prefix}signature` },
          ],
          IsTruncated: true,
          NextContinuationToken: "t2",
        },
  );
  const storage = new S3ExportStorage({ client, bucket: "b" });
  assert.deepEqual(await storage.listKeys(tenantId, jobId), [
    `${prefix}audit.jsonl`,
    `${prefix}signature`,
    `${prefix}manifest.json`,
  ]);
  assert.equal(calls[0]!.input.Prefix, prefix);
  assert.equal(calls[1]!.input.ContinuationToken, "t2");
  await assert.rejects(storage.listKeys("../x", jobId), ExportStorageError);
});
