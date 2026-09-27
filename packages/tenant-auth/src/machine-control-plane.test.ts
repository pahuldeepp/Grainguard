import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMachineControlPlaneVerifier,
  isMachineCredential,
  machineAwareVerifier,
} from "./machine-control-plane.js";
import { AuthError, type Principal } from "./index.js";

const tenantA = "11111111-1111-4111-8111-111111111111";
const principalId = "33333333-3333-4333-8333-333333333333";
const keyId = "44444444-4444-4444-8444-444444444444";
const key = `gg_dev_usr_${keyId}_${"a".repeat(43)}`;
const jwt = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;

test("machine credentials use owner verification and ignore caller tenant claims", async () => {
  const seen: Array<{ path: string; body: Record<string, string> }> = [];
  const machine = createMachineControlPlaneVerifier({
    endpoint: "http://127.0.0.1:5555",
    lookupToken: "lookup",
    fetcher: async (url, init) => {
      seen.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)) as Record<string, string>,
      });
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer lookup",
      );
      return Response.json({
        tenant_id: tenantA,
        principal_id: principalId,
        principal_type: "service",
        scopes: ["read:telemetry"],
        ...(seen.length === 1 && { key_id: keyId }),
      });
    },
  });
  const keyPrincipal = await machine.verify(`Bearer ${key}`, "read:telemetry");
  assert.equal(keyPrincipal.tenantId, tenantA);
  assert.equal(keyPrincipal.keyId, keyId);
  assert.deepEqual(keyPrincipal.roles, []);
  const token = jwt({
    gty: "client-credentials",
    tenant_id: "22222222-2222-4222-8222-222222222222",
  });
  const oauth = await machine.verify(`Bearer ${token}`, "read:telemetry");
  assert.equal(oauth.tenantId, tenantA);
  assert.equal(oauth.keyId, undefined);
  assert.deepEqual(
    seen.map((x) => x.path),
    [
      "/v1/internal/credentials/api-key/verify",
      "/v1/internal/credentials/oauth-token/verify",
    ],
  );
  assert.deepEqual(seen[1]?.body, { token, requiredScope: "read:telemetry" });
});

test("revoked, insufficient-scope and unavailable owner fail closed", async () => {
  for (const [status, expected] of [
    [401, 401],
    [403, 403],
    [503, 503],
  ] as const) {
    const machine = createMachineControlPlaneVerifier({
      endpoint: "http://127.0.0.1:5555",
      lookupToken: "lookup",
      fetcher: async () => new Response(null, { status }),
    });
    await assert.rejects(
      machine.verify(`Bearer ${key}`, "read:telemetry"),
      (error: unknown) =>
        error instanceof AuthError && error.status === expected,
    );
  }
  const machine = createMachineControlPlaneVerifier({
    endpoint: "http://127.0.0.1:5555",
    lookupToken: "lookup",
    fetcher: async () => {
      throw new Error("network details");
    },
  });
  await assert.rejects(
    machine.verify(`Bearer ${key}`, "read:telemetry"),
    (error: unknown) =>
      error instanceof AuthError &&
      error.status === 503 &&
      error.message === "auth_unavailable",
  );
});

test("only machine-shaped bearer enters machine verifier", async () => {
  const human: Principal = {
    tenantId: tenantA,
    subject: "user",
    roles: ["viewer"],
    expiresAt: new Date(Date.now() + 60_000),
  };
  const verify = machineAwareVerifier(
    async () => human,
    undefined,
    "read:telemetry",
  );
  assert.equal((await verify("Bearer human-token")).subject, "user");
  assert.equal(
    isMachineCredential(`Bearer ${jwt({ gty: "client-credentials" })}`),
    true,
  );
  await assert.rejects(
    verify(`Bearer ${key}`),
    (error: unknown) => error instanceof AuthError && error.status === 503,
  );
});
