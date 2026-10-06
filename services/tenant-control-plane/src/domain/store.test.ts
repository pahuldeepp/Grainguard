import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { validateEvent } from "@greenguard/contracts";
import { identityKey } from "@greenguard/membership-client";
import {
  adminQuery,
  createActiveTenantFixture,
  outboxEvents as outbox,
  ISSUER,
  runtimeDb,
  tenantRows,
  uniqueSubject,
} from "../testing/fixtures.js";
import {
  AmbiguousMembershipError,
  IdempotencyConflictError,
  InvitationEmailMismatchError,
  InvitationUnusableError,
  InvalidInputError,
  LastAdminError,
  NotFoundError,
  RoleForbiddenError,
  VersionConflictError,
} from "./errors.js";
import {
  acceptInvitation,
  changeRole,
  createOrganization,
  inviteMember,
  listMembers,
  listMembersPage,
  lookupMembership,
  revokeMember,
  type Actor,
} from "./store.js";

const db = runtimeDb(8);
after(() => db.$disconnect());

const withEmail = (
  who: Actor,
  email = `${who.subject}@example.test`,
): Actor => ({ ...who, email, emailVerified: true });
const actor = (label: string): Actor =>
  withEmail({ issuer: ISSUER, subject: uniqueSubject(label) });
const cmd = (key = randomUUID()) => ({
  idempotencyKey: key,
  correlationId: randomUUID(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});

async function orgWithAdmin(name = "Farm") {
  const admin = actor("admin");
  const created = await createActiveTenantFixture(db, admin, name, cmd());
  return { admin, tenantId: created.body.tenantId as string };
}

async function member(
  tenantId: string,
  admin: Actor,
  role: "viewer" | "operator" | "admin",
) {
  const who = actor(role);
  const invite = await inviteMember(
    db,
    admin,
    tenantId,
    { email: `${who.subject}@example.test`, role },
    cmd(),
  );
  const accepted = await acceptInvitation(
    db,
    who,
    { token: invite.body.token as string },
    cmd(),
  );
  return {
    who,
    identityId: accepted.body.identityId as string,
    version: accepted.body.version as string,
  };
}

test("creating an organization persists provisioning without exposing tenant membership before owner bootstrap", async () => {
  const admin = actor("founder");
  const command = cmd();
  const first = await createOrganization(
    db,
    admin,
    { name: "North farm" },
    command,
  );
  assert.equal(first.status, 202);
  assert.equal(first.body.state, "provisioning");
  const tenantId = first.body.tenantId as string;
  const replay = await createOrganization(
    db,
    admin,
    { name: "North farm" },
    command,
  );
  assert.deepEqual(replay, { ...first, status: 200 });
  await assert.rejects(
    createOrganization(db, admin, { name: "Other" }, command),
    IdempotencyConflictError,
  );
  const events = await outbox(tenantId);
  assert.deepEqual(events, []);
  for (const event of events)
    assert.deepEqual(validateEvent(event), { ok: true, event });
  assert.equal((await tenantRows("membership_events", tenantId)).length, 1);
  assert.equal((await tenantRows("memberships", tenantId)).length, 0);
  assert.equal(await lookupMembership(db, admin.issuer, admin.subject), null);
  const [organization] = await tenantRows("organizations", tenantId);
  assert.equal(organization.state, "provisioning");
});

test("M02: replaying an invitation token gives one membership; another identity cannot reuse it", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const joiner = actor("joiner");
  const invite = await inviteMember(
    db,
    admin,
    tenantId,
    { email: `${joiner.subject.toUpperCase()}@Example.test`, role: "operator" },
    cmd(),
  );
  assert.equal(invite.status, 201);
  const token = invite.body.token as string;
  const results = await Promise.all([
    acceptInvitation(db, joiner, { token }, cmd()),
    acceptInvitation(db, joiner, { token }, cmd()),
  ]);
  assert.equal(results[0].body.identityId, results[1].body.identityId);
  assert.equal(results[0].body.role, "operator");
  await assert.rejects(
    acceptInvitation(db, actor("thief"), { token }, cmd()),
    InvitationUnusableError,
  );
  const reusedKey = cmd();
  const first = actor("first");
  const oneUseInvite = await inviteMember(
    db,
    admin,
    tenantId,
    { email: `${first.subject}@example.test`, role: "viewer" },
    cmd(),
  );
  const oneUseToken = oneUseInvite.body.token as string;
  await acceptInvitation(db, first, { token: oneUseToken }, reusedKey);
  await assert.rejects(
    acceptInvitation(db, actor("second"), { token: oneUseToken }, reusedKey),
    IdempotencyConflictError,
  );
  const members = await tenantRows("memberships", tenantId);
  assert.equal(members.length, 3);
  const grants = (await outbox(tenantId)).filter(
    (e) => e.event_type === "membership.changed",
  );
  assert.equal(grants.length, 3);
  const [invitation] = await tenantRows("invitations", tenantId);
  assert.equal(invitation?.token_digest === token, false);
  assert.equal(String(invitation?.email_hash).includes("@"), false);
});

test("M03: expired, malformed and wrong-tenant tokens are rejected", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const invite = await inviteMember(
    db,
    admin,
    tenantId,
    { email: "late@example.test", role: "viewer" },
    cmd(),
  );
  const token = invite.body.token as string;
  const other = await orgWithAdmin();
  const moved = `${other.tenantId}.${token.split(".")[1]}`;
  await assert.rejects(
    acceptInvitation(db, actor("x"), { token: moved }, cmd()),
    InvitationUnusableError,
  );
  await assert.rejects(
    acceptInvitation(db, actor("x"), { token: "garbage" }, cmd()),
    InvitationUnusableError,
  );
  await adminQuery(
    `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE tenant_id = $1`,
    [tenantId],
  );
  await assert.rejects(
    acceptInvitation(db, actor("x"), { token }, cmd()),
    InvitationUnusableError,
  );
});

test("M01: only active admins manage members and other tenants look absent", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const viewer = await member(tenantId, admin, "viewer");
  await assert.rejects(
    inviteMember(
      db,
      viewer.who,
      tenantId,
      { email: "v@example.test", role: "viewer" },
      cmd(),
    ),
    RoleForbiddenError,
  );
  assert.equal((await listMembers(db, viewer.who, tenantId)).length, 2);
  const outsider = await orgWithAdmin();
  await assert.rejects(
    listMembers(db, outsider.admin, tenantId),
    NotFoundError,
  );
  await assert.rejects(
    changeRole(
      db,
      outsider.admin,
      tenantId,
      viewer.identityId,
      { role: "admin" },
      1n,
      cmd(),
    ),
    NotFoundError,
  );
});

test("member listing uses a bounded keyset cursor without repeats", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  await member(tenantId, admin, "viewer");
  await member(tenantId, admin, "operator");
  const first = await listMembersPage(db, admin, tenantId, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await listMembersPage(db, admin, tenantId, {
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((m) => m.identityId)).size,
    3,
  );
  await assert.rejects(
    listMembersPage(db, admin, tenantId, { limit: 101 }),
    InvalidInputError,
  );
  await assert.rejects(
    listMembersPage(db, admin, tenantId, { cursor: "bad" }),
    InvalidInputError,
  );
});

test("concurrent role changes on one version: exactly one wins, the other gets a version conflict", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const target = await member(tenantId, admin, "viewer");
  const version = BigInt(target.version);
  const outcomes = await Promise.allSettled([
    changeRole(
      db,
      admin,
      tenantId,
      target.identityId,
      { role: "operator" },
      version,
      cmd(),
    ),
    changeRole(
      db,
      admin,
      tenantId,
      target.identityId,
      { role: "admin" },
      version,
      cmd(),
    ),
  ]);
  const won = outcomes.filter((o) => o.status === "fulfilled");
  const lost = outcomes.filter((o) => o.status === "rejected");
  assert.equal(won.length, 1);
  assert.ok(
    lost[0]?.status === "rejected" &&
      lost[0].reason instanceof VersionConflictError,
  );
  assert.equal(
    (lost[0] as PromiseRejectedResult).reason.currentVersion,
    version + 1n,
  );
  const audits = await adminQuery(
    `SELECT action FROM membership_events WHERE tenant_id = $1 AND action = 'role_changed'`,
    [tenantId],
  );
  assert.equal(audits.length, 1);
});

test("M04: the last admin cannot be demoted or removed, and concurrent removals leave one admin", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const [self] = await listMembers(db, admin, tenantId);
  await assert.rejects(
    changeRole(
      db,
      admin,
      tenantId,
      self!.identityId,
      { role: "viewer" },
      BigInt(self!.version),
      cmd(),
    ),
    LastAdminError,
  );
  const second = await member(tenantId, admin, "admin");
  const outcomes = await Promise.allSettled([
    revokeMember(
      db,
      admin,
      tenantId,
      second.identityId,
      BigInt(second.version),
      cmd(),
    ),
    revokeMember(
      db,
      second.who,
      tenantId,
      self!.identityId,
      BigInt(self!.version),
      cmd(),
    ),
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const admins = await adminQuery(
    `SELECT 1 FROM memberships WHERE tenant_id = $1 AND role = 'admin' AND state = 'active'`,
    [tenantId],
  );
  assert.equal(admins.length, 1);
});

test("lookup maps an identity to its one active membership and forgets it after revocation", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const op = await member(tenantId, admin, "operator");
  assert.deepEqual(await lookupMembership(db, op.who.issuer, op.who.subject), {
    tenantId,
    roles: ["operator"],
    version: op.version,
    state: "active",
  });
  const revoked = await revokeMember(
    db,
    admin,
    tenantId,
    op.identityId,
    BigInt(op.version),
    cmd(),
  );
  assert.equal(revoked.body.state, "revoked");
  const version = String(BigInt(op.version) + 1n);
  assert.deepEqual(await lookupMembership(db, op.who.issuer, op.who.subject), {
    tenantId,
    roles: [],
    version,
    state: "revoked",
  });
  const [row] = await adminQuery<{
    revoked_at: Date | null;
    revoked_by: string;
  }>(
    `SELECT revoked_at, revoked_by::text FROM memberships WHERE tenant_id = $1 AND identity_id = $2`,
    [tenantId, op.identityId],
  );
  assert.ok(row?.revoked_at instanceof Date);
  assert.equal(row?.revoked_by, identityKey(admin.issuer, admin.subject));
  const [revocation] = (await outbox(tenantId)).filter(
    (e) => e.payload.action === "revoked",
  );
  assert.equal(revocation?.payload.state, "revoked");
  assert.equal(revocation?.payload.membership_version, version);
  assert.deepEqual(validateEvent(revocation), { ok: true, event: revocation });
  assert.equal(await lookupMembership(db, ISSUER, "nobody-at-all"), null);
});

test("a fresh invitation reactivates a revoked membership at the next version and clears revocation metadata", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const old = await member(tenantId, admin, "viewer");
  await revokeMember(
    db,
    admin,
    tenantId,
    old.identityId,
    BigInt(old.version),
    cmd(),
  );
  const invitation = await inviteMember(
    db,
    admin,
    tenantId,
    { email: `${old.who.subject}@example.test`, role: "operator" },
    cmd(),
  );
  const accepted = await acceptInvitation(
    db,
    old.who,
    { token: invitation.body.token as string },
    cmd(),
  );
  assert.equal(accepted.body.state, "active");
  assert.equal(accepted.body.version, "3");
  assert.equal(accepted.body.role, "operator");
  assert.equal(accepted.body.revokedAt, null);
  assert.equal(accepted.body.revokedBy, null);
  const [row] = await adminQuery<{
    revoked_at: Date | null;
    revoked_by: string | null;
  }>(
    `SELECT revoked_at, revoked_by::text FROM memberships WHERE tenant_id = $1 AND identity_id = $2`,
    [tenantId, old.identityId],
  );
  assert.equal(row?.revoked_at, null);
  assert.equal(row?.revoked_by, null);
  const changes = (await outbox(tenantId)).filter(
    (e) => e.payload.identity_id === old.identityId,
  );
  assert.deepEqual(
    changes.map((e) => e.aggregate_version),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    changes.map((e) => e.payload.action),
    ["accepted", "revoked", "accepted"],
  );
});

test("an identity with active memberships in two tenants is ambiguous and never guessed", async () => {
  const a = await orgWithAdmin();
  const b = await orgWithAdmin();
  const both = actor("both");
  for (const org of [a, b]) {
    const invite = await inviteMember(
      db,
      org.admin,
      org.tenantId,
      { email: `${both.subject}@example.test`, role: "viewer" },
      cmd(),
    );
    await acceptInvitation(
      db,
      both,
      { token: invite.body.token as string },
      cmd(),
    );
  }
  await assert.rejects(
    lookupMembership(db, both.issuer, both.subject),
    AmbiguousMembershipError,
  );
});

test("M20: a forwarded invitation token is bound to the invited verified email", async () => {
  const { admin, tenantId } = await orgWithAdmin();
  const invitee = actor("invitee");
  const invite = await inviteMember(
    db,
    admin,
    tenantId,
    { email: `${invitee.subject}@Example.test`, role: "admin" },
    cmd(),
  );
  const token = invite.body.token as string;
  const thief = actor("forwarded");
  const rejected = [
    { ...thief, email: undefined, emailVerified: undefined },
    thief,
    withEmail(thief, "someone-else@example.test"),
    { ...withEmail(invitee), emailVerified: false },
  ];
  for (const who of rejected)
    await assert.rejects(
      acceptInvitation(db, who, { token }, cmd()),
      InvitationEmailMismatchError,
    );
  assert.equal(await lookupMembership(db, thief.issuer, thief.subject), null);
  const accepted = await acceptInvitation(
    db,
    withEmail(invitee),
    { token },
    cmd(),
  );
  assert.equal(accepted.body.role, "admin");
});
