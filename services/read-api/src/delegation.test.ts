import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { createDelegatedSigner } from "@greenguard/tenant-auth/delegated";
import { readDelegation } from "./delegation.js";
const tenant = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
test("Read delegation requires current membership, exact tenant, actor and scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-delegation-"));
  const original = globalThis.fetch;
  try {
    const keys = await generateKeyPair("RS256");
    const pub = { ...(await exportJWK(keys.publicKey)), kid: "test" };
    const file = join(dir, "jwks.json");
    writeFileSync(file, JSON.stringify({ keys: [pub] }));
    let revoked = false,
      foreign = false;
    globalThis.fetch = async () =>
      revoked
        ? new Response("{}", { status: 404 })
        : new Response(
            JSON.stringify({
              tenantId: foreign
                ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
                : tenant,
              identityId: user,
              state: "active",
              roles: ["viewer"],
            }),
          );
    const verifier = readDelegation({
      DELEGATED_ISSUER: "https://delegation.test",
      DELEGATED_JWKS_FILE: file,
      DELEGATED_CONTROL_URL: "https://control.test",
      DELEGATED_CONTROL_TOKEN: "bounded-service-token",
    })!;
    const principal = {
      issuer: "https://idp.test",
      subject: "alice",
      tenantId: tenant,
      roles: ["viewer"] as "viewer"[],
      expiresAt: new Date(Date.now() + 60000),
    };
    const signer = createDelegatedSigner({
      issuer: "https://delegation.test",
      kid: "test",
      privateKey: keys.privateKey,
      identityId: () => user,
      actor: "greenguard-mcp",
    });
    const token = await signer.mint(principal, "read-api", "telemetry:read");
    assert.equal((await verifier.verify("Bearer " + token)).tenantId, tenant);
    foreign = true;
    await assert.rejects(verifier.verify("Bearer " + token));
    foreign = false;
    revoked = true;
    await assert.rejects(verifier.verify("Bearer " + token), { status: 403 });
    revoked = false;
    const wrong = createDelegatedSigner({
      issuer: "https://delegation.test",
      kid: "test",
      privateKey: keys.privateKey,
      identityId: () => user,
      actor: "grain-advisor",
    });
    await assert.rejects(
      verifier.verify(
        "Bearer " + (await wrong.mint(principal, "read-api", "telemetry:read")),
      ),
      { status: 401 },
    );
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Read delegation rejects insecure or credential-bearing membership URLs at startup", () => {
  for (const url of [
    "http://control.example.test",
    "https://user:password@control.test",
    "https://control.test?token=value",
    "https://control.test#fragment",
    "file:///tmp/control",
  ]) {
    assert.throws(
      () =>
        readDelegation({
          DELEGATED_ISSUER: "https://delegation.test",
          DELEGATED_JWKS_URL: "https://keys.test/jwks",
          DELEGATED_CONTROL_URL: url,
          DELEGATED_CONTROL_TOKEN: "test-private-lookup-token",
        }),
      /unsafe delegated membership URL/,
    );
  }
  for (const url of [
    "https://control.test",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
  ]) {
    assert.ok(
      readDelegation({
        DELEGATED_ISSUER: "https://delegation.test",
        DELEGATED_JWKS_URL: "https://keys.test/jwks",
        DELEGATED_CONTROL_URL: url,
        DELEGATED_CONTROL_TOKEN: "test-private-lookup-token",
      }),
    );
  }
});
