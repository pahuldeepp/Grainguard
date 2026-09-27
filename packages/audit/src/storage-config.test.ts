import assert from "node:assert/strict";
import test from "node:test";
import {
  createS3ExportStorage,
  readS3StorageConfig,
} from "./storage-config.js";

const base = {
  AUDIT_EXPORT_S3_BUCKET: "gg-audit-exports",
  AUDIT_EXPORT_S3_REGION: "eu-west-1",
};

test("C01 no S3 variable selects the filesystem backend", () => {
  assert.equal(readS3StorageConfig({}), null);
  assert.equal(readS3StorageConfig({ AUDIT_EXPORT_DIRECTORY: "/x" }), null);
});

test("C02 a bucket with a region yields production defaults", () => {
  assert.deepEqual(readS3StorageConfig(base), {
    bucket: "gg-audit-exports",
    region: "eu-west-1",
    forcePathStyle: false,
    presignTtlSeconds: 300,
  });
});

test("C03 partial configuration fails closed", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [
      { AUDIT_EXPORT_S3_REGION: "eu-west-1" },
      /AUDIT_EXPORT_S3_BUCKET is required/,
    ],
    [{ AUDIT_EXPORT_S3_KMS_KEY_ID: "k" }, /AUDIT_EXPORT_S3_BUCKET is required/],
    [
      { AUDIT_EXPORT_S3_BUCKET: "gg-audit-exports" },
      /AUDIT_EXPORT_S3_REGION is required/,
    ],
    [
      { ...base, AUDIT_EXPORT_S3_ACCESS_KEY_ID: "a" },
      /ACCESS_KEY_ID and AUDIT_EXPORT_S3_SECRET_ACCESS_KEY must be set together/,
    ],
    [
      { ...base, AUDIT_EXPORT_S3_SECRET_ACCESS_KEY: "s" },
      /must be set together/,
    ],
  ];
  for (const [env, message] of cases)
    assert.throws(() => readS3StorageConfig(env), message);
});

test("C04 endpoint must be https unless loopback; bucket and TTL are validated", () => {
  assert.throws(
    () =>
      readS3StorageConfig({
        ...base,
        AUDIT_EXPORT_S3_ENDPOINT: "http://s3.example.com",
      }),
    /https/,
  );
  assert.throws(
    () =>
      readS3StorageConfig({ ...base, AUDIT_EXPORT_S3_ENDPOINT: "not a url" }),
    /valid URL/,
  );
  assert.throws(
    () =>
      readS3StorageConfig({ ...base, AUDIT_EXPORT_S3_BUCKET: "Bad_Bucket" }),
    /bucket name/,
  );
  for (const ttl of ["301", "0", "abc", "1.5", "-5"])
    assert.throws(
      () =>
        readS3StorageConfig({
          ...base,
          AUDIT_EXPORT_S3_PRESIGN_TTL_SECONDS: ttl,
        }),
      /1 to 300/,
    );
  assert.throws(
    () =>
      readS3StorageConfig({
        ...base,
        AUDIT_EXPORT_S3_FORCE_PATH_STYLE: "maybe",
      }),
    /true or false/,
  );
});

test("C05 local MinIO settings enable path style and static credentials", () => {
  const config = readS3StorageConfig({
    ...base,
    AUDIT_EXPORT_S3_ENDPOINT: "http://127.0.0.1:59000",
    AUDIT_EXPORT_S3_ACCESS_KEY_ID: "local-id",
    AUDIT_EXPORT_S3_SECRET_ACCESS_KEY: "local-secret",
    AUDIT_EXPORT_S3_KMS_KEY_ID: "alias/audit",
    AUDIT_EXPORT_S3_PRESIGN_TTL_SECONDS: "60",
  });
  assert.deepEqual(config, {
    bucket: "gg-audit-exports",
    region: "eu-west-1",
    endpoint: "http://127.0.0.1:59000",
    forcePathStyle: true,
    credentials: { accessKeyId: "local-id", secretAccessKey: "local-secret" },
    kmsKeyId: "alias/audit",
    presignTtlSeconds: 60,
  });
  const storage = createS3ExportStorage(config!);
  assert.equal(storage.kind, "s3");
  assert.equal(storage.encryption, "aws:kms");
  assert.equal(storage.maxTtlSeconds, 60);
});
