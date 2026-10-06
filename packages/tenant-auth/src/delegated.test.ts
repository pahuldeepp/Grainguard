import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  decodeJwt,
} from "jose";
import { createDelegatedSigner, createDelegatedVerifier } from "./delegated.js";
import type { Principal } from "./index.js";
const issuer = "https://delegation.test";
const tenant = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";

test("delegation binds one audience/scope and current membership", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "key1",
    alg: "RS256",
    use: "sig",
  };
  const signer = createDelegatedSigner({
    issuer,
    kid: "key1",
    privateKey,
    identityId: () => user,
  });
  const principal: Principal = {
    issuer: "https://login.test",
    subject: "external-user",
    tenantId: tenant,
    roles: ["operator"],
    expiresAt: new Date(Date.now() + 60000),
  };
  const token = await signer.mint(principal, "grain-advisor", "advisor:decide");
  const claims = decodeJwt(token);
  assert.equal(claims.sub, user);
  assert.equal(claims.aud, "grain-advisor");
  assert(claims.exp! - claims.iat! <= 60);
  let current: string[] | null = ["operator"];
  const verifier = createDelegatedVerifier({
    issuer,
    audience: "grain-advisor",
    requiredScope: "advisor:decide",
    keys: createLocalJWKSet({ keys: [jwk] }),
    membership: async (t, u) => {
      assert.equal(t, tenant);
      assert.equal(u, user);
      return current;
    },
  });
  assert.equal((await verifier.verify(`Bearer ${token}`)).subject, user);
  current = ["viewer"];
  await assert.rejects(verifier.verify(`Bearer ${token}`));
  current = ["device"];
  await assert.rejects(verifier.verify(`Bearer ${token}`), { status: 403 });
  current = ["unknown"];
  await assert.rejects(verifier.verify(`Bearer ${token}`), { status: 503 });
  current = null;
  await assert.rejects(verifier.verify(`Bearer ${token}`));
  current = ["operator"];
  const other = createDelegatedVerifier({
    issuer,
    audience: "workflow-alerts",
    requiredScope: "alerts:acknowledge",
    keys: createLocalJWKSet({ keys: [jwk] }),
    membership: async () => current,
  });
  await assert.rejects(other.verify(`Bearer ${token}`));
  await assert.rejects(
    signer.mint(
      { ...principal, roles: ["viewer"] },
      "grain-advisor",
      "advisor:decide",
    ),
  );
  await assert.rejects(
    signer.mint(
      { ...principal, principalType: "service" },
      "grain-advisor",
      "advisor:decide",
    ),
  );
  await assert.rejects(
    signer.mint(
      { ...principal, expiresAt: new Date(0) },
      "grain-advisor",
      "advisor:decide",
    ),
  );
  const signed = (overrides: Record<string, unknown>) =>
    new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "key1" })
      .sign(privateKey);
  for (const change of [
    { aud: ["grain-advisor", "workflow-alerts"] },
    { act: { sub: "attacker" } },
    { scope: "advisor:propose" },
    { roles: ["device"] },
    { token_use: "access" },
    { exp: claims.iat! + 301 },
    { sub: "raw-idp-user" },
    { exp: 1 },
    { tenant_id: "forged" },
    { unexpected: "claim" },
  ])
    await assert.rejects(verifier.verify(`Bearer ${await signed(change)}`));
  const outage = createDelegatedVerifier({
    issuer,
    audience: "grain-advisor",
    requiredScope: "advisor:decide",
    keys: createLocalJWKSet({ keys: [jwk] }),
    membership: async () => {
      throw new Error("outage");
    },
  });
  await assert.rejects(outage.verify(`Bearer ${token}`), { status: 503 });
});
