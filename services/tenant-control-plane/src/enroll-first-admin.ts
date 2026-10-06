import { randomUUID } from "node:crypto";
import type { Db } from "./db/client.js";
import { inScope, UUID } from "./db/session.js";
import { identityIdOf } from "./domain/ids.js";
import {
  ensureIdentity,
  insertOrganization,
  lookupMembership,
} from "./domain/store.js";
import { currentTraceparent } from "./trace.js";
import { enqueueTenantBootstrap } from "./tenant-bootstrap/jobs.js";

export interface FirstAdminEnrollment {
  issuer: string;
  subject: string;
  tenantId: string;
  role: "admin";
}

// Bootstrap is deliberately limited to the first admin of a NEW tenant. The
// caller must supply an access token verified against the configured OIDC
// issuer/JWKS/audience before these claims reach this database operation.
export function validateFirstAdminEnrollment(
  input: Record<string, unknown>,
): FirstAdminEnrollment {
  const { issuer, subject, tenantId, role } = input;
  if (
    typeof issuer !== "string" ||
    !/^https:\/\/[^/?#@\s]+(?:\/[^?#\s]*)?$/.test(issuer) ||
    issuer.length > 512
  )
    throw new Error(
      "ENROLL_ISSUER must be the exact configured HTTPS OIDC issuer",
    );
  // OIDC `sub` is provider-defined. Auth0, Dex and many other providers use
  // non-UUID subjects, so accept bounded opaque values but reject whitespace
  // and control characters before using it as an identity key.
  if (
    typeof subject !== "string" ||
    !subject ||
    subject.length > 512 ||
    [...subject].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return /\s/.test(character) || codePoint < 0x20 || codePoint === 0x7f;
    })
  )
    throw new Error(
      "ENROLL_SUBJECT must be the verified, bounded OIDC sub claim",
    );
  if (typeof tenantId !== "string" || !UUID.test(tenantId))
    throw new Error("ENROLL_TENANT_ID must be a lowercase UUID");
  if (role !== "admin")
    throw new Error("initial enrollment only accepts ENROLL_ROLE=admin");
  return { issuer, subject, tenantId, role };
}

export async function enrollFirstAdmin(
  db: Db,
  input: FirstAdminEnrollment,
): Promise<"provisioning" | "existing"> {
  const current = await lookupMembership(db, input.issuer, input.subject);
  if (current && current.tenantId !== input.tenantId)
    throw new Error("identity already belongs to another tenant");
  const identityId = identityIdOf(input.issuer, input.subject);
  return inScope(db, { tenantId: input.tenantId }, async (tx) => {
    const cmd = {
      idempotencyKey: "oidc-first-admin",
      correlationId: randomUUID(),
      traceparent: currentTraceparent(),
    };
    const actor = { issuer: input.issuer, subject: input.subject };
    await ensureIdentity(tx, actor);
    const created = await insertOrganization(
      tx,
      input.tenantId,
      `Tenant ${input.tenantId.slice(0, 8)}`,
      identityId,
      cmd,
    );
    if (!created) {
      const [organization] = await tx.$queryRaw<
        { state: string; created_by: string }[]
      >`
        SELECT state,created_by::text FROM organizations WHERE tenant_id=${input.tenantId}::uuid`;
      if (
        organization?.state === "provisioning" &&
        organization.created_by === identityId
      ) {
        await enqueueTenantBootstrap(tx, input.tenantId, identityId, cmd);
        return "provisioning";
      }
      const rows = await tx.$queryRaw<{ role: string; state: string }[]>`
        SELECT role, state FROM memberships WHERE tenant_id = ${input.tenantId}::uuid
          AND identity_id = ${identityId}::uuid`;
      if (
        rows.length === 1 &&
        rows[0]?.role === "admin" &&
        rows[0]?.state === "active"
      )
        return "existing";
      throw new Error(
        "tenant already exists; use the authenticated invitation workflow",
      );
    }
    await enqueueTenantBootstrap(tx, input.tenantId, identityId, cmd);
    // OIDC verification and explicit enrollment are necessary, but owner DB
    // acknowledgements are still required before this principal gains access.
    return "provisioning";
  });
}
