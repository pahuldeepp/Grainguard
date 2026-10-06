import { InvalidInputError } from "../domain/errors.js";
import type { Db, Tx } from "./client.js";

export const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export class ResourceLockedError extends Error {
  constructor() {
    super("organization is locked by another command; retry");
  }
}

// Exactly one context is set at a time: a tenant (commands and reads) or an
// identity (membership candidate discovery). A lookup may switch to tenant
// checks inside the same consistent snapshot. Both contexts are
// transaction-local, so nothing leaks to the next PgBouncer client.
export type Scope = { tenantId: string } | { identityId: string };

export async function inScope<T>(
  db: Db,
  scope: Scope,
  work: (tx: Tx) => Promise<T>,
  options?: { isolationLevel: "RepeatableRead" },
): Promise<T> {
  const id = "tenantId" in scope ? scope.tenantId : scope.identityId;
  if (!UUID.test(id))
    throw new InvalidInputError("identifiers must be lowercase UUIDs");
  const tenant = "tenantId" in scope ? id : "";
  const identity = "identityId" in scope ? id : "";
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant}, true),
        set_config('app.identity_id', ${identity}, true), set_config('lock_timeout', '2s', true)`;
      return work(tx);
    }, options);
  } catch (error) {
    if (/lock timeout/i.test(String((error as { message?: unknown })?.message)))
      throw new ResourceLockedError();
    throw error;
  }
}
