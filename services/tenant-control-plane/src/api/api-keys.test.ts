import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createControlPlaneApp } from "../app.js";
import { runtimeDb, uniqueSubject } from "../testing/fixtures.js";

test("API-key HTTP issuance shows secret once, metadata is safe, and revocation denies lookup", async () => {
  const issuer = await createTestIssuer();
  const db = runtimeDb(3);
  const app = await createControlPlaneApp({
    db,
    lookupToken: "lookup-for-09b",
    apiKeyPepper:
      "a long server side pepper for testing only, more than 32 bytes",
    auth: {
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    },
    m2m: {
      issuer: issuer.issuer,
      audience: issuer.audience,
      getKey: issuer.getKey,
    },
  });
  await app.listen(0, "127.0.0.1");
  try {
    const base = await app.getUrl();
    const token = await issuer.sign({ sub: uniqueSubject("http-api-key") });
    const call = async (
      path: string,
      body: object | undefined,
      authorization: string,
      method = "POST",
    ) => {
      const res = await fetch(new URL(path, base), {
        method,
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      };
    };
    const org = await call(
      "/v1/organizations",
      { name: "HTTP key test" },
      `Bearer ${token}`,
    );
    assert.equal(org.status, 201, JSON.stringify(org.body));
    const tenantId = org.body.tenantId as string;
    const issued = await call(
      `/v1/organizations/${tenantId}/credentials/api-keys`,
      {
        name: "ingest",
        kind: "dev",
        deviceId: randomUUID(),
        scopes: ["write:telemetry"],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      `Bearer ${token}`,
    );
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.match(issued.body.key as string, /^gg_dev_dev_/);
    const listed = await call(
      `/v1/organizations/${tenantId}/credentials`,
      undefined,
      `Bearer ${token}`,
      "GET",
    );
    assert.equal(listed.status, 200);
    assert.ok(!JSON.stringify(listed.body).includes(issued.body.key as string));
    const verified = await call(
      "/v1/internal/credentials/api-key/verify",
      { key: issued.body.key },
      "Bearer lookup-for-09b",
    );
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.tenant_id, tenantId);
    const revoked = await call(
      `/v1/organizations/${tenantId}/credentials/${issued.body.principalId}/revoke`,
      {},
      `Bearer ${token}`,
    );
    assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
    const denied = await call(
      "/v1/internal/credentials/api-key/verify",
      { key: issued.body.key },
      "Bearer lookup-for-09b",
    );
    assert.equal(denied.status, 401);
    const clientId = uniqueSubject("m2m-client");
    const registered = await call(
      `/v1/organizations/${tenantId}/credentials/oauth-clients`,
      {
        name: "m2m",
        issuer: issuer.issuer,
        clientId,
        scopes: ["write:telemetry"],
      },
      `Bearer ${token}`,
    );
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const machineToken = await issuer.sign({
      sub: `${clientId}@clients`,
      azp: clientId,
      gty: "client-credentials",
      scope: "write:telemetry",
      tenant_id: randomUUID(),
      gg_tenant: tenantId,
    });
    const machine = await call(
      "/v1/internal/credentials/oauth-token/verify",
      { token: machineToken, requiredScope: "write:telemetry" },
      "Bearer lookup-for-09b",
    );
    assert.equal(machine.status, 200, JSON.stringify(machine.body));
    assert.deepEqual(machine.body, {
      tenant_id: tenantId,
      principal_id: registered.body.principalId,
      principal_type: "service",
      scopes: ["write:telemetry"],
    });
    // Tenant B (or a token with no tenant claim) cannot use A's client id.
    for (const extra of [{ gg_tenant: randomUUID() }, {}]) {
      const foreign = await issuer.sign({
        sub: `${clientId}@clients`,
        azp: clientId,
        gty: "client-credentials",
        scope: "write:telemetry",
        ...extra,
      });
      const refused = await call(
        "/v1/internal/credentials/oauth-token/verify",
        { token: foreign, requiredScope: "write:telemetry" },
        "Bearer lookup-for-09b",
      );
      assert.equal(refused.status, 401);
    }
    const deniedScope = await call(
      "/v1/internal/credentials/oauth-token/verify",
      { token: machineToken, requiredScope: "export:audit" },
      "Bearer lookup-for-09b",
    );
    assert.equal(deniedScope.status, 403);
  } finally {
    await app.close();
  }
});
