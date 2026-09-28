import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "./config.js";

const base = { ALERTS_DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" };
const auth = {
  ALERTS_ACTOR_HMAC_KEY: "test-actor-key-at-least-32-bytes-long",
  ALERTS_HISTORY_CURSOR_KEY: "test-cursor-key-at-least-32-bytes-long",
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
    actorHmacKey: undefined,
    historyCursorKey: undefined,
    otlpEndpoint: undefined,
    kafkaBrokers: [],
    kafkaGroup: "workflow-alerts",
  });
  assert.throws(() => readConfig({ ...base, PORT: "70000" }), /PORT/);
});

test("required shard mode rejects a missing registry instead of using the legacy URL", () => {
  assert.throws(
    () => readConfig({ ...base, SHARD_ROUTING_REQUIRED: "true" }),
    /shard_registry_required/,
  );
  assert.equal(
    readConfig({ ...base, SHARD_ROUTING_REQUIRED: "false" }).databaseUrl,
    base.ALERTS_DATABASE_URL,
  );
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

test("authenticated startup validates secret keys before opening owner resources", () => {
  assert.throws(
    () => readConfig({ ...base, ...auth, ALERTS_ACTOR_HMAC_KEY: undefined }),
    /ALERTS_ACTOR_HMAC_KEY/,
  );
  assert.throws(
    () => readConfig({ ...base, ...auth, ALERTS_HISTORY_CURSOR_KEY: "short" }),
    /ALERTS_HISTORY_CURSOR_KEY/,
  );
});
test("Cognito access mode requires mapped users and public client IDs", () => {
  const cognito = {
    ...base,
    ...auth,
    AUTH_AUDIENCE: undefined,
    AUTH_TOKEN_MODE: "cognito-access",
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
    () => readConfig({ ...base, ...auth, AUTH_COGNITO_CLIENT_IDS: "ios" }),
    /AUTH_COGNITO_CLIENT_IDS/,
  );
});

test("private shard registry config requires no legacy database URL", () => {
  assert.equal(
    readConfig({ SHARD_REGISTRY_FILE: "/private/owners.json" }).databaseUrl,
    "",
  );
});
