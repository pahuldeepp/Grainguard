import { AuthError } from "@greenguard/tenant-auth";
import { resolveTxt } from "node:dns/promises";
import type { Db, Tx } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import {
  InvalidInputError,
  RoleForbiddenError,
  VersionConflictError,
  NotFoundError,
} from "./errors.js";
import { identityIdOf, nameId } from "./ids.js";
import { SeatLimitError, assertSeatCapacity } from "./entitlements.js";
import {
  grantFirstMembership,
  lookupMembership,
  type Actor,
  type Command,
} from "./store.js";

const DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const normalizeDomain = (value: string) => value.trim().toLowerCase();
const INVALID_CONNECTION = "invalid identity connection";
const VERIFICATION_FAILED = "domain verification failed";
const ADMIN_ROLE = "admin";

// A verified domain is a lease that must be re-verified; default 30 days.
export function domainTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.IDENTITY_DOMAIN_TTL_DAYS ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error(
      "IDENTITY_DOMAIN_TTL_DAYS must be an integer from 1 to 365",
    );
  return days;
}

async function requireAdmin(tx: Tx, tenantId: string, actor: Actor) {
  const [admin] = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM memberships m JOIN organizations o ON o.tenant_id = m.tenant_id
     WHERE m.tenant_id = ${tenantId}::uuid AND o.state = 'active'
       AND m.identity_id = ${identityIdOf(actor.issuer, actor.subject)}::uuid
       AND m.state = 'active' AND m.role = ${ADMIN_ROLE}`;
  if (!admin) throw new RoleForbiddenError();
}

async function emitConnectionChanged(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  version: bigint,
  jitEnabled: boolean,
  cmd: Command,
) {
  const eventId = nameId(
    "event",
    tenantId,
    "identity_connection",
    connectionId,
    String(version),
  );
  await tx.$executeRaw`INSERT INTO outbox_events
    (event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type,
     schema_version, occurred_at, correlation_id, causation_id, traceparent, payload)
    VALUES (${eventId}::uuid, ${tenantId}::uuid, 'identity_connection', ${connectionId}::uuid,
     ${version}, 'identity_connection.changed', 1, clock_timestamp(), ${cmd.correlationId}::uuid,
     ${cmd.correlationId}::uuid, ${cmd.traceparent},
     ${JSON.stringify({ connection_id: connectionId, connection_version: version.toString(), jit_enabled: jitEnabled })}::jsonb)`;
}

export interface ConnectionInput {
  issuer: string;
  type: "oidc" | "saml";
  domains: string[];
  jitEnabled: boolean;
}

// Implementations may use DNS TXT or an IdP's verified-domain API. Never
// persist a domain from an unchecked admin request.
export type VerifyDomain = (
  tenantId: string,
  domain: string,
) => Promise<boolean>;

export const verifyDnsDomain: VerifyDomain = async (tenantId, domain) => {
  try {
    const records = await resolveTxt(`_greenguard.${domain}`);
    return records.some(
      (parts) => parts.join("") === `greenguard-tenant=${tenantId}`,
    );
  } catch {
    return false;
  }
};

export async function createIdentityConnection(
  db: Db,
  actor: Actor,
  tenantId: string,
  input: ConnectionInput,
  verifyDomain: VerifyDomain,
  cmd: Command,
) {
  if (
    !UUID.test(tenantId) ||
    !input.issuer ||
    input.issuer.length > 512 ||
    !["oidc", "saml"].includes(input.type) ||
    input.domains.length < 1 ||
    input.domains.length > 20
  )
    throw new InvalidInputError(INVALID_CONNECTION);
  const domains = [...new Set(input.domains.map(normalizeDomain))];
  if (domains.some((domain) => !DOMAIN.test(domain)))
    throw new InvalidInputError("invalid email domain");
  await inScope(db, { tenantId }, (tx) => requireAdmin(tx, tenantId, actor));
  for (const domain of domains)
    if (!(await verifyDomain(tenantId, domain)))
      throw new InvalidInputError(VERIFICATION_FAILED);
  const connectionId = nameId("identity_connection", tenantId, input.issuer);
  return inScope(db, { tenantId }, async (tx) => {
    await requireAdmin(tx, tenantId, actor);
    const [existing] = await tx.$queryRaw<{ version: bigint }[]>`
      SELECT version FROM identity_connections WHERE tenant_id = ${tenantId}::uuid
        AND connection_id = ${connectionId}::uuid`;
    if (existing) throw new InvalidInputError("connection already exists");
    await tx.$executeRaw`INSERT INTO identity_connections
      (tenant_id, connection_id, issuer, type, jit_enabled)
      VALUES (${tenantId}::uuid, ${connectionId}::uuid, ${input.issuer}, ${input.type}, ${input.jitEnabled})`;
    const ttl = domainTtlDays();
    for (const domain of domains) {
      // Retire another tenant's lapsed claim; a live claim still trips the unique index.
      await tx.$executeRaw`SELECT release_expired_domain(${domain}, ${tenantId}::uuid)`;
      await tx.$executeRaw`INSERT INTO identity_connection_domains
        (tenant_id, connection_id, domain, verified_until)
        VALUES (${tenantId}::uuid, ${connectionId}::uuid, ${domain}, clock_timestamp() + make_interval(days => ${ttl}))`;
    }
    await emitConnectionChanged(
      tx,
      tenantId,
      connectionId,
      1n,
      input.jitEnabled,
      cmd,
    );
    return {
      connectionId,
      issuer: input.issuer,
      type: input.type,
      domains,
      jitEnabled: input.jitEnabled,
      version: "1",
    };
  });
}

export async function setConnectionJit(
  db: Db,
  actor: Actor,
  tenantId: string,
  connectionId: string,
  enabled: boolean,
  expected: bigint,
  cmd: Command,
) {
  if (!UUID.test(tenantId) || !UUID.test(connectionId))
    throw new InvalidInputError(INVALID_CONNECTION);
  return inScope(db, { tenantId }, async (tx) => {
    await requireAdmin(tx, tenantId, actor);
    const [current] = await tx.$queryRaw<
      { version: bigint; jit_enabled: boolean }[]
    >`
      SELECT version, jit_enabled FROM identity_connections
       WHERE tenant_id = ${tenantId}::uuid AND connection_id = ${connectionId}::uuid FOR UPDATE`;
    if (!current) throw new NotFoundError("connection");
    if (current.version !== expected)
      throw new VersionConflictError(current.version);
    if (current.jit_enabled === enabled)
      return {
        connectionId,
        jitEnabled: enabled,
        version: current.version.toString(),
      };
    const next = expected + 1n;
    await tx.$executeRaw`UPDATE identity_connections
      SET jit_enabled = ${enabled}, version = ${next}, updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid AND connection_id = ${connectionId}::uuid`;
    await emitConnectionChanged(tx, tenantId, connectionId, next, enabled, cmd);
    return { connectionId, jitEnabled: enabled, version: next.toString() };
  });
}

function connectionDomain(
  tenantId: string,
  connectionId: string,
  domain: string,
) {
  const name = normalizeDomain(domain);
  if (!UUID.test(tenantId) || !UUID.test(connectionId) || !DOMAIN.test(name))
    throw new InvalidInputError(INVALID_CONNECTION);
  return name;
}

// Extends a lapsed or live claim only when the DNS proof still holds. A failed
// re-check changes nothing, so the claim keeps expiring.
export async function reverifyIdentityDomain(
  db: Db,
  actor: Actor,
  tenantId: string,
  connectionId: string,
  domainName: string,
  verifyDomain: VerifyDomain,
) {
  const domain = connectionDomain(tenantId, connectionId, domainName);
  await inScope(db, { tenantId }, (tx) => requireAdmin(tx, tenantId, actor));
  if (!(await verifyDomain(tenantId, domain)))
    throw new InvalidInputError(VERIFICATION_FAILED);
  const ttl = domainTtlDays();
  return inScope(db, { tenantId }, async (tx) => {
    await requireAdmin(tx, tenantId, actor);
    const [row] = await tx.$queryRaw<{ verified_until: Date }[]>`
      UPDATE identity_connection_domains
         SET verified_until = clock_timestamp() + make_interval(days => ${ttl}), verified_at = clock_timestamp()
       WHERE tenant_id = ${tenantId}::uuid AND connection_id = ${connectionId}::uuid
         AND domain = ${domain} AND status = 'active'
      RETURNING verified_until`;
    if (!row) throw new NotFoundError("domain");
    return { domain, verifiedUntil: row.verified_until.toISOString() };
  });
}

// Claims are never deleted: releasing marks the claim 'released' so another tenant
// can verify the domain. Only an admin of the owning tenant can release.
export async function releaseIdentityDomain(
  db: Db,
  actor: Actor,
  tenantId: string,
  connectionId: string,
  domainName: string,
  cmd: Command,
) {
  const domain = connectionDomain(tenantId, connectionId, domainName);
  return inScope(db, { tenantId }, async (tx) => {
    await requireAdmin(tx, tenantId, actor);
    const [current] = await tx.$queryRaw<
      { version: bigint; jit_enabled: boolean }[]
    >`
      SELECT version, jit_enabled FROM identity_connections
       WHERE tenant_id = ${tenantId}::uuid AND connection_id = ${connectionId}::uuid FOR UPDATE`;
    const [released] = current
      ? await tx.$queryRaw<unknown[]>`
      UPDATE identity_connection_domains SET status = 'released', released_at = clock_timestamp()
       WHERE tenant_id = ${tenantId}::uuid AND connection_id = ${connectionId}::uuid
         AND domain = ${domain} AND status = 'active' RETURNING 1`
      : [];
    if (!current || !released) throw new NotFoundError("domain");
    const next = current.version + 1n;
    await tx.$executeRaw`UPDATE identity_connections SET version = ${next}, updated_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid AND connection_id = ${connectionId}::uuid`;
    await emitConnectionChanged(
      tx,
      tenantId,
      connectionId,
      next,
      current.jit_enabled,
      cmd,
    );
    return { domain, released: true, version: next.toString() };
  });
}

export async function discoverIdentityConnection(db: Db, email: string) {
  const domain = normalizeDomain(email.split("@")[1] ?? "");
  if (!DOMAIN.test(domain)) throw new InvalidInputError("invalid email");
  // This public discovery result contains only issuer/type; no tenant metadata.
  const [row] = await db.$queryRaw<{ issuer: string; type: string }[]>`
    SELECT issuer, type FROM discover_identity_realm(${domain})`;
  return row ?? null;
}

export async function jitMembership(db: Db, actor: Actor, cmd: Command) {
  if (!actor.emailVerified || !actor.email)
    throw new AuthError(401, "invalid_claims");
  const domain = normalizeDomain(actor.email.split("@")[1] ?? "");
  if (!DOMAIN.test(domain)) throw new AuthError(401, "invalid_claims");
  const existing = await lookupMembership(db, actor.issuer, actor.subject);
  if (existing) {
    if (existing.state !== "active") throw new AuthError(401, "invalid_claims");
    return existing;
  }
  const [realm] = await db.$queryRaw<{ tenant_id: string }[]>`
    SELECT find_jit_tenant(${actor.issuer}, ${domain})::text AS tenant_id`;
  if (!realm?.tenant_id) throw new AuthError(401, "invalid_claims");
  const tenantId = realm.tenant_id;
  return inScope(db, { tenantId }, async (tx) => {
    // Recheck inside the tenant transaction so disabling JIT or suspending the
    // organization before this write cannot grant membership.
    const [allowed] = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM identity_connections c
        JOIN identity_connection_domains d ON d.tenant_id = c.tenant_id AND d.connection_id = c.connection_id
        JOIN organizations o ON o.tenant_id = c.tenant_id
       WHERE c.tenant_id = ${tenantId}::uuid AND c.issuer = ${actor.issuer}
         AND d.domain = ${domain} AND d.status = 'active' AND d.verified_until > clock_timestamp()
         AND c.jit_enabled AND o.state = 'active'
       FOR UPDATE OF c`;
    if (!allowed) throw new AuthError(401, "invalid_claims");
    const actorId = identityIdOf(actor.issuer, actor.subject);
    await assertSeatCapacity(tx, tenantId, actorId);
    await grantFirstMembership(tx, tenantId, actor, "viewer", actorId, cmd);
    return { tenantId, roles: ["viewer"], state: "active" as const };
  }).catch(async (error: unknown) => {
    // The rejected membership transaction rolled back. Record the security outcome
    // separately so it survives the rollback and flows through the existing audit export.
    if (error instanceof SeatLimitError) {
      const actorId = identityIdOf(actor.issuer, actor.subject);
      const auditId = nameId(
        "audit",
        tenantId,
        "jit_seat_limit_denied",
        actorId,
        cmd.correlationId,
      );
      await inScope(
        db,
        { tenantId },
        (tx) => tx.$executeRaw`
        INSERT INTO membership_events
          (tenant_id, audit_id, identity_id, action, actor_identity_id,
           from_role, to_role, membership_version, correlation_id)
        VALUES (${tenantId}::uuid, ${auditId}::uuid, NULL, 'jit_seat_limit_denied',
          ${actorId}::uuid, NULL, NULL, ${BigInt(error.planVersion)}, ${cmd.correlationId}::uuid)
        ON CONFLICT (tenant_id, audit_id) DO NOTHING`,
      );
    }
    throw error;
  });
}
