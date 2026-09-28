import { assertSeatCapacity } from "./entitlements.js";
import { randomBytes } from "node:crypto";
import { suggestInitialShard } from "@greenguard/membership-client";
import { PlacementUnavailableError } from "./placement.js";
import type { Db, Tx } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import {
  AmbiguousMembershipError,
  IdempotencyConflictError,
  InvalidInputError,
  InvitationEmailMismatchError,
  InvitationUnusableError,
  LastAdminError,
  NotFoundError,
  RoleForbiddenError,
  VersionConflictError,
} from "./errors.js";
import { identityIdOf, nameId, sha256Hex } from "./ids.js";
import { appendEvent, type Command } from "./outbox.js";

export type { Command } from "./outbox.js";

export interface Actor {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
}
export type HumanRole = "viewer" | "operator" | "admin";
export interface Result {
  status: number;
  body: Record<string, unknown>;
}
export interface MemberDto {
  identityId: string;
  issuer: string;
  subject: string;
  role: string;
  state: string;
  version: string;
  revokedAt: string | null;
  revokedBy: string | null;
}
interface MemberRow {
  identity_id: string;
  issuer: string;
  subject: string;
  role: string;
  state: string;
  version: bigint;
  revoked_at: Date | null;
  revoked_by: string | null;
  updated_at: Date;
}
type Change = "granted" | "accepted" | "role_changed" | "revoked";

const INVITATION_HOURS = 72;
const ADMIN = "admin";
const ACTIVE = "active";

const canonical = (value: unknown) =>
  JSON.stringify(
    value,
    Object.keys(value as object).sort((a, b) => Number(a > b) - Number(a < b)),
  );

export const toDto = (row: MemberRow): MemberDto => ({
  identityId: row.identity_id,
  issuer: row.issuer,
  subject: row.subject,
  role: row.role,
  state: row.state,
  version: row.version.toString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
  revokedBy: row.revoked_by,
});

// ---- idempotency receipts (one per tenant, command type and Idempotency-Key) ----

async function replayed(
  tx: Tx,
  tenantId: string,
  type: string,
  cmd: Command,
  request: object,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}|${type}|${cmd.idempotencyKey}`}, 0))`;
  const [receipt] = await tx.$queryRaw<
    { normalized_request: object; response_body: Record<string, unknown> }[]
  >`
    SELECT normalized_request, response_body FROM command_receipts
     WHERE tenant_id = ${tenantId}::uuid AND command_type = ${type} AND idempotency_key = ${cmd.idempotencyKey}`;
  if (!receipt) return undefined;
  if (canonical(receipt.normalized_request) !== canonical(request))
    throw new IdempotencyConflictError();
  return { status: 200, body: receipt.response_body };
}

async function remember(
  tx: Tx,
  tenantId: string,
  type: string,
  cmd: Command,
  request: object,
  body: object,
) {
  await tx.$executeRaw`INSERT INTO command_receipts (tenant_id, command_type, idempotency_key, normalized_request, response_body)
    VALUES (${tenantId}::uuid, ${type}, ${cmd.idempotencyKey}, ${JSON.stringify(request)}::jsonb, ${JSON.stringify(body)}::jsonb)`;
}

// Runs a command once per key: a replay with the same request returns the stored
// response, a different request under the same key is a conflict.
export async function once(
  tx: Tx,
  tenantId: string,
  type: string,
  cmd: Command,
  request: object,
  work: () => Promise<Result>,
): Promise<Result> {
  const previous = await replayed(tx, tenantId, type, cmd, request);
  if (previous) return previous;
  const result = await work();
  // The invitation token is shown once and never stored in a receipt.
  const stored = { ...result.body };
  delete stored.token;
  await remember(tx, tenantId, type, cmd, request, stored);
  return result;
}

// ---- authorization: the verified identity's active membership in this tenant ----

async function ensureIdentity(tx: Tx, actor: Actor): Promise<string> {
  const identityId = identityIdOf(actor.issuer, actor.subject);
  await tx.$executeRaw`INSERT INTO identities (identity_id, issuer, subject)
    VALUES (${identityId}::uuid, ${actor.issuer}, ${actor.subject}) ON CONFLICT DO NOTHING`;
  return identityId;
}

// Lock order (ADR-0017): organization row first, then memberships.
async function lockOrganization(tx: Tx, tenantId: string): Promise<void> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM organizations WHERE tenant_id = ${tenantId}::uuid AND state = 'active' FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError();
}

async function actorRole(
  tx: Tx,
  tenantId: string,
  actor: Actor,
): Promise<string> {
  const [row] = await tx.$queryRaw<{ role: string }[]>`
    SELECT role FROM memberships WHERE tenant_id = ${tenantId}::uuid
       AND identity_id = ${identityIdOf(actor.issuer, actor.subject)}::uuid AND state = 'active'`;
  if (!row) throw new NotFoundError();
  return row.role;
}

async function authorizeAdmin(
  tx: Tx,
  tenantId: string,
  actor: Actor,
): Promise<string> {
  await lockOrganization(tx, tenantId);
  if ((await actorRole(tx, tenantId, actor)) !== ADMIN)
    throw new RoleForbiddenError();
  return identityIdOf(actor.issuer, actor.subject);
}

// ---- membership rows, audit and events ----

async function memberRow(tx: Tx, tenantId: string, identityId: string) {
  const [row] = await tx.$queryRaw<MemberRow[]>`
    SELECT m.identity_id::text, i.issuer, i.subject, m.role, m.state, m.version,
           m.revoked_at, m.revoked_by::text, m.updated_at
      FROM memberships m JOIN identities i ON i.identity_id = m.identity_id
     WHERE m.tenant_id = ${tenantId}::uuid AND m.identity_id = ${identityId}::uuid`;
  return row;
}

async function audit(
  tx: Tx,
  tenantId: string,
  entry: {
    identityId: string;
    action: string;
    actorId: string;
    fromRole?: string;
    toRole: string;
    version?: bigint;
  },
  cmd: Command,
) {
  const auditId = nameId(
    "audit",
    tenantId,
    entry.identityId,
    entry.action,
    String(entry.version ?? 0),
  );
  await tx.$executeRaw`INSERT INTO membership_events (tenant_id, audit_id, identity_id, action, actor_identity_id,
      from_role, to_role, membership_version, correlation_id)
    VALUES (${tenantId}::uuid, ${auditId}::uuid, ${entry.identityId}::uuid, ${entry.action}, ${entry.actorId}::uuid,
      ${entry.fromRole ?? null}, ${entry.toRole}, ${entry.version ?? null}, ${cmd.correlationId}::uuid)`;
}

// One audit row and one membership.changed outbox row per membership change (M09).
async function recordChange(
  tx: Tx,
  tenantId: string,
  row: MemberRow,
  change: Change,
  actorId: string,
  fromRole: string | undefined,
  cmd: Command,
) {
  await audit(
    tx,
    tenantId,
    {
      identityId: row.identity_id,
      action: change,
      actorId,
      fromRole,
      toRole: row.role,
      version: row.version,
    },
    cmd,
  );
  const membershipId = nameId("membership", tenantId, row.identity_id);
  await appendEvent(
    tx,
    {
      tenantId,
      aggregateType: "membership",
      aggregateId: membershipId,
      version: row.version,
      eventType: "membership.changed",
      payload: {
        membership_id: membershipId,
        membership_version: row.version.toString(),
        identity_id: row.identity_id,
        role: row.role,
        state: row.state,
        action: change,
        effective_at: row.updated_at.toISOString(),
        actor_identity_id: actorId,
      },
    },
    cmd,
  );
}

async function insertMembership(
  tx: Tx,
  tenantId: string,
  identityId: string,
  role: string,
  grantedBy: string,
) {
  await tx.$executeRaw`INSERT INTO memberships (tenant_id, identity_id, role, granted_by)
    VALUES (${tenantId}::uuid, ${identityId}::uuid, ${role}, ${grantedBy}::uuid)`;
  return (await memberRow(tx, tenantId, identityId)) as MemberRow;
}

// Exported for the seed: organization row plus its tenant.created event.
export async function insertOrganization(
  tx: Tx,
  tenantId: string,
  name: string,
  createdBy: string,
  cmd: Command,
  trustedPlacementOverride?: { shardId: string },
) {
  const existing = await tx.$queryRaw<
    unknown[]
  >`SELECT 1 FROM organizations WHERE tenant_id=${tenantId}::uuid`;
  if (existing.length) return false;
  const [policy] = await tx.$queryRaw<
    {
      ring_version: bigint;
      algorithm: "sha256-v1";
      virtual_nodes: number;
      shard_ids: string[];
    }[]
  >`
    SELECT r.ring_version,r.algorithm,r.virtual_nodes,r.shard_ids FROM placement_policy p
      JOIN placement_ring_versions r ON r.ring_version=p.ring_version WHERE p.policy_id='default'`;
  if (!policy)
    throw new PlacementUnavailableError(
      "initial placement policy is unavailable",
    );
  if (!trustedPlacementOverride) {
    const activeMembers = await tx.$queryRaw<
      { shard_id: string }[]
    >`SELECT shard_id FROM shard_registry WHERE shard_id=ANY(${policy.shard_ids}::text[]) AND state='active'`;
    if (activeMembers.length !== policy.shard_ids.length)
      throw new PlacementUnavailableError(
        "initial placement ring is not ready",
      );
  }
  const shardId =
    trustedPlacementOverride?.shardId ??
    suggestInitialShard(tenantId, {
      version: policy.ring_version.toString(),
      algorithm: policy.algorithm,
      virtualNodes: policy.virtual_nodes,
      shardIds: policy.shard_ids,
    });
  const registered = await tx.$queryRaw<
    unknown[]
  >`SELECT 1 FROM shard_registry WHERE shard_id=${shardId} AND state='active'`;
  if (!registered.length)
    throw new PlacementUnavailableError(
      "initial placement target is unavailable",
    );
  const inserted =
    await tx.$executeRaw`INSERT INTO organizations (tenant_id, name, created_by, shard_id, initial_placement_ring_version, initial_placement_method)
    VALUES (${tenantId}::uuid, ${name}, ${createdBy}::uuid, ${shardId}, ${trustedPlacementOverride ? null : policy.ring_version}, ${trustedPlacementOverride ? "override" : "ring"}) ON CONFLICT DO NOTHING`;
  if (inserted === 0) return false;
  await appendEvent(
    tx,
    {
      tenantId,
      aggregateType: "organization",
      aggregateId: tenantId,
      version: 1n,
      eventType: "tenant.created",
      payload: {
        tenant_id: tenantId,
        organization_version: "1",
        name,
        state: ACTIVE,
        home_region: "local",
      },
    },
    cmd,
  );
  return true;
}

// Exported for the seed: a first membership with its audit and event.
export async function grantFirstMembership(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  role: string,
  grantedBy: string,
  cmd: Command,
) {
  const identityId = await ensureIdentity(tx, actor);
  if (await memberRow(tx, tenantId, identityId)) return false;
  const row = await insertMembership(tx, tenantId, identityId, role, grantedBy);
  await recordChange(tx, tenantId, row, "granted", grantedBy, undefined, cmd);
  return true;
}

// ---- commands ----

export async function createOrganization(
  db: Db,
  actor: Actor,
  input: { name: string },
  cmd: Command,
): Promise<Result> {
  const tenantId = nameId(
    "organization",
    actor.issuer,
    actor.subject,
    cmd.idempotencyKey,
  );
  return inScope(db, { tenantId }, (tx) =>
    once(
      tx,
      tenantId,
      "organization.create",
      cmd,
      { name: input.name, actorId: identityIdOf(actor.issuer, actor.subject) },
      async () => {
        const actorId = identityIdOf(actor.issuer, actor.subject);
        await insertOrganization(tx, tenantId, input.name, actorId, cmd);
        await grantFirstMembership(tx, tenantId, actor, ADMIN, actorId, cmd);
        await audit(
          tx,
          tenantId,
          {
            identityId: actorId,
            action: "organization_created",
            actorId,
            toRole: ADMIN,
          },
          cmd,
        );
        return {
          status: 201,
          body: { tenantId, name: input.name, version: "1" },
        };
      },
    ),
  );
}

export async function inviteMember(
  db: Db,
  actor: Actor,
  tenantId: string,
  input: { email: string; role: HumanRole },
  cmd: Command,
): Promise<Result> {
  const emailHash = sha256Hex(input.email.trim().toLowerCase());
  return inScope(db, { tenantId }, async (tx) => {
    const actorId = await authorizeAdmin(tx, tenantId, actor);
    return once(
      tx,
      tenantId,
      "invitation.create",
      cmd,
      { emailHash, role: input.role, actorId },
      async () => {
        const invitationId = nameId("invitation", tenantId, cmd.idempotencyKey);
        // 256-bit single-use secret; the tenant prefix routes acceptance, the digest proves it.
        const token = `${tenantId}.${randomBytes(32).toString("base64url")}`;
        const [row] = await tx.$queryRaw<{ expires_at: Date }[]>`
        INSERT INTO invitations (tenant_id, invitation_id, email_hash, role, token_digest, invited_by, expires_at)
        VALUES (${tenantId}::uuid, ${invitationId}::uuid, ${emailHash}, ${input.role}, ${sha256Hex(token)},
          ${actorId}::uuid, clock_timestamp() + make_interval(hours => ${INVITATION_HOURS}))
        RETURNING expires_at`;
        const body = {
          invitationId,
          role: input.role,
          expiresAt: row!.expires_at.toISOString(),
        };
        return { status: 201, body: { ...body, token } };
      },
    );
  });
}

// A forwarded token is useless: only the invited, verified email can claim it.
const verifiedEmailHash = (actor: Actor) =>
  actor.emailVerified === true && actor.email
    ? sha256Hex(actor.email.trim().toLowerCase())
    : null;

async function claimInvitation(
  tx: Tx,
  tenantId: string,
  digest: string,
  actor: Actor,
  identityId: string,
) {
  const [claimed] = await tx.$queryRaw<{ role: string; invited_by: string }[]>`
    UPDATE invitations SET accepted_at = clock_timestamp(), accepted_identity_id = ${identityId}::uuid
     WHERE tenant_id = ${tenantId}::uuid AND token_digest = ${digest}
       AND email_hash = ${verifiedEmailHash(actor)}
       AND accepted_at IS NULL AND expires_at > clock_timestamp()
    RETURNING role, invited_by::text`;
  if (claimed) return claimed;
  const [mine] = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM invitations WHERE tenant_id = ${tenantId}::uuid AND token_digest = ${digest}
       AND accepted_identity_id = ${identityId}::uuid`;
  if (mine) return undefined;
  const [live] = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM invitations WHERE tenant_id = ${tenantId}::uuid AND token_digest = ${digest}
       AND accepted_at IS NULL AND expires_at > clock_timestamp()`;
  throw live
    ? new InvitationEmailMismatchError()
    : new InvitationUnusableError();
}

// Grants the invited role, reactivating a revoked membership; an active member keeps
// their membership unchanged (no event).
async function applyInvitation(
  tx: Tx,
  tenantId: string,
  identityId: string,
  role: string,
  invitedBy: string,
  cmd: Command,
) {
  const existing = await memberRow(tx, tenantId, identityId);
  if (!existing) {
    const row = await insertMembership(
      tx,
      tenantId,
      identityId,
      role,
      invitedBy,
    );
    await recordChange(
      tx,
      tenantId,
      row,
      "accepted",
      invitedBy,
      undefined,
      cmd,
    );
    return row;
  }
  if (existing.state === ACTIVE) return existing;
  const [row] = await tx.$queryRaw<MemberRow[]>`
    UPDATE memberships m SET role = ${role}, state = 'active', version = m.version + 1,
           revoked_at = NULL, revoked_by = NULL,
           granted_by = ${invitedBy}::uuid, updated_at = clock_timestamp()
      FROM identities i WHERE i.identity_id = m.identity_id
       AND m.tenant_id = ${tenantId}::uuid AND m.identity_id = ${identityId}::uuid
    RETURNING m.identity_id::text, i.issuer, i.subject, m.role, m.state, m.version,
              m.revoked_at, m.revoked_by::text, m.updated_at`;
  await recordChange(
    tx,
    tenantId,
    row!,
    "accepted",
    invitedBy,
    existing.role,
    cmd,
  );
  return row!;
}

export async function acceptInvitation(
  db: Db,
  actor: Actor,
  input: { token: string },
  cmd: Command,
): Promise<Result> {
  const tenantId = input.token.split(".")[0] ?? "";
  if (!UUID.test(tenantId)) throw new InvitationUnusableError();
  const digest = sha256Hex(input.token);
  return inScope(db, { tenantId }, async (tx) => {
    await lockOrganization(tx, tenantId).catch((error: unknown) => {
      throw error instanceof NotFoundError
        ? new InvitationUnusableError()
        : error;
    });
    return once(
      tx,
      tenantId,
      "invitation.accept",
      cmd,
      { digest, actorId: identityIdOf(actor.issuer, actor.subject) },
      async () => {
        const identityId = await ensureIdentity(tx, actor);
        const claimed = await claimInvitation(
          tx,
          tenantId,
          digest,
          actor,
          identityId,
        );
        if (!claimed)
          return {
            status: 200,
            body: { ...toDto((await memberRow(tx, tenantId, identityId))!) },
          };
        await assertSeatCapacity(tx, tenantId, identityId);
        const row = await applyInvitation(
          tx,
          tenantId,
          identityId,
          claimed.role,
          claimed.invited_by,
          cmd,
        );
        return { status: 201, body: { ...toDto(row) } };
      },
    );
  });
}

async function activeMember(
  tx: Tx,
  tenantId: string,
  identityId: string,
  expected: bigint,
) {
  const current = await memberRow(tx, tenantId, identityId);
  if (current?.state !== ACTIVE) throw new NotFoundError("membership");
  if (current.version !== expected)
    throw new VersionConflictError(current.version);
  return current;
}

async function requireAnotherAdmin(
  tx: Tx,
  tenantId: string,
  identityId: string,
) {
  const others = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM memberships WHERE tenant_id = ${tenantId}::uuid AND role = 'admin'
       AND state = 'active' AND identity_id <> ${identityId}::uuid LIMIT 1`;
  if (others.length === 0) throw new LastAdminError();
}

interface Transition {
  type: "membership.role" | "membership.revoke";
  change: Change;
  role?: HumanRole;
}

// Shared by role change and revoke: organization lock, admin check, optimistic
// version, last-admin guard, then one UPDATE plus audit plus event.
async function transition(
  db: Db,
  actor: Actor,
  tenantId: string,
  identityId: string,
  expected: bigint,
  t: Transition,
  cmd: Command,
) {
  return inScope(db, { tenantId }, async (tx) => {
    const actorId = await authorizeAdmin(tx, tenantId, actor);
    const request = {
      identityId,
      expected: expected.toString(),
      role: t.role ?? null,
      actorId,
    };
    return once(tx, tenantId, t.type, cmd, request, async () => {
      const current = await activeMember(tx, tenantId, identityId, expected);
      const nextRole = t.role ?? current.role;
      const nextState = t.change === "revoked" ? "revoked" : ACTIVE;
      if (
        current.role === ADMIN &&
        (nextRole !== ADMIN || nextState !== ACTIVE)
      )
        await requireAnotherAdmin(tx, tenantId, identityId);
      const [row] = await tx.$queryRaw<MemberRow[]>`
        UPDATE memberships m SET role = ${nextRole}, state = ${nextState}, version = m.version + 1,
               revoked_at = CASE WHEN ${nextState} = 'revoked' THEN clock_timestamp() ELSE NULL END,
               revoked_by = CASE WHEN ${nextState} = 'revoked' THEN ${actorId}::uuid ELSE NULL END,
               updated_at = clock_timestamp()
          FROM identities i WHERE i.identity_id = m.identity_id
           AND m.tenant_id = ${tenantId}::uuid AND m.identity_id = ${identityId}::uuid AND m.version = ${expected}
        RETURNING m.identity_id::text, i.issuer, i.subject, m.role, m.state, m.version,
                  m.revoked_at, m.revoked_by::text, m.updated_at`;
      await recordChange(
        tx,
        tenantId,
        row!,
        t.change,
        actorId,
        current.role,
        cmd,
      );
      return { status: 200, body: { ...toDto(row!) } };
    });
  });
}

export const changeRole = (
  db: Db,
  actor: Actor,
  tenantId: string,
  identityId: string,
  input: { role: HumanRole },
  expected: bigint,
  cmd: Command,
) =>
  transition(
    db,
    actor,
    tenantId,
    identityId,
    expected,
    { type: "membership.role", change: "role_changed", role: input.role },
    cmd,
  );

export const revokeMember = (
  db: Db,
  actor: Actor,
  tenantId: string,
  identityId: string,
  expected: bigint,
  cmd: Command,
) =>
  transition(
    db,
    actor,
    tenantId,
    identityId,
    expected,
    { type: "membership.revoke", change: "revoked" },
    cmd,
  );

export async function listMembers(
  db: Db,
  actor: Actor,
  tenantId: string,
): Promise<MemberDto[]> {
  return (await listMembersPage(db, actor, tenantId)).items;
}

export async function listMembersPage(
  db: Db,
  actor: Actor,
  tenantId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ items: MemberDto[]; nextCursor: string | null }> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new InvalidInputError("limit must be between 1 and 100");
  let after: { createdAt: string; identityId: string } | undefined;
  if (options.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(options.cursor, "base64url").toString("utf8"),
      ) as { createdAt: string; identityId: string };
      if (
        !UUID.test(decoded.identityId) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(
          decoded.createdAt,
        ) ||
        Number.isNaN(Date.parse(decoded.createdAt))
      )
        throw new Error("invalid cursor");
      after = { createdAt: decoded.createdAt, identityId: decoded.identityId };
    } catch {
      throw new InvalidInputError("invalid member cursor");
    }
  }
  return inScope(db, { tenantId }, async (tx) => {
    await actorRole(tx, tenantId, actor);
    const rows = after
      ? await tx.$queryRaw<(MemberRow & { created_at_text: string })[]>`
      SELECT m.identity_id::text, i.issuer, i.subject, m.role, m.state, m.version,
             m.revoked_at, m.revoked_by::text, m.updated_at,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
        FROM memberships m JOIN identities i ON i.identity_id = m.identity_id
       WHERE m.tenant_id = ${tenantId}::uuid
         AND (m.created_at, m.identity_id) > (${after.createdAt}::timestamptz, ${after.identityId}::uuid)
       ORDER BY m.created_at, m.identity_id LIMIT ${limit + 1}`
      : await tx.$queryRaw<(MemberRow & { created_at_text: string })[]>`
      SELECT m.identity_id::text, i.issuer, i.subject, m.role, m.state, m.version,
             m.revoked_at, m.revoked_by::text, m.updated_at,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
        FROM memberships m JOIN identities i ON i.identity_id = m.identity_id
       WHERE m.tenant_id = ${tenantId}::uuid
       ORDER BY m.created_at, m.identity_id LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              createdAt: last.created_at_text,
              identityId: last.identity_id,
            }),
          ).toString("base64url")
        : null;
    return { items: page.map(toDto), nextCursor };
  });
}

// Verifier lookup: (issuer, subject) -> the single active membership. Two active
// tenants are ambiguous until tenant selection exists (ADR-0017); never guess.
export async function lookupMembership(
  db: Db,
  issuer: string,
  subject: string,
) {
  const identityId = identityIdOf(issuer, subject);
  const rows = await inScope(
    db,
    { identityId },
    (tx) =>
      tx.$queryRaw<
        { tenant_id: string; role: string; state: string; version: bigint }[]
      >`
      SELECT tenant_id::text, role, state, version FROM memberships
       WHERE identity_id = ${identityId}::uuid
       ORDER BY (state = 'active') DESC, updated_at DESC LIMIT 2`,
  );
  const active = rows.filter((row) => row.state === ACTIVE);
  if (active.length > 1) throw new AmbiguousMembershipError();
  if (active[0])
    return {
      tenantId: active[0].tenant_id,
      roles: [active[0].role],
      version: active[0].version.toString(),
      state: "active" as const,
    };
  if (rows.length > 1) return null;
  return rows[0]
    ? {
        tenantId: rows[0].tenant_id,
        roles: [],
        version: rows[0].version.toString(),
        state: "revoked" as const,
      }
    : null;
}
