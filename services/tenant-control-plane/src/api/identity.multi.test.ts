import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError } from "@greenguard/tenant-auth";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createIdentityVerifier } from "./identity.js";

const first = await createTestIssuer({ issuer: "https://first.example/dex" });
const second = await createTestIssuer({ issuer: "https://second.example/dex" });
const third = await createTestIssuer({ issuer: "https://third.example/dex" });
const verifier = createIdentityVerifier({
  issuers: [
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
});

test("control plane keeps verified issuer identity and email verification", async () => {
  const token = await second.sign({
    sub: "same",
    email: "user@example.test",
    email_verified: true,
    tenant_id: "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d",
    roles: ["admin"],
  });
  assert.deepEqual(await verifier.verify(`Bearer ${token}`), {
    issuer: second.issuer,
    subject: "same",
    email: "user@example.test",
    emailVerified: true,
  });
  const firstToken = await first.sign({ sub: "same" });
  assert.equal(
    (await verifier.verify(`Bearer ${firstToken}`)).issuer,
    first.issuer,
  );
  const unlisted = await third.sign({ sub: "same" });
  await assert.rejects(verifier.verify(`Bearer ${unlisted}`), AuthError);
});
