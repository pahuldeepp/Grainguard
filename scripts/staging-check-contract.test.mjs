import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertAnonymousRequestRejected } from "./staging-check-contract.mjs";

test("staging product services mount APIs with an isolated OIDC profile", () => {
  const compose = readFileSync(
    fileURLToPath(new URL("../infra/staging/compose.yaml", import.meta.url)),
    "utf8",
  );
  assert.match(compose, /x-staging-oidc:\s*&staging-oidc/);
  for (const service of ["device-service", "telemetry-ingest", "gateway"]) {
    const block = new RegExp(
      `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:)`,
      "m",
    ).exec(compose)?.[1];
    assert.ok(block, `${service} is present in staging compose`);
    assert.match(block, /<<:\s*\*staging-oidc/);
  }
  assert.match(compose, /STAGING_AUTH_ISSUER:-https:\/\/staging\.invalid/);
  assert.match(
    compose,
    /STAGING_AUTH_JWKS_URL:-https:\/\/staging\.invalid\/keys/,
  );
});

test("staging accepts a mounted API that rejects anonymous requests", () => {
  assert.doesNotThrow(() =>
    assertAnonymousRequestRejected({ status: 401 }, "telemetry-ingest"),
  );
});

test("staging rejects a health-only API whose product route returns 404", () => {
  assert.throws(
    () => assertAnonymousRequestRejected({ status: 404 }, "telemetry-ingest"),
    /must reject anonymous requests with 401; received 404/,
  );
});

test("staging rejects an API whose anonymous request is not authenticated", () => {
  assert.throws(
    () => assertAnonymousRequestRejected({ status: 200 }, "device-service"),
    /must reject anonymous requests with 401; received 200/,
  );
});
