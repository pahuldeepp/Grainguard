import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../config.js";

const base = {
  CONTROL_DATABASE_URL: "postgresql://c/c",
  CONTROL_LOOKUP_TOKEN: "lookup-token-with-at-least-32-bytes!",
};
const owners = {
  INVENTORY_DATABASE_URL: "postgresql://i/i",
  BILLING_DATABASE_URL: "postgresql://b/b",
};
const s3 = {
  AUDIT_EXPORT_S3_BUCKET: "gg-audit-exports",
  AUDIT_EXPORT_S3_REGION: "eu-west-1",
};
const key = { AUDIT_EXPORT_PUBLIC_KEY_PEM: "public-key" };

test("S3C1 bucket, region and public key enable S3 without a directory or link secret", () => {
  const config = readConfig({ ...base, ...owners, ...s3, ...key });
  assert.deepEqual(config.audit, {
    publicKeyPem: "public-key",
    inventoryDatabaseUrl: "postgresql://i/i",
    billingDatabaseUrl: "postgresql://b/b",
    s3: {
      bucket: "gg-audit-exports",
      region: "eu-west-1",
      forcePathStyle: false,
      presignTtlSeconds: 300,
    },
  });
});

test("S3C2 partial S3 configuration fails closed", () => {
  assert.throws(
    () => readConfig({ ...base, ...owners, ...s3 }),
    /AUDIT_EXPORT_S3_BUCKET and AUDIT_EXPORT_PUBLIC_KEY_PEM must be set together/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...owners,
        ...key,
        AUDIT_EXPORT_S3_REGION: "eu-west-1",
      }),
    /AUDIT_EXPORT_S3_BUCKET is required/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...owners,
        ...key,
        AUDIT_EXPORT_S3_BUCKET: "gg-audit-exports",
      }),
    /AUDIT_EXPORT_S3_REGION is required/,
  );
  assert.throws(
    () => readConfig({ ...base, ...s3, ...key }),
    /INVENTORY_DATABASE_URL and BILLING_DATABASE_URL/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...owners,
        ...s3,
        ...key,
        AUDIT_EXPORT_S3_ACCESS_KEY_ID: "a",
      }),
    /must be set together/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...owners,
        ...s3,
        ...key,
        AUDIT_EXPORT_S3_PRESIGN_TTL_SECONDS: "900",
      }),
    /1 to 300/,
  );
});

test("S3C3 a set link secret is still length-checked and S3 wins over a directory", () => {
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...owners,
        ...s3,
        ...key,
        AUDIT_EXPORT_LINK_SECRET: "short",
      }),
    /at least 32 bytes/,
  );
  const config = readConfig({
    ...base,
    ...owners,
    ...s3,
    ...key,
    AUDIT_EXPORT_DIRECTORY: "/ignored",
  });
  assert.equal(config.audit?.s3?.bucket, "gg-audit-exports");
  assert.equal(config.audit?.directory, undefined);
});
