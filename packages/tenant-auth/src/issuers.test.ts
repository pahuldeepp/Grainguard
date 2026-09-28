import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, membershipMapper, parseMemberships } from "./index.js";
import { createMultiIssuerVerifier } from "./issuers.js";
import { createTestIssuer, TEST_TENANT_ID } from "./testing/issuer.js";

const first = await createTestIssuer({ issuer: "https://first.example/dex" });
const second = await createTestIssuer({ issuer: "https://second.example/dex" });
const unknown = await createTestIssuer({
  issuer: "https://unknown.example/dex",
});
const tenantB = "9b2c7d1e-3f4a-4b5c-8d6e-7f8091a2b3c4";
const mapper = membershipMapper(
  parseMemberships(
    JSON.stringify([
      {
        issuer: first.issuer,
        subject: "same-sub",
        tenantId: TEST_TENANT_ID,
        roles: ["admin"],
      },
      {
        issuer: second.issuer,
        subject: "same-sub",
        tenantId: tenantB,
        roles: ["viewer"],
      },
    ]),
  ),
);
const verifier = createMultiIssuerVerifier(
  [
    {
      issuer: first.issuer,
      audience: first.audience,
      keys: { getKey: first.getKey },
    },
    {
      issuer: second.issuer,
      audience: second.audience,
      keys: { getKey: second.getKey },
    },
  ],
  mapper,
);
const bearer = (token: string) => `Bearer ${token}`;

test("S01: unlisted issuer is rejected", async () => {
  const token = await unknown.sign({ sub: "same-sub" });
  await assert.rejects(
    verifier.verify(bearer(token)),
    (error: unknown) =>
      error instanceof AuthError &&
      error.status === 401 &&
      error.code === "invalid_token",
  );
});

test("S02/S03: same subject is scoped by issuer and IdP tenant claims are ignored", async () => {
  const a = await verifier.verify(
    bearer(
      await first.sign({
        sub: "same-sub",
        tenant_id: tenantB,
        roles: ["device"],
      }),
    ),
  );
  const b = await verifier.verify(
    bearer(
      await second.sign({
        sub: "same-sub",
        tenant_id: TEST_TENANT_ID,
        roles: ["admin"],
      }),
    ),
  );
  assert.equal(a.issuer, first.issuer);
  assert.equal(a.principal.tenantId, TEST_TENANT_ID);
  assert.deepEqual(a.principal.roles, ["admin"]);
  assert.equal(b.issuer, second.issuer);
  assert.equal(b.principal.tenantId, tenantB);
  assert.deepEqual(b.principal.roles, ["viewer"]);
});

test("issuer confusion cannot select a different key set", async () => {
  const forged = await first.sign({ sub: "same-sub", iss: second.issuer });
  await assert.rejects(
    verifier.verify(bearer(forged)),
    (error: unknown) => error instanceof AuthError && error.status === 401,
  );
});
