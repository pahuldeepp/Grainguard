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
