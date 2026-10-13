import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { AuthError } from "@greenguard/tenant-auth";
import { validateEvent } from "@greenguard/contracts";
import {
  adminQuery,
  createActiveTenantFixture,
  outboxEvents,
  runtimeDb,
  uniqueSubject,
} from "../testing/fixtures.js";
import { SeatLimitError } from "./entitlements.js";
import { identityIdOf } from "./ids.js";
import { lookupMembership, type Actor } from "./store.js";
import { DomainConflictError } from "./errors.js";
import {
  createIdentityConnection,
  discoverIdentityConnection,
  jitMembership,
  releaseIdentityDomain,
  reverifyIdentityDomain,
  setConnectionJit,
} from "./identity-connections.js";

const db = runtimeDb();
after(() => db.$disconnect());
const cmd = () => ({
  idempotencyKey: randomUUID(),
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});
const domain = () => `${uniqueSubject("sso")}.example.test`;
async function setup() {
  const admin: Actor = {
    issuer: "https://first.example/dex",
    subject: uniqueSubject("sso-admin"),
  };
  const result = await createActiveTenantFixture(db, admin, "SSO test", cmd());
  return { admin, tenantId: result.body.tenantId as string };
}
const verified = async () => true;

test("S04/S05: JIT off rejects unknown identity; verified domain with JIT on grants viewer", async () => {
  const { admin, tenantId } = await setup();
  const name = domain();
  const issuer = "https://enterprise.example/dex";
  const connection = await createIdentityConnection(
    db,
    admin,
    tenantId,
    { issuer, type: "oidc", domains: [name], jitEnabled: false },
    verified,
    cmd(),
  );
  const connectionEvents = (await outboxEvents(tenantId)).filter(
    (e) => e.event_type === "identity_connection.changed",
  );
  assert.equal(connectionEvents.length, 1);
  assert.deepEqual(validateEvent(connectionEvents[0]!), {
    ok: true,
    event: connectionEvents[0]!,
  });
  assert.deepEqual(await discoverIdentityConnection(db, `user@${name}`), {
    issuer,
    type: "oidc",
  });
  const user: Actor = {
    issuer,
    subject: uniqueSubject("jit"),
    email: `user@${name}`,
    emailVerified: true,
  };
  await assert.rejects(
    jitMembership(db, user, cmd()),
    (error: unknown) =>
      error instanceof AuthError && error.code === "invalid_claims",
  );
  await setConnectionJit(
    db,
    admin,
    tenantId,
    connection.connectionId,
    true,
    1n,
    cmd(),
  );
  const member = await jitMembership(db, user, cmd());
  assert.equal(member.tenantId, tenantId);
  assert.deepEqual(member.roles, ["viewer"]);
  assert.deepEqual((await lookupMembership(db, issuer, user.subject))?.roles, [
    "viewer",
  ]);
});

test("S06: unverified domain and unverified email cannot grant JIT", async () => {
  const { admin, tenantId } = await setup();
  const name = domain();
  await assert.rejects(
    createIdentityConnection(
      db,
      admin,
      tenantId,
      {
        issuer: "https://unverified.example/dex",
        type: "saml",
        domains: [name],
        jitEnabled: true,
      },
      async () => false,
      cmd(),
    ),
    /domain verification failed/,
  );
  const user: Actor = {
    issuer: "https://unverified.example/dex",
    subject: uniqueSubject("jit"),
    email: `user@${name}`,
    emailVerified: false,
  };
  await assert.rejects(jitMembership(db, user, cmd()), AuthError);
});

test("S07: a connection for A cannot grant membership in B", async () => {
  const a = await setup();
  const b = await setup();
  const name = domain();
  const issuer = "https://tenant-a.example/dex";
  await createIdentityConnection(
    db,
    a.admin,
    a.tenantId,
    { issuer, type: "oidc", domains: [name], jitEnabled: true },
    verified,
    cmd(),
  );
  const user: Actor = {
    issuer,
    subject: uniqueSubject("jit"),
    email: `user@${name}`,
    emailVerified: true,
  };
  const member = await jitMembership(db, user, cmd());
  assert.equal(member.tenantId, a.tenantId);
  assert.notEqual(member.tenantId, b.tenantId);
  assert.equal(
    (await lookupMembership(db, issuer, user.subject))?.tenantId,
    a.tenantId,
  );
  await assert.rejects(
    createIdentityConnection(
      db,
      b.admin,
      b.tenantId,
      {
        issuer: "https://tenant-b.example/dex",
        type: "oidc",
        domains: [name],
        jitEnabled: true,
      },
      verified,
      cmd(),
    ),
    DomainConflictError,
  );
});

const ISSUER_A = "https://expiry-a.example/dex";
const ISSUER_B = "https://expiry-b.example/dex";
const expire = (name: string) =>
  adminQuery(
    "UPDATE identity_connection_domains SET verified_until = now() - interval '1 second' WHERE domain = $1",
    [name],
  );
const jitUser = (issuer: string, name: string): Actor => ({
  issuer,
  subject: uniqueSubject("jit"),
  email: `user@${name}`,
  emailVerified: true,
});
const denied = (error: unknown) =>
  error instanceof AuthError && error.code === "invalid_claims";
async function claimed(issuer = ISSUER_A) {
  const t = await setup();
  const name = domain();
  const connection = await createIdentityConnection(
    db,
    t.admin,
    t.tenantId,
    { issuer, type: "oidc", domains: [name], jitEnabled: true },
    verified,
    cmd(),
  );
  return { ...t, name, connection };
}

test("DX1: an expired domain claim stops JIT and discovery", async () => {
  const a = await claimed();
  assert.ok(await discoverIdentityConnection(db, `u@${a.name}`));
  await expire(a.name);
  await assert.rejects(
    jitMembership(db, jitUser(ISSUER_A, a.name), cmd()),
    denied,
  );
  assert.equal(await discoverIdentityConnection(db, `u@${a.name}`), null);
});

test("DX2: re-verification extends the claim; a failed re-check leaves it expired", async () => {
  const a = await claimed();
  await expire(a.name);
  await assert.rejects(
    reverifyIdentityDomain(
      db,
      a.admin,
      a.tenantId,
      a.connection.connectionId,
      a.name,
      async () => false,
    ),
    /domain verification failed/,
  );
  await assert.rejects(
    jitMembership(db, jitUser(ISSUER_A, a.name), cmd()),
    denied,
  );
  await reverifyIdentityDomain(
    db,
    a.admin,
    a.tenantId,
    a.connection.connectionId,
    a.name,
    verified,
  );
  const member = await jitMembership(db, jitUser(ISSUER_A, a.name), cmd());
  assert.equal(member.tenantId, a.tenantId);
});

test("DX3: another tenant can claim an expired domain; the old owner loses JIT", async () => {
  const a = await claimed();
  const b = await setup();
  await assert.rejects(
    createIdentityConnection(
      db,
      b.admin,
      b.tenantId,
      { issuer: ISSUER_B, type: "oidc", domains: [a.name], jitEnabled: true },
      verified,
      cmd(),
    ),
  );
  await expire(a.name);
  await createIdentityConnection(
    db,
    b.admin,
    b.tenantId,
    { issuer: ISSUER_B, type: "oidc", domains: [a.name], jitEnabled: true },
    verified,
    cmd(),
  );
  assert.equal(
    (await jitMembership(db, jitUser(ISSUER_B, a.name), cmd())).tenantId,
    b.tenantId,
  );
  await assert.rejects(
    jitMembership(db, jitUser(ISSUER_A, a.name), cmd()),
    denied,
  );
  await assert.rejects(
    reverifyIdentityDomain(
      db,
      a.admin,
      a.tenantId,
      a.connection.connectionId,
      a.name,
      verified,
    ),
  );
});

test("DX4: release is admin-of-owner only, then another tenant can claim", async () => {
  const a = await claimed();
  const b = await setup();
  await assert.rejects(
    releaseIdentityDomain(
      db,
      b.admin,
      b.tenantId,
      a.connection.connectionId,
      a.name,
      cmd(),
    ),
  );
  await assert.rejects(
    releaseIdentityDomain(
      db,
      b.admin,
      a.tenantId,
      a.connection.connectionId,
      a.name,
      cmd(),
    ),
  );
  assert.ok(await discoverIdentityConnection(db, `u@${a.name}`));
  await releaseIdentityDomain(
    db,
    a.admin,
    a.tenantId,
    a.connection.connectionId,
    a.name,
    cmd(),
  );
  await assert.rejects(
    jitMembership(db, jitUser(ISSUER_A, a.name), cmd()),
    denied,
  );
  await createIdentityConnection(
    db,
    b.admin,
    b.tenantId,
    { issuer: ISSUER_B, type: "oidc", domains: [a.name], jitEnabled: true },
    verified,
    cmd(),
  );
  assert.equal(
    (await jitMembership(db, jitUser(ISSUER_B, a.name), cmd())).tenantId,
    b.tenantId,
  );
});

test("DX5: JIT membership enforces seats.max (default 3 seats: admin plus two)", async () => {
  const a = await claimed();
  for (let seat = 0; seat < 2; seat++)
    await jitMembership(db, jitUser(ISSUER_A, a.name), cmd());
  const user = jitUser(ISSUER_A, a.name);
  const deniedCommand = cmd();
  await assert.rejects(jitMembership(db, user, deniedCommand), SeatLimitError);
  assert.equal(await lookupMembership(db, user.issuer, user.subject), null);
  const denial = await adminQuery<{
    action: string;
    identity_id: string | null;
    actor_identity_id: string;
    correlation_id: string;
  }>(
    `SELECT action, identity_id::text, actor_identity_id::text, correlation_id::text
       FROM membership_events WHERE tenant_id=$1 AND correlation_id=$2`,
    [a.tenantId, deniedCommand.correlationId],
  );
  assert.deepEqual(denial, [
    {
      action: "jit_seat_limit_denied",
      identity_id: null,
      actor_identity_id: identityIdOf(user.issuer, user.subject),
      correlation_id: deniedCommand.correlationId,
    },
  ]);
});

test("DX6: concurrent JIT grants through different connections cannot exceed seats.max", async () => {
  const { admin, tenantId } = await setup();
  const firstDomain = domain();
  const secondDomain = domain();
  const firstIssuer = "https://concurrent-first.example/dex";
  const secondIssuer = "https://concurrent-second.example/dex";
  await createIdentityConnection(
    db,
    admin,
    tenantId,
    {
      issuer: firstIssuer,
      type: "oidc",
      domains: [firstDomain],
      jitEnabled: true,
    },
    verified,
    cmd(),
  );
  await createIdentityConnection(
    db,
    admin,
    tenantId,
    {
      issuer: secondIssuer,
      type: "oidc",
      domains: [secondDomain],
      jitEnabled: true,
    },
    verified,
    cmd(),
  );
  await jitMembership(db, jitUser(firstIssuer, firstDomain), cmd());
  const users = [
    jitUser(firstIssuer, firstDomain),
    jitUser(secondIssuer, secondDomain),
  ];
  const results = await Promise.allSettled(
    users.map((user) => jitMembership(db, user, cmd())),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" && result.reason instanceof SeatLimitError,
    ).length,
    1,
  );
  const [{ n }] = await adminQuery<{ n: string }>(
    "SELECT count(*)::text AS n FROM memberships WHERE tenant_id=$1 AND state='active'",
    [tenantId],
  );
  assert.equal(n, "3");
});

test("DX7: concurrent JIT for one identity returns the persisted membership", async () => {
  const a = await claimed();
  const user = jitUser(ISSUER_A, a.name);
  const results = await Promise.all([
    jitMembership(db, user, cmd()),
    jitMembership(db, user, cmd()),
  ]);
  assert.deepEqual(
    results.map((result) => result.roles),
    [["viewer"], ["viewer"]],
  );
  assert.deepEqual(
    (await lookupMembership(db, user.issuer, user.subject))?.roles,
    ["viewer"],
  );
});
