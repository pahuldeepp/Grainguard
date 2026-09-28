import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestIssuer } from "./testing/issuer.js";
import {
  createClientCredentialsVerifier,
  ServiceAuthError,
  requireServiceScope,
} from "./service-principals.js";

const TENANT = "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d";
const PRINCIPAL = "7f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d";
test("OAuth client credentials verifies RS256 and maps client to its sole tenant", async () => {
  const issuer = await createTestIssuer();
  const verifier = createClientCredentialsVerifier({
    issuer: issuer.issuer,
    audience: issuer.audience,
    getKey: issuer.getKey,
    lookup: async (iss, id) =>
      iss === issuer.issuer && id === "client-a"
        ? {
            tenant_id: TENANT,
            principal_id: PRINCIPAL,
            scopes: ["read:telemetry"],
          }
        : undefined,
  });
  const token = await issuer.sign({
    sub: "client-a@clients",
    azp: "client-a",
    gty: "client-credentials",
    scope: "read:telemetry",
    tenant_id: "1f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d",
  });
  const principal = await verifier.verify(`Bearer ${token}`, [
    "read:telemetry",
  ]);
  assert.deepEqual(principal, {
    tenant_id: TENANT,
    principal_id: PRINCIPAL,
    principal_type: "service",
    scopes: ["read:telemetry"],
  });
  requireServiceScope(principal, "read:telemetry");
  assert.throws(
    () => requireServiceScope(principal, "write:devices"),
    ServiceAuthError,
  );
  await assert.rejects(verifier.verify(`Bearer ${token}`, ["write:devices"]), {
    status: 403,
    code: "insufficient_scope",
  });
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.sign({ sub: "user", azp: "client-a", scope: "read:telemetry" })}`,
    ),
    { status: 401, code: "invalid_token" },
  );
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.sign({ sub: "client-b@clients", azp: "client-b", gty: "client-credentials", scope: "read:telemetry" })}`,
    ),
    { status: 401, code: "invalid_token" },
  );
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.sign({ sub: "client-a@clients", azp: "client-a", gty: "client-credentials", scope: "write:devices" })}`,
    ),
    { status: 403, code: "insufficient_scope" },
  );
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.sign({ sub: "client-a@clients", azp: "client-a", gty: "client-credentials", scope: "read:telemetry" }, { issuer: "https://wrong.test" })}`,
    ),
    { status: 401, code: "invalid_token" },
  );
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.sign({ sub: "client-a@clients", azp: "client-a", gty: "client-credentials", scope: "read:telemetry" }, { audience: "wrong" })}`,
    ),
    { status: 401, code: "invalid_token" },
  );
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.sign({ sub: "client-a@clients", azp: "client-a", gty: "client-credentials", scope: "read:telemetry" }, { expiresInSec: -60 })}`,
    ),
    { status: 401, code: "invalid_token" },
  );
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.sign({ sub: "client-a@clients", azp: "client-a", gty: "client-credentials", scope: "read:telemetry" }, { expiresInSec: 3601 })}`,
    ),
    { status: 401, code: "invalid_token" },
  );
  await assert.rejects(
    verifier.verify(
      `Bearer ${await issuer.signHs256WithPublicKey({ sub: "client-a@clients", azp: "client-a", gty: "client-credentials", scope: "read:telemetry" })}`,
    ),
    { status: 401, code: "invalid_token" },
  );
});
test("configured JWKS serves signed short-lived M2M tokens", async () => {
  const issuer = await createTestIssuer();
  const jwks = await issuer.serveJwks();
  try {
    const verifier = createClientCredentialsVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      jwksUrl: jwks.url,
      lookup: async () => ({
        tenant_id: TENANT,
        principal_id: PRINCIPAL,
        scopes: ["read:telemetry"],
      }),
    });
    const token = await issuer.sign({
      sub: "client-a@clients",
      azp: "client-a",
      gty: "client-credentials",
      scope: "read:telemetry",
    });
    assert.equal((await verifier.verify(`Bearer ${token}`)).tenant_id, TENANT);
    assert.equal(jwks.requests(), 1);
  } finally {
    await jwks.close();
  }
});

test("tenantClaim binds the token to the tenant registered for the client", async () => {
  const issuer = await createTestIssuer();
  const seen: (string | undefined)[] = [];
  const verifier = createClientCredentialsVerifier({
    issuer: issuer.issuer,
    audience: issuer.audience,
    getKey: issuer.getKey,
    tenantClaim: "gg_tenant",
    lookup: async (_iss, id, tenantHint) => {
      seen.push(tenantHint);
      return id === "client-a" && tenantHint === TENANT
        ? {
            tenant_id: TENANT,
            principal_id: PRINCIPAL,
            scopes: ["read:telemetry"],
          }
        : undefined;
    },
  });
  const claims = {
    sub: "client-a@clients",
    azp: "client-a",
    gty: "client-credentials",
    scope: "read:telemetry",
  };
  const ok = await verifier.verify(
    `Bearer ${await issuer.sign({ ...claims, gg_tenant: TENANT })}`,
  );
  assert.equal(ok.tenant_id, TENANT);
  assert.deepEqual(seen, [TENANT]);
  for (const extra of [
    {},
    { gg_tenant: "not-a-uuid" },
    { gg_tenant: 7 },
    { gg_tenant: "1f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d" },
  ])
    await assert.rejects(
      verifier.verify(`Bearer ${await issuer.sign({ ...claims, ...extra })}`),
      { status: 401, code: "invalid_token" },
    );
});
