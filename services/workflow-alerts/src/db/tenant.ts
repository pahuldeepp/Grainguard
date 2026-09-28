import {
  admitOwnerPlacement,
  resolveOwnerDatabase,
} from "@greenguard/membership-client/owner-db";
import type { Db, Tx } from "./client.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

export class InvalidTenantError extends Error {
  constructor() {
    super("tenant id must be a lowercase, non-nil UUID");
  }
}

export class LockTimeoutError extends Error {
  constructor() {
    super("alert episode is locked by another transaction");
  }
}

// PostgreSQL SQLSTATE as carried by the pg driver adapter inside a Prisma error.
export function sqlState(error: unknown): string | undefined {
  const cause = (
    error as { meta?: { driverAdapterError?: { cause?: unknown } } } | null
  )?.meta?.driverAdapterError?.cause as { originalCode?: unknown } | undefined;
  return typeof cause?.originalCode === "string"
    ? cause.originalCode
    : undefined;
}

// Every tenant query runs here: the tenant is transaction-local (set_config(..., true)),
// so it cannot leak to the next user of a PgBouncer server connection. Row locks
// are always bounded by lock_timeout (ADR-0002).
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  work: (tx: Tx) => Promise<T>,
  lockTimeoutMs = 2000,
  isolationLevel?: "RepeatableRead",
): Promise<T> {
  if (!isUuid(tenantId)) throw new InvalidTenantError();
  const lockTimeout = `${lockTimeoutMs}ms`;
  try {
    const owner = await resolveOwnerDatabase(db, tenantId);
    return await owner.database.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
        await tx.$executeRaw`SELECT set_config('statement_timeout', '5000ms', true)`;
        if (owner.route)
          await admitOwnerPlacement(tenantId, owner.route, (sql, params) =>
            tx.$executeRawUnsafe(sql, ...params),
          );
        else
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return work(tx);
      },
      { isolationLevel },
    );
  } catch (error) {
    if (sqlState(error) === "55P03") throw new LockTimeoutError();
    throw error;
  }
}

// Transaction-scoped advisory lock: serializes work on one logical key.
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
