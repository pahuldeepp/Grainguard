import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  adminQuery,
  createActiveTenantFixture,
  runtimeDb,
  uniqueSubject,
} from "../testing/fixtures.js";
import { outboxEvents } from "../testing/fixtures.js";
import { validateEvent } from "@greenguard/contracts";
import { revokeMember, type Actor } from "./store.js";
import {
  createApiKey,
  KEY_PATTERN,
  keyDigest,
  listCredentials,
  lookupOAuthClient,
  registerOAuthClient,
  revokeCredential,
  rotateApiKey,
  verifyApiKey,
  verifyApiKeyForTenant,
} from "./api-keys.js";
import { identityIdOf } from "./ids.js";
import {
  DomainConflictError,
  InvalidInputError,
  RoleForbiddenError,
} from "./errors.js";

const db = runtimeDb(5);
after(() => db.$disconnect());
const pepper = "a long server side pepper for testing only, more than 32 bytes";
const command = () => ({
  idempotencyKey: randomUUID(),
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});
async function org(label: string) {
  const actor: Actor = {
    issuer: "https://issuer.test",
    subject: uniqueSubject(label),
  };
  const created = await createActiveTenantFixture(db, actor, label, command());
  return { actor, tenantId: created.body.tenantId as string };
}
const ISSUER = "https://idp.test";
const ISSUERS = [ISSUER];
const register = (
  a: { actor: Actor; tenantId: string },
  input: { name: string; issuer: string; clientId: string; scopes: string[] },
  issuers: readonly string[] = ISSUERS,
) => registerOAuthClient(db, a.actor, a.tenantId, input, command(), issuers);
const fresh = <T extends { key?: string }>(issued: T) => {
  assert.equal(typeof issued.key, "string");
  return issued as T & { key: string };
};
const request = () => ({
  name: "integration",
  kind: "usr" as const,
  scopes: ["read:telemetry"],
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});

test("API key is tenant scoped, digest-only, and revocation denies next verify", async () => {
  const a = await org("key-a"),
    b = await org("key-b");
  const issued = fresh(
    await createApiKey(db, pepper, a.actor, a.tenantId, request(), command()),
  );
  const row = (
    await adminQuery<{ digest: Buffer; last_used_at: Date | null }>(
      "SELECT digest,last_used_at FROM api_keys WHERE key_id=$1",
      [issued.keyId],
    )
  )[0]!;
  assert.equal(row.digest.length, 32);
  assert.equal(
    row.digest.toString("hex"),
    keyDigest(KEY_PATTERN.exec(issued.key)![4]!, pepper).toString("hex"),
  );
  assert.ok(!row.digest.toString("hex").includes(issued.key));
  assert.deepEqual(
    (await verifyApiKey(db, pepper, issued.key)).tenant_id,
    a.tenantId,
  );
  const metadata = await listCredentials(db, a.actor, a.tenantId);
  assert.equal(metadata[0]?.keyId, issued.keyId);
  assert.ok(metadata[0]?.lastUsedAt instanceof Date);
  assert.ok(!JSON.stringify(metadata).includes(issued.key));
  assert.ok(!JSON.stringify(metadata).includes(row.digest.toString("hex")));
  await assert.rejects(
    verifyApiKeyForTenant(db, pepper, issued.key, b.tenantId),
    /invalid_key/,
  );
  // Change the last character to a DIFFERENT one: replacing it with a fixed "A"
  // leaves the key unchanged (and valid) whenever it already ends in "A".
  const lastChar = issued.key.slice(-1);
  await assert.rejects(
    verifyApiKey(
      db,
      pepper,
      issued.key.slice(0, -1) + (lastChar === "A" ? "B" : "A"),
    ),
    /invalid_key/,
  );
  await assert.rejects(
    createApiKey(db, pepper, b.actor, a.tenantId, request(), command()),
  );
  await revokeCredential(
    db,
    a.actor,
    a.tenantId,
    issued.principalId,
    command(),
  );
  await assert.rejects(verifyApiKey(db, pepper, issued.key), /invalid_key/);
  const events = (await outboxEvents(a.tenantId)).filter(
    (e) => e.aggregate_type === "service_principal",
  );
  assert.deepEqual(
    events.map((e) => e.event_type),
    ["service_principal.created", "service_principal.revoked"],
  );
  assert.ok(events.every((e) => validateEvent(e).ok));
});

test("rotation overlap and concurrent rotation yield one successor", async () => {
  const a = await org("rotate");
  const issued = fresh(
    await createApiKey(db, pepper, a.actor, a.tenantId, request(), command()),
  );
  const results = await Promise.allSettled([
    rotateApiKey(db, pepper, a.actor, a.tenantId, issued.keyId, command()),
    rotateApiKey(db, pepper, a.actor, a.tenantId, issued.keyId, command()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rotated = results.find(
    (r) => r.status === "fulfilled",
  ) as PromiseFulfilledResult<{ key?: string; keyId: string }>;
  assert.equal(
    (await verifyApiKey(db, pepper, issued.key)).tenant_id,
    a.tenantId,
  );
  assert.equal(
    (await verifyApiKey(db, pepper, fresh(rotated.value).key)).tenant_id,
    a.tenantId,
  );
  await revokeCredential(
    db,
    a.actor,
    a.tenantId,
    issued.principalId,
    command(),
  );
  await assert.rejects(verifyApiKey(db, pepper, issued.key), /invalid_key/);
  await assert.rejects(
    verifyApiKey(db, pepper, fresh(rotated.value).key),
    /invalid_key/,
  );
});

test("OAuth client maps to exactly one tenant and creator revocation disables credentials", async () => {
  const a = await org("oauth-a"),
    b = await org("oauth-b");
  const input = {
    name: "enterprise",
    issuer: "https://idp.test",
    clientId: uniqueSubject("client"),
    scopes: ["read:telemetry"],
  };
  const registered = await register(a, input);
  await assert.rejects(register(a, input), DomainConflictError);
  const lookup = (tenant?: string) =>
    lookupOAuthClient(db, input.issuer, input.clientId, tenant);
  assert.deepEqual(await lookup(a.tenantId), {
    tenant_id: a.tenantId,
    principal_id: registered.principalId,
    scopes: input.scopes,
  });
  // Client ids are not secret: tenant B registering A's id must not capture A's tokens.
  const claimed = await register(b, input);
  assert.deepEqual(await lookup(a.tenantId), {
    tenant_id: a.tenantId,
    principal_id: registered.principalId,
    scopes: input.scopes,
  });
  assert.equal((await lookup(b.tenantId))?.principal_id, claimed.principalId);
  assert.equal(await lookup(), undefined, "no tenant claim resolves nothing");
  assert.equal(await lookup(randomUUID()), undefined);
  const key = fresh(
    await createApiKey(db, pepper, a.actor, a.tenantId, request(), command()),
  );
  await revokeMember(
    db,
    a.actor,
    a.tenantId,
    identityIdOf(a.actor.issuer, a.actor.subject),
    1n,
    command(),
  ).catch(() => {});
  // Last-admin protection keeps this membership active; explicit principal revoke still works.
  await revokeCredential(
    db,
    a.actor,
    a.tenantId,
    registered.principalId,
    command(),
  );
  assert.equal(
    await lookupOAuthClient(db, input.issuer, input.clientId, a.tenantId),
    undefined,
  );
  assert.equal((await verifyApiKey(db, pepper, key.key)).tenant_id, a.tenantId);
});

test("removing the creator closes both credential mechanisms", async () => {
  const a = await org("creator-revoked");
  const key = fresh(
    await createApiKey(db, pepper, a.actor, a.tenantId, request(), command()),
  );
  const clientId = uniqueSubject("creator-client");
  await register(a, {
    name: "creator client",
    issuer: ISSUER,
    clientId,
    scopes: ["read:telemetry"],
  });
  await adminQuery(
    "UPDATE memberships SET state='revoked', revoked_at=clock_timestamp(),revoked_by=$2,version=version+1 WHERE tenant_id=$1 AND identity_id=$2",
    [a.tenantId, identityIdOf(a.actor.issuer, a.actor.subject)],
  );
  await assert.rejects(verifyApiKey(db, pepper, key.key), /invalid_key/);
  assert.equal(
    await lookupOAuthClient(db, ISSUER, clientId, a.tenantId),
    undefined,
  );
});
test("credential creation rejects scope escalation, invalid expiry and invalid device scope", async () => {
  const a = await org("invalid-key");
  await assert.rejects(
    createApiKey(
      db,
      pepper,
      a.actor,
      a.tenantId,
      { ...request(), scopes: ["delete:all"] },
      command(),
    ),
  );
  await assert.rejects(
    createApiKey(
      db,
      pepper,
      a.actor,
      a.tenantId,
      { ...request(), expiresAt: new Date(Date.now() - 1000).toISOString() },
      command(),
    ),
  );
  await assert.rejects(
    createApiKey(
      db,
      pepper,
      a.actor,
      a.tenantId,
      { ...request(), kind: "dev", deviceId: randomUUID() },
      command(),
    ),
  );
  await assert.rejects(
    register(a, {
      name: "bad",
      issuer: ISSUER,
      clientId: "bad",
      scopes: ["delete:all"],
    }),
  );
});
test("identical replay returns a stored safe result and never a second secret", async () => {
  const a = await org("key-replay");
  const issue = command();
  const input = request();
  const first = fresh(
    await createApiKey(db, pepper, a.actor, a.tenantId, input, issue),
  );
  const replay = await createApiKey(
    db,
    pepper,
    a.actor,
    a.tenantId,
    input,
    issue,
  );
  assert.equal(replay.keyId, first.keyId);
  assert.equal(replay.principalId, first.principalId);
  assert.equal(replay.secretAlreadyRevealed, true);
  assert.ok(!("key" in replay));
  assert.ok(first.key.startsWith(replay.keyPrefix!));
  assert.ok(!JSON.stringify(replay).includes(first.key));
  await assert.rejects(
    createApiKey(
      db,
      pepper,
      a.actor,
      a.tenantId,
      { ...input, name: "other" },
      issue,
    ),
    /Idempotency-Key/,
  );
  const rotate = command();
  const rotated = fresh(
    await rotateApiKey(db, pepper, a.actor, a.tenantId, first.keyId, rotate),
  );
  const again = await rotateApiKey(
    db,
    pepper,
    a.actor,
    a.tenantId,
    first.keyId,
    rotate,
  );
  assert.equal(again.keyId, rotated.keyId);
  assert.equal(again.secretAlreadyRevealed, true);
  assert.ok(!("key" in again));
  await assert.rejects(
    rotateApiKey(db, pepper, a.actor, a.tenantId, first.keyId, rotate, 5),
    /Idempotency-Key/,
  );
  const revoke = command();
  await revokeCredential(db, a.actor, a.tenantId, first.principalId, revoke);
  await revokeCredential(db, a.actor, a.tenantId, first.principalId, revoke);
  await assert.rejects(
    revokeCredential(db, a.actor, a.tenantId, randomUUID(), revoke),
    /Idempotency-Key/,
  );
});

test("a lost create response leaves a recoverable orphan under the free key limit", async () => {
  const a = await org("key-orphan");
  const issue = command();
  const body = request();
  // The response (and secret) is lost after the commit: the caller never sees it.
  const lost = await createApiKey(db, pepper, a.actor, a.tenantId, body, issue);
  assert.ok(lost.keyId);
  const replay = await createApiKey(
    db,
    pepper,
    a.actor,
    a.tenantId,
    body,
    issue,
  );
  assert.equal(replay.keyId, lost.keyId);
  assert.equal(replay.secretAlreadyRevealed, true);
  assert.equal(
    (
      await adminQuery("SELECT 1 FROM api_keys WHERE tenant_id=$1", [
        a.tenantId,
      ])
    ).length,
    1,
  );
  // Free plan api_keys.max = 1 blocks a new key until the orphan is revoked.
  await assert.rejects(
    createApiKey(db, pepper, a.actor, a.tenantId, request(), command()),
  );
  await revokeCredential(
    db,
    a.actor,
    a.tenantId,
    replay.principalId!,
    command(),
  );
  const recovered = fresh(
    await createApiKey(db, pepper, a.actor, a.tenantId, request(), command()),
  );
  assert.equal(
    (await verifyApiKey(db, pepper, recovered.key)).tenant_id,
    a.tenantId,
  );
});

test("a failed create leaves no receipt, key or event so the retry issues normally", async () => {
  const a = await org("key-atomic");
  const issue = command();
  await assert.rejects(
    createApiKey(
      db,
      pepper,
      a.actor,
      a.tenantId,
      { ...request(), scopes: ["export:audit", "read:telemetry", "nope:x"] },
      issue,
    ),
  );
  const receipts = await adminQuery(
    "SELECT 1 FROM command_receipts WHERE tenant_id=$1 AND idempotency_key=$2",
    [a.tenantId, issue.idempotencyKey],
  );
  assert.equal(receipts.length, 0);
  fresh(await createApiKey(db, pepper, a.actor, a.tenantId, request(), issue));
});

test("a demoted creator's key and client lose scopes the current role no longer permits", async () => {
  const a = await org("demoted");
  const key = fresh(
    await createApiKey(
      db,
      pepper,
      a.actor,
      a.tenantId,
      { ...request(), scopes: ["read:telemetry", "export:audit"] },
      command(),
    ),
  );
  const exportOnly = await register(a, {
    name: "audit client",
    issuer: ISSUER,
    clientId: uniqueSubject("demoted-client"),
    scopes: ["export:audit"],
  });
  const creator = identityIdOf(a.actor.issuer, a.actor.subject);
  assert.deepEqual((await verifyApiKey(db, pepper, key.key)).scopes.sort(), [
    "export:audit",
    "read:telemetry",
  ]);
  await adminQuery(
    "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND identity_id=$2",
    [a.tenantId, creator],
  );
  assert.deepEqual((await verifyApiKey(db, pepper, key.key)).scopes, [
    "read:telemetry",
  ]);
  const client = await adminQuery<{ client_id: string }>(
    "SELECT client_id FROM service_principals WHERE principal_id=$1",
    [exportOnly.principalId],
  );
  assert.equal(
    await lookupOAuthClient(db, ISSUER, client[0]!.client_id, a.tenantId),
    undefined,
  );
});

test("missing organization and non-member both answer role-forbidden", async () => {
  const a = await org("authz-a");
  const outsider = await org("authz-b");
  await assert.rejects(
    createApiKey(db, pepper, outsider.actor, a.tenantId, request(), command()),
    RoleForbiddenError,
  );
  await assert.rejects(
    createApiKey(db, pepper, a.actor, randomUUID(), request(), command()),
    RoleForbiddenError,
  );
});

test("OAuth registration is limited to allow-listed issuers and fails closed", async () => {
  const a = await org("issuer-allow");
  const input = {
    name: "c",
    issuer: "https://attacker.example",
    clientId: uniqueSubject("c"),
    scopes: ["read:telemetry"],
  };
  await assert.rejects(register(a, input), InvalidInputError);
  await assert.rejects(
    register(a, { ...input, issuer: ISSUER }, []),
    InvalidInputError,
  );
  await register(a, { ...input, issuer: ISSUER });
});
