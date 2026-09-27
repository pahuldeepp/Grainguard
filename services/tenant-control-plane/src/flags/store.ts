import { randomUUID } from "node:crypto";
import { checkTenantFlags, FLAG_REGISTRY } from "@greenguard/feature-flags";
import type { Db, Tx } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import {
  IdempotencyConflictError,
  InvalidInputError,
  NotFoundError,
  RoleForbiddenError,
  VersionConflictError,
} from "../domain/errors.js";
import { identityIdOf, nameId } from "../domain/ids.js";
import type { Actor, Command } from "../domain/store.js";

export type Rule = {
  value: boolean | string | number;
  rolloutPercent?: number;
  locked?: boolean;
};

/** Well-formed but not allowed for this caller: mapped to HTTP 422. */
export class FlagPolicyError extends Error {}
export type Flags = Record<string, Rule>;
export const GLOBAL_FLAG_TENANT = "00000000-0000-4000-8000-000000000001";
type Row = { config_id: string; config_version: bigint; flags: Flags };

async function writeConfiguration(
  tx: Tx,
  input: {
    tenantId: string;
    actorId: string;
    flags: Flags;
    expected: bigint;
    cmd: Command;
    request: string;
    scope: "tenant" | "global";
    commandType: "flags.put" | "flags.global.put";
  },
) {
  const {
    tenantId,
    actorId,
    flags,
    expected,
    cmd,
    request,
    scope,
    commandType,
  } = input;
  const [previous] = await tx.$queryRaw<
    Row[]
  >`SELECT config_id::text, config_version, flags FROM flag_configurations WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
  const current = previous?.config_version ?? 0n;
  if (current !== expected) throw new VersionConflictError(current);
  const version = current + 1n;
  const configId = previous?.config_id ?? randomUUID();
  if (previous)
    await tx.$executeRaw`UPDATE flag_configurations SET flags = ${JSON.stringify(flags)}::jsonb, config_version = ${version}, updated_by = ${actorId}::uuid, updated_at = clock_timestamp() WHERE tenant_id = ${tenantId}::uuid`;
  else
    await tx.$executeRaw`INSERT INTO flag_configurations (tenant_id, config_id, flags, config_version, updated_by) VALUES (${tenantId}::uuid, ${configId}::uuid, ${JSON.stringify(flags)}::jsonb, ${version}, ${actorId}::uuid)`;
  const auditId = nameId("flag-audit", tenantId, configId, String(version));
  await tx.$executeRaw`INSERT INTO flag_configuration_audit (tenant_id, audit_id, config_id, config_version, actor_identity_id, flags, correlation_id) VALUES (${tenantId}::uuid, ${auditId}::uuid, ${configId}::uuid, ${version}, ${actorId}::uuid, ${JSON.stringify(flags)}::jsonb, ${cmd.correlationId}::uuid)`;
  const eventId = nameId("flag-event", tenantId, configId, String(version));
  const payload = {
    scope,
    config_version: String(version),
    flags,
    actor_identity_id: actorId,
  };
  await tx.$executeRaw`INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, schema_version, occurred_at, correlation_id, causation_id, traceparent, payload) VALUES (${eventId}::uuid, ${tenantId}::uuid, 'flag_configuration', ${configId}::uuid, ${version}, 'flag.configuration_changed', 1, clock_timestamp(), ${cmd.correlationId}::uuid, ${cmd.correlationId}::uuid, ${cmd.traceparent}, ${JSON.stringify(payload)}::jsonb)`;
  const body = { version: String(version), flags };
  await tx.$executeRaw`INSERT INTO command_receipts (tenant_id, command_type, idempotency_key, normalized_request, response_body) VALUES (${tenantId}::uuid, ${commandType}, ${cmd.idempotencyKey}, ${request}::jsonb, ${JSON.stringify(body)}::jsonb)`;
  return body;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort((left, right) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      })
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function validateFlags(input: unknown): Flags {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InvalidInputError("flags must be an object");
  const flags: Flags = {};
  for (const [key, raw] of Object.entries(input)) {
    if (
      !/^[a-z][a-z0-9_.-]{0,127}$/.test(key) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    )
      throw new InvalidInputError("invalid flag rule");
    const rule = raw as Record<string, unknown>;
    if (
      Object.keys(rule).some(
        (k) => k !== "value" && k !== "rolloutPercent" && k !== "locked",
      ) ||
      (rule.locked !== undefined && typeof rule.locked !== "boolean") ||
      !["boolean", "string", "number"].includes(typeof rule.value) ||
      (typeof rule.value === "number" && !Number.isFinite(rule.value))
    )
      throw new InvalidInputError("invalid flag value");
    if (
      rule.rolloutPercent !== undefined &&
      (typeof rule.value !== "boolean" ||
        typeof rule.rolloutPercent !== "number" ||
        !Number.isFinite(rule.rolloutPercent) ||
        rule.rolloutPercent < 0 ||
        rule.rolloutPercent > 100)
    )
      throw new InvalidInputError("invalid rollout percentage");
    flags[key] = rule as Rule;
  }
  return flags;
}

/** Tenants may set only registered, tenant-settable keys (never `locked`). */
export function requireTenantSettable(flags: Flags): void {
  const problem = checkTenantFlags(flags);
  if (problem) throw new FlagPolicyError(problem);
}

/** The platform credential may only write registered keys. */
export function requireRegisteredFlags(flags: Flags): void {
  for (const key of Object.keys(flags))
    if (!Object.hasOwn(FLAG_REGISTRY, key))
      throw new FlagPolicyError(`unknown flag ${key}`);
}

async function admin(tx: Tx, tenantId: string, actor: Actor): Promise<string> {
  const actorId = identityIdOf(actor.issuer, actor.subject);
  const rows = await tx.$queryRaw<
    { role: string }[]
  >`SELECT m.role FROM memberships m JOIN organizations o USING (tenant_id) WHERE m.tenant_id = ${tenantId}::uuid AND m.identity_id = ${actorId}::uuid AND m.state = 'active' AND o.state = 'active'`;
  if (!rows.length) throw new NotFoundError();
  if (rows[0]!.role !== "admin") throw new RoleForbiddenError();
  return actorId;
}

export async function getFlags(db: Db, tenantId: string, actor: Actor) {
  if (!UUID.test(tenantId)) throw new InvalidInputError("invalid tenant ID");
  if (tenantId === GLOBAL_FLAG_TENANT) throw new NotFoundError();
  return inScope(db, { tenantId }, async (tx) => {
    await admin(tx, tenantId, actor);
    const [row] = await tx.$queryRaw<
      Row[]
    >`SELECT config_id::text, config_version, flags FROM flag_configurations WHERE tenant_id = ${tenantId}::uuid`;
    return {
      scope: "tenant",
      tenantId,
      version: String(row?.config_version ?? 0n),
      flags: row?.flags ?? {},
    };
  });
}

/** Trusted service snapshot lookup; the tenant is still scoped by forced RLS. */
export async function getFlagSnapshot(db: Db, tenantId: string) {
  if (!UUID.test(tenantId)) throw new InvalidInputError("invalid tenant ID");
  return inScope(db, { tenantId }, async (tx) => {
    const [org] = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM organizations WHERE tenant_id = ${tenantId}::uuid AND state = 'active'`;
    if (!org) throw new NotFoundError();
    const [row] = await tx.$queryRaw<
      Row[]
    >`SELECT config_id::text, config_version, flags FROM flag_configurations WHERE tenant_id = ${tenantId}::uuid`;
    return {
      scope:
        tenantId === GLOBAL_FLAG_TENANT
          ? ("global" as const)
          : ("tenant" as const),
      ...(tenantId === GLOBAL_FLAG_TENANT ? {} : { tenantId }),
      version: Number(row?.config_version ?? 0n),
      flags: row?.flags ?? {},
    };
  });
}

export async function putFlags(
  db: Db,
  tenantId: string,
  actor: Actor,
  flags: Flags,
  expected: bigint,
  cmd: Command,
) {
  if (!UUID.test(tenantId)) throw new InvalidInputError("invalid tenant ID");
  if (tenantId === GLOBAL_FLAG_TENANT) throw new NotFoundError();
  const request = JSON.stringify({ expected: String(expected), flags });
  return inScope(db, { tenantId }, async (tx) => {
    const [org] = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM organizations WHERE tenant_id = ${tenantId}::uuid AND state = 'active' FOR UPDATE`;
    if (!org) throw new NotFoundError();
    const actorId = await admin(tx, tenantId, actor);
    const lockKey = `${tenantId}|flags|${cmd.idempotencyKey}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const [receipt] = await tx.$queryRaw<
      {
        normalized_request: unknown;
        response_body: { version: string; flags: Flags };
      }[]
    >`SELECT normalized_request, response_body FROM command_receipts WHERE tenant_id = ${tenantId}::uuid AND command_type = 'flags.put' AND idempotency_key = ${cmd.idempotencyKey}`;
    if (receipt) {
      const prior = receipt.normalized_request as {
        expected?: string;
        flags?: Flags;
      };
      if (
        prior.expected !== String(expected) ||
        canonical(prior.flags) !== canonical(flags)
      )
        throw new IdempotencyConflictError();
      return receipt.response_body;
    }
    return writeConfiguration(tx, {
      tenantId,
      actorId,
      flags,
      expected,
      cmd,
      request,
      scope: "tenant",
      commandType: "flags.put",
    });
  });
}

/** Dedicated platform credential is checked by GlobalFlagsController. The actor ID
 * is configured with that credential and must exist; no caller-supplied actor field. */
export async function putGlobalFlags(
  db: Db,
  actorId: string,
  flags: Flags,
  expected: bigint,
  cmd: Command,
) {
  if (!UUID.test(actorId))
    throw new InvalidInputError("invalid platform actor ID");
  const tenantId = GLOBAL_FLAG_TENANT;
  const request = JSON.stringify({ expected: String(expected), flags });
  return inScope(db, { tenantId }, async (tx) => {
    const [actor] = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM identities WHERE identity_id = ${actorId}::uuid`;
    if (!actor) throw new NotFoundError("platform actor");
    const [org] = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM organizations WHERE tenant_id = ${tenantId}::uuid FOR UPDATE`;
    if (!org) throw new NotFoundError();
    const lockKey = `${tenantId}|flags.global|${cmd.idempotencyKey}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const [receipt] = await tx.$queryRaw<
      {
        normalized_request: { expected: string; flags: Flags };
        response_body: { version: string; flags: Flags };
      }[]
    >`SELECT normalized_request, response_body FROM command_receipts WHERE tenant_id = ${tenantId}::uuid AND command_type = 'flags.global.put' AND idempotency_key = ${cmd.idempotencyKey}`;
    if (receipt) {
      if (
        receipt.normalized_request.expected !== String(expected) ||
        canonical(receipt.normalized_request.flags) !== canonical(flags)
      )
        throw new IdempotencyConflictError();
      return receipt.response_body;
    }
    return writeConfiguration(tx, {
      tenantId,
      actorId,
      flags,
      expected,
      cmd,
      request,
      scope: "global",
      commandType: "flags.global.put",
    });
  });
}
