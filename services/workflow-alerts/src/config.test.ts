import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "./config.js";

const base = { ALERTS_DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" };
const auth = {
  AUTH_ISSUER: "https://issuer.test",
  AUTH_AUDIENCE: "greenguard-api",
  AUTH_JWKS_URL: "https://issuer.test/jwks",
};

test("defaults and required database URL", () => {
  assert.throws(() => readConfig({}), /ALERTS_DATABASE_URL is required/);
  assert.deepEqual(readConfig(base), {
    databaseUrl: base.ALERTS_DATABASE_URL,
    host: "127.0.0.1",
    port: 3004,
    auth: undefined,
    otlpEndpoint: undefined,
    kafkaBrokers: [],
    kafkaGroup: "workflow-alerts",
  });
  assert.throws(() => readConfig({ ...base, PORT: "70000" }), /PORT/);
});

test("AUTH_* is all-or-nothing and JWKS needs https outside loopback", () => {
  assert.equal(readConfig({ ...base, ...auth }).auth?.issuer, auth.AUTH_ISSUER);
  assert.throws(
    () => readConfig({ ...base, AUTH_ISSUER: "x" }),
    /set together/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...auth,
        AUTH_JWKS_URL: "http://example.com/jwks",
      }),
    /https/,
  );
  assert.ok(
    readConfig({ ...base, ...auth, AUTH_JWKS_URL: "http://127.0.0.1:9/jwks" })
      .auth,
  );
});
