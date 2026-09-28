import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { verifyFirstAdminAccessToken } from "./enroll-first-admin-token.js";

const issuer = "https://id.example.test/";
const config = {
  issuer,
  audience: "greenguard-api",
  jwksUrl: "https://unused.test/jwks",
  tokenMode: "audience" as const,
};

test("verified OIDC access tokens preserve opaque non-UUID subjects", async () => {
  const oidc = await createTestIssuer({ issuer, audience: config.audience });
  const principal = await verifyFirstAdminAccessToken(
    await oidc.sign({ sub: "auth0|operator-abc-123" }),
    randomUUID(),
    config,
    { getKey: oidc.getKey },
  );
  assert.equal(principal.subject, "auth0|operator-abc-123");
  assert.deepEqual(principal.roles, ["admin"]);
});

test("first-admin verifier rejects wrong issuer, wrong audience, expired and client-credentials tokens", async () => {
  const oidc = await createTestIssuer({ issuer, audience: config.audience });
  const verify = (token: string) =>
    verifyFirstAdminAccessToken(token, randomUUID(), config, {
      getKey: oidc.getKey,
    });
  await assert.rejects(
    verify(await oidc.sign({}, { issuer: "https://attacker.example/" })),
  );
  await assert.rejects(verify(await oidc.sign({}, { audience: "other-api" })));
  await assert.rejects(verify(await oidc.sign({}, { expiresInSec: -300 })));
  await assert.rejects(
    verify(await oidc.sign({ sub: "machine@clients", gty: "client-credentials" })),
  );
});

test("first-admin verifier rejects invalid tenant IDs and unbounded token input", async () => {
  const oidc = await createTestIssuer({ issuer, audience: config.audience });
  const token = await oidc.sign({ sub: "external-subject" });
  await assert.rejects(
    verifyFirstAdminAccessToken(token, "not-a-tenant", config, {
      getKey: oidc.getKey,
    }),
    /ENROLL_TENANT_ID/,
  );
  await assert.rejects(
    verifyFirstAdminAccessToken("x".repeat(16_385), randomUUID(), config),
    /single OIDC access token/,
  );
});
