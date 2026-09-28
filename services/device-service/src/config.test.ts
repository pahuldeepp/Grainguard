import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "./config.js";
test("requires the database URL without echoing any value", () => {
  assert.throws(() => readConfig({}), /INVENTORY_DATABASE_URL is required/);
});
test("applies local defaults", () => {
  assert.deepEqual(readConfig({ INVENTORY_DATABASE_URL: "postgres://x" }), {
    databaseUrl: "postgres://x",
    port: 3001,
    host: "127.0.0.1",
  });
});
test("honours PORT and HOST overrides", () => {
  assert.deepEqual(
    readConfig({
      INVENTORY_DATABASE_URL: "postgres://x",
      PORT: "4100",
      HOST: "0.0.0.0",
    }),
    { databaseUrl: "postgres://x", port: 4100, host: "0.0.0.0" },
  );
});

const base = { INVENTORY_DATABASE_URL: "postgres://x" };
test("mesh control lookup HTTP requires opt-in and Service DNS; JWKS stays HTTPS", () => {
  const importEnv = {
    IMPORT_SOURCE_ID: "partner-main",
    IMPORT_AUTH_ISSUER: "https://idp.example",
    IMPORT_AUTH_AUDIENCE: "greenguard-import",
    IMPORT_AUTH_JWKS_URL: "https://idp.example/jwks",
    IMPORT_AUTH_TENANT_CLAIM: "gg_tenant",
    CONTROL_LOOKUP_URL:
      "http://tenant-control.greenguard.svc.cluster.local:8080",
    CONTROL_LOOKUP_TOKEN: "x".repeat(32),
  };
  assert.throws(() => readConfig({ ...base, ...importEnv }), /use https/);
  assert.equal(
    readConfig({ ...base, ...importEnv, GG_MESH_INTERNAL_HTTP: "1" }).importAuth
      ?.controlUrl,
    `${importEnv.CONTROL_LOOKUP_URL}/`,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...importEnv,
        GG_MESH_INTERNAL_HTTP: "1",
        CONTROL_LOOKUP_URL: "http://example.com",
      }),
    /use https/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...importEnv,
        GG_MESH_INTERNAL_HTTP: "1",
        IMPORT_AUTH_JWKS_URL: "http://idp.greenguard.svc",
      }),
    /use https/,
  );
});
test("auth is optional but all-or-nothing", () => {
  assert.equal(readConfig(base).auth, undefined);
  assert.deepEqual(
    readConfig({
      ...base,
      AUTH_ISSUER: "https://idp.example",
      AUTH_AUDIENCE: "greenguard-api",
      AUTH_JWKS_URL: "https://idp.example/.well-known/jwks.json",
    }).auth,
    {
      issuer: "https://idp.example",
      audience: "greenguard-api",
      jwksUrl: "https://idp.example/.well-known/jwks.json",
      tokenMode: "audience",
    },
  );
  for (const partial of [
    { AUTH_ISSUER: "https://idp.example" },
    { AUTH_AUDIENCE: "a", AUTH_JWKS_URL: "https://idp.example/jwks" },
    { AUTH_JWKS_URL: "https://idp.example/jwks" },
  ])
    assert.throws(
      () => readConfig({ ...base, ...partial }),
      /must be set together/,
    );
});
test("Cognito access mode requires mapped users and public client IDs", () => {
  const cognito = {
    ...base,
    AUTH_TOKEN_MODE: "cognito-access",
    AUTH_ISSUER:
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example",
    AUTH_JWKS_URL:
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example/.well-known/jwks.json",
  };
  assert.throws(() => readConfig(cognito), /AUTH_COGNITO_CLIENT_IDS/);
  assert.throws(
    () => readConfig({ ...cognito, AUTH_COGNITO_CLIENT_IDS: "ios" }),
    /control-plane membership/,
  );
  assert.equal(
    readConfig({
      ...cognito,
      AUTH_COGNITO_CLIENT_IDS: "ios",
      AUTH_MEMBERSHIP_SOURCE: "control-plane",
      CONTROL_PLANE_URL: "https://control.example",
      CONTROL_LOOKUP_TOKEN: "x".repeat(32),
    }).auth?.tokenMode,
    "cognito-access",
  );
  assert.throws(
    () => readConfig({ ...base, AUTH_COGNITO_CLIENT_IDS: "ios" }),
    /AUTH_COGNITO_CLIENT_IDS/,
  );
});
test("the JWKS URL must be https, or loopback http for local development", () => {
  const withUrl = (AUTH_JWKS_URL: string) =>
    readConfig({
      ...base,
      AUTH_ISSUER: "i",
      AUTH_AUDIENCE: "a",
      AUTH_JWKS_URL,
    });
  assert.equal(
    withUrl("http://127.0.0.1:4010/jwks").auth?.jwksUrl,
    "http://127.0.0.1:4010/jwks",
  );
  assert.equal(
    withUrl("http://localhost/jwks").auth?.jwksUrl,
    "http://localhost/jwks",
  );
  assert.throws(() => withUrl("http://idp.example/jwks"), /must use https/);
  assert.throws(() => withUrl("ftp://localhost/jwks"), /must use https/);
  assert.throws(() => withUrl("not a url"));
});

test("import service authentication is all-or-nothing and requires secure endpoints", () => {
  const importEnv = {
    IMPORT_SOURCE_ID: "partner-main",
    IMPORT_AUTH_ISSUER: "https://idp.example",
    IMPORT_AUTH_AUDIENCE: "greenguard-import",
    IMPORT_AUTH_JWKS_URL: "https://idp.example/jwks",
    IMPORT_AUTH_TENANT_CLAIM: "gg_tenant",
    CONTROL_LOOKUP_URL: "https://control.example",
    CONTROL_LOOKUP_TOKEN: "x".repeat(32),
  };
  assert.equal(
    readConfig({ ...base, ...importEnv }).importAuth?.tenantClaim,
    "gg_tenant",
  );
  assert.equal(
    readConfig({ ...base, ...importEnv }).importAuth?.sourceId,
    "partner-main",
  );
  assert.equal(
    readConfig({ ...base, CONTROL_LOOKUP_TOKEN: "x".repeat(32) }).importAuth,
    undefined,
  );
  assert.throws(
    () =>
      readConfig({ ...base, CONTROL_LOOKUP_URL: "https://control.example" }),
    /must be set together/,
  );
  assert.throws(
    () => readConfig({ ...base, ...importEnv, IMPORT_SOURCE_ID: "" }),
    /must be set together/,
  );
  assert.throws(
    () =>
      readConfig({ ...base, ...importEnv, IMPORT_SOURCE_ID: "invalid source" }),
    /IMPORT_SOURCE_ID is invalid/,
  );
  assert.throws(
    () => readConfig({ ...base, IMPORT_AUTH_ISSUER: "https://idp.example" }),
    /must be set together/,
  );
  assert.throws(
    () => readConfig({ ...base, ...importEnv, CONTROL_LOOKUP_TOKEN: "short" }),
    /at least 32 bytes/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...importEnv,
        CONTROL_LOOKUP_URL: "http://control.example",
      }),
    /must use https/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...importEnv,
        IMPORT_AUTH_JWKS_URL: "http://idp.example/jwks",
      }),
    /must use https/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...importEnv,
        CONTROL_LOOKUP_URL: "https://user:secret@control.example",
      }),
    /cannot contain credentials/,
  );
});

test("tracing is enabled only by a collector endpoint and validates its settings", () => {
  assert.equal(readConfig(base).otel, undefined);
  assert.deepEqual(
    readConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    }).otel,
    { otlpEndpoint: "http://collector:4318", sampleRatio: 1 },
  );
  assert.equal(
    readConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example",
      OTEL_TRACES_SAMPLE_RATIO: "0.25",
    }).otel?.sampleRatio,
    0.25,
  );
  assert.equal(
    readConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
      OTEL_TRACES_SAMPLE_RATIO: "0",
    }).otel?.sampleRatio,
    0,
  );
  const withEndpoint = (extra: Record<string, string>) =>
    readConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
      ...extra,
    });
  for (const ratio of ["1.5", "-0.1", "abc"])
    assert.throws(
      () => withEndpoint({ OTEL_TRACES_SAMPLE_RATIO: ratio }),
      /from 0 to 1/,
    );
  assert.throws(
    () => readConfig({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://c" }),
    /http\(s\)/,
  );
});

test("private shard registry config requires no legacy database URL", () => {
  assert.equal(
    readConfig({ SHARD_REGISTRY_FILE: "/private/owners.json" }).databaseUrl,
    "",
  );
});
