import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "./config.js";

const LOOKUP = "lookup-token-with-at-least-32-bytes!";
const base = {
  CONTROL_DATABASE_URL: "postgresql://x/y",
  CONTROL_LOOKUP_TOKEN: LOOKUP,
};

test("reads defaults and requires the database URL and lookup credential", () => {
  assert.deepEqual(readConfig(base), {
    databaseUrl: "postgresql://x/y",
    lookupToken: LOOKUP,
    host: "127.0.0.1",
    port: 3010,
    auth: undefined,
    otlpEndpoint: undefined,
  });
  assert.throws(
    () => readConfig({ CONTROL_LOOKUP_TOKEN: LOOKUP }),
    /CONTROL_DATABASE_URL/,
  );
  assert.throws(
    () => readConfig({ CONTROL_DATABASE_URL: "u" }),
    /CONTROL_LOOKUP_TOKEN/,
  );
  assert.throws(() => readConfig({ ...base, PORT: "70000" }), /PORT/);
});

test("the lookup credential must hold at least 32 bytes", () => {
  assert.throws(
    () => readConfig({ ...base, CONTROL_LOOKUP_TOKEN: "x".repeat(31) }),
    /CONTROL_LOOKUP_TOKEN must contain at least 32 bytes/,
  );
  assert.equal(
    readConfig({ ...base, CONTROL_LOOKUP_TOKEN: "x".repeat(32) }).lookupToken,
    "x".repeat(32),
  );
});

test("AUTH_* is all-or-nothing and remote JWKS must use https", () => {
  const auth = {
    AUTH_ISSUER: "https://i",
    AUTH_AUDIENCE: "a",
    AUTH_JWKS_URL: "http://127.0.0.1:5556/keys",
  };
  assert.deepEqual(readConfig({ ...base, ...auth }).auth, {
    issuer: "https://i",
    audience: "a",
    jwksUrl: "http://127.0.0.1:5556/keys",
  });
  assert.throws(
    () => readConfig({ ...base, AUTH_ISSUER: "https://i" }),
    /must be set together/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        ...auth,
        AUTH_JWKS_URL: "http://idp.example/keys",
      }),
    /https/,
  );
});

test("09g multi-issuer config accepts two issuers and preserves legacy single issuer", () => {
  const issuers = [
    {
      issuer: "http://127.0.0.1:5556/dex",
      audience: "dashboard",
      jwksUrl: "http://127.0.0.1:5556/dex/keys",
    },
    {
      issuer: "http://127.0.0.1:5557/dex",
      audience: "dashboard",
      jwksUrl: "http://127.0.0.1:5557/dex/keys",
    },
  ];
  assert.deepEqual(
    readConfig({ ...base, AUTH_ISSUERS_JSON: JSON.stringify(issuers) }).auth,
    { issuers },
  );
  assert.deepEqual(
    readConfig({
      ...base,
      AUTH_ISSUER: issuers[0]!.issuer,
      AUTH_AUDIENCE: "dashboard",
      AUTH_JWKS_URL: issuers[0]!.jwksUrl,
    }).auth,
    issuers[0],
  );
});

test("09g multi-issuer config rejects malformed, duplicate and unsafe entries", () => {
  const one = {
    issuer: "https://idp.example",
    audience: "api",
    jwksUrl: "https://idp.example/keys",
  };
  assert.throws(
    () => readConfig({ ...base, AUTH_ISSUERS_JSON: "{" }),
    /valid JSON/,
  );
  assert.throws(() => readConfig({ ...base, AUTH_ISSUERS_JSON: "[]" }), /1-16/);
  assert.throws(
    () =>
      readConfig({ ...base, AUTH_ISSUERS_JSON: JSON.stringify([one, one]) }),
    /duplicate/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        AUTH_ISSUERS_JSON: JSON.stringify([
          { ...one, jwksUrl: "http://idp.example/keys" },
        ]),
      }),
    /https/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        AUTH_ISSUERS_JSON: JSON.stringify([{ ...one, extra: "x" }]),
      }),
    /invalid issuer/,
  );
  assert.throws(
    () =>
      readConfig({
        ...base,
        AUTH_ISSUERS_JSON: JSON.stringify([one]),
        AUTH_ISSUER: one.issuer,
      }),
    /cannot be combined/,
  );
});

test("09e audit export requires all owner databases when enabled", () => {
  const audit = {
    AUDIT_EXPORT_DIRECTORY: "/var/lib/greenguard/audit",
    AUDIT_EXPORT_PUBLIC_KEY_PEM: "public-key",
    AUDIT_EXPORT_LINK_SECRET: "a-secret-with-at-least-thirty-two-bytes",
  };
  assert.throws(
    () => readConfig({ ...base, ...audit }),
    /INVENTORY_DATABASE_URL and BILLING_DATABASE_URL/,
  );
  const config = readConfig({
    ...base,
    ...audit,
    INVENTORY_DATABASE_URL: "postgresql://inventory/gg",
    BILLING_DATABASE_URL: "postgresql://billing/gg",
  });
  assert.deepEqual(config.audit, {
    directory: "/var/lib/greenguard/audit",
    publicKeyPem: "public-key",
    linkSecret: "a-secret-with-at-least-thirty-two-bytes",
    inventoryDatabaseUrl: "postgresql://inventory/gg",
    billingDatabaseUrl: "postgresql://billing/gg",
  });
});

test("machine issuers default to the M2M issuer, may be listed, and must be https", () => {
  const m2m = {
    CONTROL_M2M_ISSUER: "https://m2m.example",
    CONTROL_M2M_AUDIENCE: "aud",
    CONTROL_M2M_JWKS_URL: "https://m2m.example/jwks",
  };
  const config = readConfig({ ...base, ...m2m });
  assert.deepEqual(config.machineIssuers, ["https://m2m.example"]);
  assert.equal(config.m2m?.tenantClaim, "gg_tenant");
  assert.deepEqual(
    readConfig({
      ...base,
      ...m2m,
      CONTROL_M2M_TENANT_CLAIM: "tenant",
      MACHINE_ISSUER_ALLOWLIST: "https://a.example, https://b.example",
    }).machineIssuers,
    ["https://a.example", "https://b.example"],
  );
  assert.equal(readConfig(base).machineIssuers, undefined);
  assert.throws(
    () => readConfig({ ...base, MACHINE_ISSUER_ALLOWLIST: "http://a" }),
    /https/,
  );
  assert.throws(
    () => readConfig({ ...base, ...m2m, CONTROL_M2M_TENANT_CLAIM: "a b" }),
    /CONTROL_M2M_TENANT_CLAIM/,
  );
});
