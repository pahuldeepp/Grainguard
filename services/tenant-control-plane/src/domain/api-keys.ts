import { assertApiKeyCapacity } from "./entitlements.js";
import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Db, Tx } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import { identityIdOf, nameId } from "./ids.js";
import {
  IdempotencyConflictError,
  DomainConflictError,
  InvalidInputError,
  NotFoundError,
  RoleForbiddenError,
} from "./errors.js";
import { isUniqueViolation } from "./db-conflict.js";
import type { Actor, Command } from "./store.js";

export type ServiceContext = {
  tenant_id: string;
  principal_id: string;
  principal_type: "service";
  scopes: string[];
  key_id?: string;
  device_id?: string;
};
export const KEY_PATTERN =
  /^gg_([a-z0-9]{2,12})_(usr|dev)_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/;
const SCOPE = /^(read:telemetry|write:telemetry|write:devices|export:audit)$/;
const ADMIN_SCOPES = new Set([
  "read:telemetry",
  "write:telemetry",
  "write:devices",
  "export:audit",
]);
const OPERATOR_SCOPES = new Set([
  "read:telemetry",
  "write:telemetry",
  "write:devices",
]);
const VIEWER_SCOPES = new Set(["read:telemetry"]);
const roles: Record<string, Set<string>> = {
  admin: ADMIN_SCOPES,
  operator: OPERATOR_SCOPES,
  viewer: VIEWER_SCOPES,
};

export function keyDigest(secret: string, pepper: string): Buffer {
  if (Buffer.byteLength(pepper) < 32)
    throw new Error("API_KEY_PEPPER must contain at least 32 bytes");
  return createHmac("sha256", pepper).update(secret).digest();
}
function validScopes(scopes: unknown): asserts scopes is string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > 32 ||
    scopes.some((s) => typeof s !== "string" || !SCOPE.test(s)) ||
    new Set(scopes).size !== scopes.length
  )
    throw new InvalidInputError("invalid scopes");
}
async function authorize(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  scopes: string[],
  adminOnly = false,
): Promise<string> {
  const [org] = await tx.$queryRaw<
    [{ tenant_id: string }?]
  >`SELECT tenant_id::text FROM organizations WHERE tenant_id=${tenantId}::uuid AND state='active' FOR UPDATE`;
  // Same answer for "no such organization" and "not a member": no tenant probing.
  if (!org) throw new RoleForbiddenError();
  const creator = identityIdOf(actor.issuer, actor.subject);
  const [member] = await tx.$queryRaw<
    { role: string }[]
  >`SELECT role FROM memberships WHERE tenant_id=${tenantId}::uuid AND identity_id=${creator}::uuid AND state='active'`;
  if (!member || (adminOnly && member.role !== "admin"))
    throw new RoleForbiddenError();
  if (scopes.some((scope) => !roles[member.role]?.has(scope)))
    throw new RoleForbiddenError();
  return creator;
}
async function changed(
  tx: Tx,
  tenantId: string,
  principalId: string,
  version: bigint,
  type: string,
  cmd: Command,
) {
  const eventId = nameId(
    "event",
    tenantId,
    "service_principal",
    principalId,
    String(version),
  );
  await tx.$executeRaw`INSERT INTO outbox_events (event_id,tenant_id,aggregate_type,aggregate_id,aggregate_version,event_type,schema_version,occurred_at,correlation_id,causation_id,traceparent,payload)
    VALUES (${eventId}::uuid,${tenantId}::uuid,'service_principal',${principalId}::uuid,${version},${type},1,clock_timestamp(),${cmd.correlationId}::uuid,${cmd.correlationId}::uuid,${cmd.traceparent},${JSON.stringify({ tenant_id: tenantId, principal_id: principalId, principal_version: String(version), state: type.endsWith("revoked") ? "revoked" : "active" })}::jsonb)`;
}
type Stored = Record<string, unknown>;
// One receipt per (tenant, command, Idempotency-Key). The receipt carries the safe
// response (never a secret) and commits atomically with the effect, so a crash
// leaves either nothing or a complete, replayable command. An identical replay
// returns the stored response; a different body under the same key conflicts.
async function reserveCommand(
  tx: Tx,
  tenantId: string,
  type: string,
  cmd: Command,
  request: object,
  response: Stored,
): Promise<Stored | undefined> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}|${type}|${cmd.idempotencyKey}`},0))`;
  const [prior] = await tx.$queryRaw<
    { same: boolean; response_body: Stored }[]
  >`SELECT normalized_request = ${JSON.stringify(request)}::jsonb AS same, response_body FROM command_receipts WHERE tenant_id=${tenantId}::uuid AND command_type=${type} AND idempotency_key=${cmd.idempotencyKey}`;
  if (prior) {
    if (!prior.same) throw new IdempotencyConflictError();
    return prior.response_body;
  }
  await tx.$executeRaw`INSERT INTO command_receipts (tenant_id,command_type,idempotency_key,normalized_request,response_body)
    VALUES (${tenantId}::uuid,${type},${cmd.idempotencyKey},${JSON.stringify(request)}::jsonb,${JSON.stringify(response)}::jsonb)`;
}
export type IssuedKey = {
  key: string;
  keyId: string;
  principalId: string;
  expiresAt: string;
  secretAlreadyRevealed?: false;
};
// Returned for an identical replay. The secret is shown once, at first issuance;
// recovery from a lost response is: revoke the orphan principal, create a new key.
export type ReplayedKey = {
  key?: undefined;
  keyId: string;
  principalId?: string;
  expiresAt?: string;
  keyPrefix?: string;
  secretAlreadyRevealed: true;
};
const keyPrefix = (env: string, kind: string, keyId: string) =>
  `gg_${env}_${kind}_${keyId}_`;
export async function createApiKey(
  db: Db,
  pepper: string,
  actor: Actor,
  tenantId: string,
  input: {
    name: string;
    scopes: string[];
    expiresAt: string;
    kind: "usr" | "dev";
    deviceId?: string;
  },
  cmd: Command,
  environment = "dev",
): Promise<IssuedKey | ReplayedKey> {
  if (
    !UUID.test(tenantId) ||
    !/^[a-z0-9]{2,12}$/.test(environment) ||
    typeof input.name !== "string" ||
    input.name.length < 1 ||
    input.name.length > 120
  )
    throw new InvalidInputError("invalid key request");
  validScopes(input.scopes);
  if (
    (input.kind !== "usr" && input.kind !== "dev") ||
    (input.kind === "dev") !== !!input.deviceId ||
    (input.deviceId && !UUID.test(input.deviceId)) ||
    (input.kind === "dev" &&
      (input.scopes.length !== 1 || input.scopes[0] !== "write:telemetry"))
  )
    throw new InvalidInputError(
      "device keys require one device and write:telemetry only",
    );
  const expiresAt = new Date(input.expiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now() ||
    expiresAt.getTime() > Date.now() + 365 * 86400000
  )
    throw new InvalidInputError("expiry must be within one year");
  const keyId = randomUUID(),
    principalId = randomUUID(),
    secret = randomBytes(32).toString("base64url");
  const digest = keyDigest(secret, pepper);
  const replay = await inScope(db, { tenantId }, async (tx) => {
    const creator = await authorize(
      tx,
      tenantId,
      actor,
      input.scopes,
      input.kind === "dev",
    );
    const prior = await reserveCommand(
      tx,
      tenantId,
      "api_key.create",
      cmd,
      {
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        kind: input.kind,
        deviceId: input.deviceId ?? null,
      },
      {
        keyId,
        principalId,
        expiresAt: expiresAt.toISOString(),
        keyPrefix: keyPrefix(environment, input.kind, keyId),
        secretAlreadyRevealed: true,
      },
    );
    if (prior) return prior as ReplayedKey;
    await assertApiKeyCapacity(tx, tenantId);
    await tx.$executeRaw`INSERT INTO service_principals (tenant_id,principal_id,name,kind,allowed_scopes,created_by) VALUES (${tenantId}::uuid,${principalId}::uuid,${input.name},'api_key',${input.scopes}::text[],${creator}::uuid)`;
    await tx.$executeRaw`INSERT INTO api_keys (tenant_id,key_id,principal_id,kind,device_id,digest,scopes,created_by,expires_at) VALUES (${tenantId}::uuid,${keyId}::uuid,${principalId}::uuid,${input.kind},${input.deviceId ?? null}::uuid,${digest},${input.scopes}::text[],${creator}::uuid,${expiresAt})`;
    await changed(
      tx,
      tenantId,
      principalId,
      1n,
      "service_principal.created",
      cmd,
    );
  });
  if (replay) return replay;
  return {
    key: `${keyPrefix(environment, input.kind, keyId)}${secret}`,
    keyId,
    principalId,
    expiresAt: expiresAt.toISOString(),
  };
}
export async function registerOAuthClient(
  db: Db,
  actor: Actor,
  tenantId: string,
  input: { name: string; issuer: string; clientId: string; scopes: string[] },
  cmd: Command,
  allowedIssuers: readonly string[] = [],
) {
  if (
    !UUID.test(tenantId) ||
    !input.name ||
    input.name.length > 120 ||
    !input.issuer?.startsWith("https://") ||
    !input.clientId ||
    input.clientId.length > 512
  )
    throw new InvalidInputError("invalid OAuth client");
  // Fail closed: only issuers the operator configured may back a machine client.
  if (!allowedIssuers.includes(input.issuer))
    throw new InvalidInputError("machine issuer is not allow-listed");
  validScopes(input.scopes);
  const principalId = randomUUID();
  return inScope(db, { tenantId }, async (tx) => {
    const creator = await authorize(tx, tenantId, actor, input.scopes, true);
    const prior = await reserveCommand(
      tx,
      tenantId,
      "oauth_client.create",
      cmd,
      input,
      { principalId },
    );
    if (prior) return prior as { principalId: string };
    try {
      await tx.$executeRaw`INSERT INTO service_principals (tenant_id,principal_id,name,kind,issuer,client_id,allowed_scopes,created_by) VALUES (${tenantId}::uuid,${principalId}::uuid,${input.name},'oauth_client',${input.issuer},${input.clientId},${input.scopes}::text[],${creator}::uuid)`;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DomainConflictError(
          "OAuth client is already registered for this tenant",
        );
      throw error;
    }
    await changed(
      tx,
      tenantId,
      principalId,
      1n,
      "service_principal.created",
      cmd,
    );
    return { principalId };
  });
}
export async function revokeCredential(
  db: Db,
  actor: Actor,
  tenantId: string,
  principalId: string,
  cmd: Command,
) {
  if (!UUID.test(tenantId) || !UUID.test(principalId))
    throw new InvalidInputError("invalid identifier");
  await inScope(db, { tenantId }, async (tx) => {
    await authorize(tx, tenantId, actor, [], true);
    const prior = await reserveCommand(
      tx,
      tenantId,
      "credential.revoke",
      cmd,
      { principalId },
      { state: "revoked" },
    );
    if (prior) return;
    const [row] = await tx.$queryRaw<
      { version: bigint }[]
    >`SELECT version FROM service_principals WHERE tenant_id=${tenantId}::uuid AND principal_id=${principalId}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundError("credential");
    if (
      await tx.$executeRaw`UPDATE service_principals SET state='revoked',revoked_at=clock_timestamp(),version=version+1 WHERE tenant_id=${tenantId}::uuid AND principal_id=${principalId}::uuid AND state='active'`
    ) {
      await tx.$executeRaw`UPDATE api_keys SET revoked_at=clock_timestamp(),version=version+1 WHERE tenant_id=${tenantId}::uuid AND principal_id=${principalId}::uuid AND revoked_at IS NULL`;
      await changed(
        tx,
        tenantId,
        principalId,
        row.version + 1n,
        "service_principal.revoked",
        cmd,
      );
    }
  });
}
export async function rotateApiKey(
  db: Db,
  pepper: string,
  actor: Actor,
  tenantId: string,
  oldKeyId: string,
  cmd: Command,
  overlapHours = 24,
  environment = "dev",
): Promise<IssuedKey | ReplayedKey> {
  if (
    !UUID.test(tenantId) ||
    !UUID.test(oldKeyId) ||
    overlapHours < 0 ||
    overlapHours > 168
  )
    throw new InvalidInputError("invalid rotation");
  const keyId = randomUUID(),
    secret = randomBytes(32).toString("base64url"),
    digest = keyDigest(secret, pepper),
    expiresAt = new Date(Date.now() + 365 * 86400000);
  const outcome = await inScope(db, { tenantId }, async (tx) => {
    await authorize(tx, tenantId, actor, [], true);
    const prior = await reserveCommand(
      tx,
      tenantId,
      "api_key.rotate",
      cmd,
      { oldKeyId, overlapHours },
      { keyId, secretAlreadyRevealed: true },
    );
    if (prior) return prior as { keyId: string };
    const [old] = await tx.$queryRaw<
      {
        principal_id: string;
        kind: "usr" | "dev";
        device_id: string | null;
        scopes: string[];
        created_by: string;
        version: bigint;
      }[]
    >`SELECT principal_id::text,kind,device_id::text,scopes,created_by::text,version FROM api_keys WHERE tenant_id=${tenantId}::uuid AND key_id=${oldKeyId}::uuid AND revoked_at IS NULL AND rotated_to IS NULL AND expires_at>now() FOR UPDATE`;
    if (!old) throw new NotFoundError("key");
    await tx.$executeRaw`INSERT INTO api_keys (tenant_id,key_id,principal_id,kind,device_id,digest,scopes,created_by,expires_at) VALUES (${tenantId}::uuid,${keyId}::uuid,${old.principal_id}::uuid,${old.kind},${old.device_id}::uuid,${digest},${old.scopes}::text[],${old.created_by}::uuid,${expiresAt})`;
    await tx.$executeRaw`UPDATE api_keys SET expires_at=LEAST(expires_at,now()+(${overlapHours} * interval '1 hour')),rotated_to=${keyId}::uuid,version=version+1 WHERE tenant_id=${tenantId}::uuid AND key_id=${oldKeyId}::uuid`;
    const [p] = await tx.$queryRaw<
      { version: bigint }[]
    >`UPDATE service_principals SET version=version+1 WHERE tenant_id=${tenantId}::uuid AND principal_id=${old.principal_id}::uuid RETURNING version`;
    await changed(
      tx,
      tenantId,
      old.principal_id,
      p!.version,
      "service_principal.rotated",
      cmd,
    );
    return { ...old, expiresAt: expiresAt.toISOString() };
  });
  if (!("kind" in outcome)) return { ...outcome, secretAlreadyRevealed: true };
  return {
    key: `${keyPrefix(environment, outcome.kind, keyId)}${secret}`,
    keyId,
    principalId: outcome.principal_id,
    expiresAt: outcome.expiresAt,
  };
}
const effectiveScopes = (scopes: string[], role: string | null) =>
  scopes.filter((scope) => (role ? roles[role]?.has(scope) : false));
export async function verifyApiKey(
  db: Db,
  pepper: string,
  presented: string,
  now = new Date(),
): Promise<ServiceContext> {
  const match = KEY_PATTERN.exec(presented);
  if (!match || !UUID.test(match[3]!)) throw new Error("invalid_key");
  const [, , kind, keyId, secret] = match;
  const [resolved] = await db.$queryRaw<
    { tenant_id: string }[]
  >`SELECT tenant_id::text FROM resolve_api_key(${keyId}::uuid)`;
  if (!resolved) throw new Error("invalid_key");
  return inScope(db, { tenantId: resolved.tenant_id }, async (tx) => {
    const [row] = await tx.$queryRaw<
      {
        tenant_id: string;
        principal_id: string;
        kind: string;
        device_id: string | null;
        digest: Uint8Array;
        scopes: string[];
        expires_at: Date;
        revoked_at: Date | null;
        state: string;
        created_by: string;
        creator_state: string | null;
        creator_role: string | null;
      }[]
    >`SELECT k.tenant_id::text,k.principal_id::text,k.kind,k.device_id::text,k.digest,k.scopes,k.expires_at,k.revoked_at,p.state,k.created_by::text,m.state AS creator_state,m.role AS creator_role FROM api_keys k JOIN service_principals p ON p.tenant_id=k.tenant_id AND p.principal_id=k.principal_id JOIN organizations o ON o.tenant_id=k.tenant_id AND o.state='active' LEFT JOIN memberships m ON m.tenant_id=k.tenant_id AND m.identity_id=k.created_by WHERE k.tenant_id=${resolved.tenant_id}::uuid AND k.key_id=${keyId}::uuid`;
    const candidate = keyDigest(secret!, pepper);
    if (
      !row ||
      row.kind !== kind ||
      row.digest.length !== candidate.length ||
      !timingSafeEqual(Buffer.from(row.digest), candidate) ||
      row.expires_at <= now ||
      row.revoked_at ||
      row.state !== "active" ||
      row.creator_state !== "active"
    )
      throw new Error("invalid_key");
    // The key never outranks its creator: keep only scopes the creator's current role permits.
    const scopes = effectiveScopes(row.scopes, row.creator_role);
    if (!scopes.length) throw new Error("invalid_key");
    await tx.$executeRaw`UPDATE api_keys SET last_used_at=${now} WHERE tenant_id=${resolved.tenant_id}::uuid AND key_id=${keyId}::uuid AND (last_used_at IS NULL OR last_used_at < ${new Date(now.getTime() - 60000)})`;
    return {
      tenant_id: row.tenant_id,
      principal_id: row.principal_id,
      principal_type: "service" as const,
      scopes,
      key_id: keyId,
      ...(row.device_id ? { device_id: row.device_id } : {}),
    };
  });
}
export async function verifyApiKeyForTenant(
  db: Db,
  pepper: string,
  presented: string,
  expectedTenant: string,
  now = new Date(),
): Promise<ServiceContext> {
  if (!UUID.test(expectedTenant)) throw new Error("invalid_key");
  const principal = await verifyApiKey(db, pepper, presented, now);
  if (principal.tenant_id !== expectedTenant) throw new Error("invalid_key");
  return principal;
}
// The tenant comes from the IdP-signed tenant claim the verifier extracts. A client
// resolves only inside the tenant that registered it; without a tenant it resolves
// nothing, so a squatter registering someone else's client id captures no tokens.
export async function lookupOAuthClient(
  db: Db,
  issuer: string,
  clientId: string,
  tenantId?: string,
): Promise<
  { tenant_id: string; principal_id: string; scopes: string[] } | undefined
> {
  if (!tenantId || !UUID.test(tenantId)) return;
  return inScope(db, { tenantId }, async (tx) => {
    const [row] = await tx.$queryRaw<
      {
        tenant_id: string;
        principal_id: string;
        allowed_scopes: string[];
        state: string;
        creator_state: string | null;
        creator_role: string | null;
      }[]
    >`SELECT p.tenant_id::text,p.principal_id::text,p.allowed_scopes,p.state,m.state AS creator_state,m.role AS creator_role FROM service_principals p LEFT JOIN memberships m ON m.tenant_id=p.tenant_id AND m.identity_id=p.created_by JOIN organizations o ON o.tenant_id=p.tenant_id WHERE p.tenant_id=${tenantId}::uuid AND p.issuer=${issuer} AND p.client_id=${clientId} AND p.kind='oauth_client' AND o.state='active'`;
    if (!row || row.state !== "active" || row.creator_state !== "active")
      return;
    const scopes = effectiveScopes(row.allowed_scopes, row.creator_role);
    if (!scopes.length) return;
    return { tenant_id: row.tenant_id, principal_id: row.principal_id, scopes };
  });
}
export async function listCredentials(db: Db, actor: Actor, tenantId: string) {
  if (!UUID.test(tenantId)) throw new InvalidInputError("invalid identifier");
  return inScope(db, { tenantId }, async (tx) => {
    await authorize(tx, tenantId, actor, [], true);
    return tx.$queryRaw<
      {
        principalId: string;
        name: string;
        kind: string;
        state: string;
        scopes: string[];
        keyId: string | null;
        expiresAt: Date | null;
        lastUsedAt: Date | null;
        revokedAt: Date | null;
      }[]
    >`
      SELECT p.principal_id::text AS "principalId",p.name,p.kind,p.state,p.allowed_scopes AS scopes,
             k.key_id::text AS "keyId",k.expires_at AS "expiresAt",k.last_used_at AS "lastUsedAt",k.revoked_at AS "revokedAt"
        FROM service_principals p LEFT JOIN api_keys k ON k.tenant_id=p.tenant_id AND k.principal_id=p.principal_id
       WHERE p.tenant_id=${tenantId}::uuid ORDER BY p.created_at DESC,p.principal_id,k.created_at DESC LIMIT 100`;
  });
}
