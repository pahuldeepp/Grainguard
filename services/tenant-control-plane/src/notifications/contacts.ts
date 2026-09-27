import type { Db, Tx } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import {
  InvalidInputError,
  NotFoundError,
  RoleForbiddenError,
  VersionConflictError,
} from "../domain/errors.js";
import { identityIdOf } from "../domain/ids.js";
import type { Actor } from "../domain/store.js";

export interface NotificationContacts {
  email: string | null;
  sms: string | null;
  version: string;
}

export function validateContacts(input: unknown): {
  email: string | null;
  sms: string | null;
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InvalidInputError("notification contacts must be an object");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["email", "sms"].includes(key)))
    throw new InvalidInputError("unknown notification contact field");
  if (!Object.hasOwn(value, "email") && !Object.hasOwn(value, "sms"))
    throw new InvalidInputError(
      "at least one notification contact field is required",
    );
  const email = value.email ?? null;
  const sms = value.sms ?? null;
  const emailAt = typeof email === "string" ? email.indexOf("@") : -1;
  const emailDomainDot =
    typeof email === "string" ? email.lastIndexOf(".") : -1;
  if (
    email !== null &&
    (typeof email !== "string" ||
      email.length > 320 ||
      emailAt < 1 ||
      emailAt !== email.lastIndexOf("@") ||
      emailDomainDot <= emailAt + 1 ||
      emailDomainDot === email.length - 1 ||
      /[\s<>;,"\p{Cc}]/u.test(email))
  )
    throw new InvalidInputError("invalid notification email");
  if (
    sms !== null &&
    (typeof sms !== "string" || !/^\+[1-9]\d{7,14}$/.test(sms))
  )
    throw new InvalidInputError("notification SMS number must be E.164");
  if (
    email === null &&
    sms === null &&
    (!Object.hasOwn(value, "email") || !Object.hasOwn(value, "sms"))
  )
    throw new InvalidInputError(
      "clearing all notification contacts requires explicit email and sms null values",
    );
  return { email: email as string | null, sms: sms as string | null };
}

async function requireAdmin(tx: Tx, tenantId: string, actor: Actor) {
  const actorId = identityIdOf(actor.issuer, actor.subject);
  const rows = await tx.$queryRaw<{ role: string }[]>`
    SELECT m.role FROM memberships m JOIN organizations o USING (tenant_id)
     WHERE m.tenant_id = ${tenantId}::uuid AND m.identity_id = ${actorId}::uuid
       AND m.state = 'active' AND o.state = 'active'`;
  if (!rows.length) throw new NotFoundError();
  if (rows[0]!.role !== "admin") throw new RoleForbiddenError();
  return actorId;
}

export async function getNotificationContacts(
  db: Db,
  tenantId: string,
): Promise<NotificationContacts> {
  if (
    !UUID.test(tenantId) ||
    tenantId === "00000000-0000-4000-8000-000000000001"
  )
    throw new InvalidInputError("invalid tenant ID");
  return inScope(db, { tenantId }, async (tx) => {
    const [org] = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM organizations WHERE tenant_id=${tenantId}::uuid AND state='active'`;
    if (!org) throw new NotFoundError();
    const [row] = await tx.$queryRaw<
      { email_to: string | null; sms_to: string | null; version: bigint }[]
    >`
      SELECT email_to, sms_to, version FROM notification_contacts WHERE tenant_id=${tenantId}::uuid`;
    if (!row) throw new NotFoundError("notification contacts");
    return {
      email: row.email_to,
      sms: row.sms_to,
      version: String(row.version),
    };
  });
}

export async function putNotificationContacts(
  db: Db,
  tenantId: string,
  actor: Actor,
  contacts: { email: string | null; sms: string | null },
  expectedVersion: bigint,
) {
  if (
    !UUID.test(tenantId) ||
    tenantId === "00000000-0000-4000-8000-000000000001"
  )
    throw new InvalidInputError("invalid tenant ID");
  contacts = validateContacts(contacts);
  const maxVersion = 9223372036854775807n;
  if (
    typeof expectedVersion !== "bigint" ||
    expectedVersion < 0n ||
    expectedVersion > maxVersion
  )
    throw new InvalidInputError("invalid notification contact version");
  return inScope(db, { tenantId }, async (tx) => {
    // The organization lock serializes initial inserts and updates against membership
    // revocation; the expected version then prevents a stale admin from overwriting.
    const [org] = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM organizations WHERE tenant_id=${tenantId}::uuid AND state='active' FOR UPDATE`;
    if (!org) throw new NotFoundError();
    const actorId = await requireAdmin(tx, tenantId, actor);
    const [row] = await tx.$queryRaw<
      { version: bigint }[]
    >`SELECT version FROM notification_contacts WHERE tenant_id=${tenantId}::uuid FOR UPDATE`;
    const current = row?.version ?? 0n;
    if (current !== expectedVersion) throw new VersionConflictError(current);
    if (current === maxVersion)
      throw new InvalidInputError("notification contact version exhausted");
    const next = current + 1n;
    if (row) {
      await tx.$executeRaw`UPDATE notification_contacts SET email_to=${contacts.email}, sms_to=${contacts.sms}, version=${next}, updated_by=${actorId}::uuid, updated_at=clock_timestamp() WHERE tenant_id=${tenantId}::uuid`;
    } else {
      await tx.$executeRaw`INSERT INTO notification_contacts (tenant_id,email_to,sms_to,version,updated_by) VALUES (${tenantId}::uuid,${contacts.email},${contacts.sms},${next},${actorId}::uuid)`;
    }
    return { ...contacts, version: String(next) };
  });
}
