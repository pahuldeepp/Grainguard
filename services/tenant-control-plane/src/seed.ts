import { randomUUID } from "node:crypto";
import { parseMemberships } from "@greenguard/tenant-auth";
import type { Db } from "./db/client.js";
import { inScope } from "./db/session.js";
import { nameId } from "./domain/ids.js";
import { grantFirstMembership, insertOrganization } from "./domain/store.js";
import { currentTraceparent } from "./trace.js";

const HUMAN = new Set(["viewer", "operator", "admin"]);
const SEED_ACTOR = nameId("identity", "greenguard", "seed");

// Migrates the static AUTH_MEMBERSHIP_FILE (infra/oidc/memberships.json) into the
// store: organizations keep the existing tenant IDs (backfill step 1 of the
// ownership move), memberships keep issuer|subject. Idempotent: a rerun writes nothing.
export async function seedFromMembershipFile(db: Db, json: string) {
  const entries = [...parseMemberships(json)].map(([key, membership]) => {
    // Issuers are URLs without "|"; subjects (auth0|abc) may contain one.
    const at = key.indexOf("|");
    if (membership.roles.length !== 1 || !HUMAN.has(membership.roles[0]!))
      throw new Error("each seeded membership needs exactly one human role");
    return {
      issuer: key.slice(0, at),
      subject: key.slice(at + 1),
      ...membership,
    };
  });
  let created = 0;
  for (const entry of entries) {
    const cmd = {
      idempotencyKey: "seed",
      correlationId: randomUUID(),
      traceparent: currentTraceparent(),
    };
    const granted = await inScope(
      db,
      { tenantId: entry.tenantId },
      async (tx) => {
        await insertOrganization(
          tx,
          entry.tenantId,
          `Tenant ${entry.tenantId.slice(0, 8)}`,
          SEED_ACTOR,
          cmd,
        );
        const [organization] = await tx.$queryRaw<{ state: string }[]>`
          SELECT state FROM organizations WHERE tenant_id=${entry.tenantId}::uuid`;
        // Static membership import must not activate access for a newly
        // requested tenant. Existing active tenants retain the legacy seed path.
        if (organization?.state !== "active") return false;
        return grantFirstMembership(
          tx,
          entry.tenantId,
          entry,
          entry.roles[0]!,
          SEED_ACTOR,
          cmd,
        );
      },
    );
    if (granted) created++;
  }
  return { created, existing: entries.length - created };
}
