import { randomUUID } from "node:crypto";
import type { Db } from "./db/client.js";
import { inScope, UUID } from "./db/session.js";
import { identityIdOf, nameId } from "./domain/ids.js";
import {
  grantFirstMembership,
  insertOrganization,
  lookupMembership,
} from "./domain/store.js";
import { currentTraceparent } from "./trace.js";

export interface CognitoEnrollment {
  issuer: string;
  subject: string;
  tenantId: string;
  role: "admin";
}

// Bootstrap is deliberately limited to the first admin of a NEW tenant. Existing
// tenants must use the authenticated invitation workflow; a CLI cannot grant a
// role merely because its operator knows an issuer and subject.
export function validateCognitoEnrollment(
  input: Record<string, unknown>,
): CognitoEnrollment {
  const { issuer, subject, tenantId, role } = input;
  if (
    typeof issuer !== "string" ||
    !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(
      issuer,
    )
  )
    throw new Error(
      "ENROLL_ISSUER must be an exact Cognito user-pool issuer URL",
    );
  if (typeof subject !== "string" || !UUID.test(subject))
    throw new Error(
      "ENROLL_SUBJECT must be the verified Cognito user's lowercase UUID sub",
    );
  if (typeof tenantId !== "string" || !UUID.test(tenantId))
    throw new Error("ENROLL_TENANT_ID must be a lowercase UUID");
  if (role !== "admin")
    throw new Error("initial enrollment only accepts ENROLL_ROLE=admin");
  return { issuer, subject, tenantId, role };
}

export async function enrollFirstCognitoAdmin(
  db: Db,
  input: CognitoEnrollment,
): Promise<"created" | "existing"> {
  const current = await lookupMembership(db, input.issuer, input.subject);
  if (current && current.tenantId !== input.tenantId)
    throw new Error("identity already belongs to another tenant");
  const identityId = identityIdOf(input.issuer, input.subject);
  const seedActor = nameId("identity", "greenguard", "seed");
  return inScope(db, { tenantId: input.tenantId }, async (tx) => {
    const cmd = {
      idempotencyKey: "cognito-first-admin",
      correlationId: randomUUID(),
      traceparent: currentTraceparent(),
    };
    const created = await insertOrganization(
      tx,
      input.tenantId,
      `Tenant ${input.tenantId.slice(0, 8)}`,
      seedActor,
      cmd,
    );
    if (!created) {
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
    const granted = await grantFirstMembership(
      tx,
      input.tenantId,
      { issuer: input.issuer, subject: input.subject },
      "admin",
      seedActor,
      cmd,
    );
    if (!granted) throw new Error("initial admin membership already exists");
    return "created";
  });
}
