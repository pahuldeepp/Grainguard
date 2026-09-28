import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createMembershipCache,
  createMembershipVerifier,
  httpMembershipFetcher,
  membershipChangedHandler,
} from "@greenguard/membership-client";
import { validateEvent } from "@greenguard/contracts";
import { AuthError } from "@greenguard/tenant-auth";
import { LOOKUP_TOKEN, startApi } from "../testing/api.js";
import { outboxEvents } from "../testing/fixtures.js";

let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(() => api.close());

const key = () => ({ "idempotency-key": randomUUID() });

async function organization(
  label: string,
  claims: Record<string, unknown> = {},
) {
  const admin = await api.person(label, claims);
  const res = await api.call("POST", "/v1/organizations", {
    token: admin.token,
    body: { name: `${label} farm` },
    headers: key(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { admin, tenantId: res.json.tenantId as string };
}

async function join(tenantId: string, adminToken: string, role: string) {
  const who = await api.person(role);
  const invite = await api.call(
    "POST",
    `/v1/organizations/${tenantId}/invitations`,
    {
      token: adminToken,
      body: { email: `${who.subject}@example.test`, role },
      headers: key(),
    },
  );
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  const accepted = await api.call("POST", "/v1/invitations/accept", {
    token: who.token,
    body: { token: invite.json.token },
    headers: key(),
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
  return { who, member: accepted.json };
}

test("health probes answer without a token", async () => {
  assert.equal((await api.call("GET", "/healthz")).status, 200);
  assert.equal((await api.call("GET", "/readyz")).status, 200);
});

test("M08: IdP-asserted tenant and roles are ignored; the store decides", async () => {
  const victim = await organization("victim");
  const attacker = await api.person("attacker", {
    tenant_id: victim.tenantId,
    roles: ["admin"],
  });
  const res = await api.call(
    "GET",
    `/v1/organizations/${victim.tenantId}/members`,
    {
      token: attacker.token,
    },
  );
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
});

test("M01: an admin of tenant B cannot list or change tenant A over HTTP", async () => {
  const a = await organization("tenant-a");
  const b = await organization("tenant-b");
  const { member } = await join(a.tenantId, a.admin.token, "viewer");
  const list = await api.call(
    "GET",
    `/v1/organizations/${a.tenantId}/members`,
    { token: b.admin.token },
  );
  assert.equal(list.status, 404);
  const patch = await api.call(
    "PATCH",
    `/v1/organizations/${a.tenantId}/members/${member.identityId}`,
    {
      token: b.admin.token,
      body: { role: "admin" },
      headers: { ...key(), "if-match": `"${member.version}"` },
    },
  );
  assert.equal(patch.status, 404);
  const own = await api.call("GET", `/v1/organizations/${a.tenantId}/members`, {
    token: a.admin.token,
  });
  assert.equal(own.status, 200);
  assert.equal(own.json.items?.length, 2);
});

test("role change needs If-Match: missing 428, stale 412 with ETag, current 200", async () => {
  const a = await organization("etag");
  const { member } = await join(a.tenantId, a.admin.token, "viewer");
  const path = `/v1/organizations/${a.tenantId}/members/${member.identityId}`;
  const missing = await api.call("PATCH", path, {
    token: a.admin.token,
    body: { role: "operator" },
    headers: key(),
  });
  assert.equal(missing.status, 428);
  const ok = await api.call("PATCH", path, {
    token: a.admin.token,
    body: { role: "operator" },
    headers: { ...key(), "if-match": `"${member.version}"` },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.role, "operator");
  assert.equal(ok.headers.get("etag"), `"${ok.json.version}"`);
  const stale = await api.call("PATCH", path, {
    token: a.admin.token,
    body: { role: "admin" },
    headers: { ...key(), "if-match": `"${member.version}"` },
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.headers.get("etag"), `"${ok.json.version}"`);
});

test("requests are validated: no key 400, unknown body field 400, bad token 401, viewer 403, last admin 409", async () => {
  const a = await organization("validation");
  const noKey = await api.call("POST", "/v1/organizations", {
    token: a.admin.token,
    body: { name: "x" },
  });
  assert.equal(noKey.status, 400);
  const smuggled = await api.call(
    "POST",
    `/v1/organizations/${a.tenantId}/invitations`,
    {
      token: a.admin.token,
      body: { email: "e@example.test", role: "viewer", tenantId: randomUUID() },
      headers: key(),
    },
  );
  assert.equal(smuggled.status, 400);
  const deviceRole = await api.call(
    "POST",
    `/v1/organizations/${a.tenantId}/invitations`,
    {
      token: a.admin.token,
      body: { email: "e@example.test", role: "device" },
      headers: key(),
    },
  );
  assert.equal(deviceRole.status, 400);
  const anonymous = await api.call(
    "GET",
    `/v1/organizations/${a.tenantId}/members`,
  );
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
  const { who } = await join(a.tenantId, a.admin.token, "viewer");
  const forbidden = await api.call(
    "POST",
    `/v1/organizations/${a.tenantId}/invitations`,
    {
      token: who.token,
      body: { email: "e@example.test", role: "viewer" },
      headers: key(),
    },
  );
  assert.equal(forbidden.status, 403);
  const members = await api.call(
    "GET",
    `/v1/organizations/${a.tenantId}/members`,
    { token: a.admin.token },
  );
  const self = members.json.items?.find((m) => m.subject === a.admin.subject);
  const lastAdmin = await api.call(
    "POST",
    `/v1/organizations/${a.tenantId}/members/${self?.identityId}/revoke`,
    {
      token: a.admin.token,
      headers: { ...key(), "if-match": `"${self?.version}"` },
    },
  );
  assert.equal(lastAdmin.status, 409);
  assert.equal(lastAdmin.json.code, "last_admin");
  const reused = await api.call("POST", "/v1/invitations/accept", {
    token: who.token,
    body: { token: `${a.tenantId}.bogus` },
    headers: key(),
  });
  assert.equal(reused.status, 410);
});

test("the internal lookup needs the service credential and answers 200 or 404", async () => {
  const a = await organization("lookup");
  const path = `/v1/internal/memberships?issuer=${encodeURIComponent(api.issuer.issuer)}&subject=${encodeURIComponent(a.admin.subject)}`;
  assert.equal((await api.call("GET", path)).status, 401);
  assert.equal((await api.call("GET", path, { token: "wrong" })).status, 401);
  const found = await api.call("GET", path, { token: LOOKUP_TOKEN });
  assert.deepEqual(found.json, {
    tenantId: a.tenantId,
    roles: ["admin"],
    version: "1",
    state: "active",
  });
  const missing = await api.call(
    "GET",
    `/v1/internal/memberships?issuer=x&subject=nobody`,
    { token: LOOKUP_TOKEN },
  );
  assert.equal(missing.status, 404);
  assert.equal(
    (await api.call("GET", "/v1/internal/memberships", { token: LOOKUP_TOKEN }))
      .status,
    400,
  );
});

test("M05/M06: revoke -> outbox event -> cache entry gone -> next request 403, measured; without the event denied at the TTL", async () => {
  const a = await organization("revocation");
  const { who, member } = await join(a.tenantId, a.admin.token, "operator");
  let now = 0;
  const cache = createMembershipCache({
    fetch: httpMembershipFetcher({ baseUrl: api.baseUrl, token: LOOKUP_TOKEN }),
    now: () => now,
  });
  const verifier = createMembershipVerifier(
    {
      issuer: api.issuer.issuer,
      audience: api.issuer.audience,
      keys: { getKey: api.issuer.getKey },
    },
    cache,
  );
  const revoke = (m: Record<string, unknown>) =>
    api.call(
      "POST",
      `/v1/organizations/${a.tenantId}/members/${m.identityId}/revoke`,
      {
        token: a.admin.token,
        headers: { ...key(), "if-match": `"${m.version}"` },
      },
    );
  const forbidden = (error: unknown) =>
    error instanceof AuthError && error.status === 403;
  // Consumer down: the cached grant survives until the 30 s TTL, never longer.
  const bearer = `Bearer ${who.token}`;
  assert.equal((await verifier.verify(bearer)).tenantId, a.tenantId);
  assert.equal((await revoke(member)).status, 200);
  now += 29_999;
  assert.equal((await verifier.verify(bearer)).tenantId, a.tenantId);
  now += 1;
  await assert.rejects(verifier.verify(bearer), forbidden);
  // Event path: the committed outbox row, validated against the contract, drops the
  // entry; the next request reloads and is denied.
  const again = await join(a.tenantId, a.admin.token, "viewer");
  const bearer2 = `Bearer ${again.who.token}`;
  await verifier.verify(bearer2);
  const started = performance.now();
  assert.equal((await revoke(again.member)).status, 200);
  const events = await outboxEvents(a.tenantId);
  const revocation = events.find(
    (e) =>
      e.payload.action === "revoked" &&
      e.payload.identity_id === again.member.identityId,
  );
  assert.ok(revocation && validateEvent(revocation).ok);
  const apply = membershipChangedHandler(cache);
  apply(revocation);
  await assert.rejects(verifier.verify(bearer2), forbidden);
  const elapsed = performance.now() - started;
  // Replaying the grant (older version) afterwards cannot resurrect the member.
  const grant = events.find(
    (e) =>
      e.payload.action === "accepted" &&
      e.payload.identity_id === again.member.identityId,
  );
  assert.ok(grant);
  apply(grant);
  apply(revocation);
  await assert.rejects(verifier.verify(bearer2), forbidden);
  console.log(
    `revocation-to-403-ms(outbox read + apply + verify)=${elapsed.toFixed(1)}`,
  );
});
