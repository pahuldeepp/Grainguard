import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "./client.js";
import {
  InvalidTenantError,
  LockNotAvailableError,
  postgresCode,
} from "./errors.js";

export type Tx = Prisma.TransactionClient;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuid = (value: string): boolean => UUID.test(value);

export function assertTenantId(tenantId: string): void {
  if (!isUuid(tenantId)) throw new InvalidTenantError();
}

export interface TenantTxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  // Bounds how long any statement in the transaction waits for a row lock.
  lockTimeoutMs?: number;
  timeoutMs?: number;
}

// Every tenant-scoped query runs inside this helper. The tenant is set with
// set_config(..., true), so it is transaction-local and cannot leak to the next
// user of a pooled (PgBouncer transaction-mode) connection.
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  work: (tx: Tx) => Promise<T>,
  options: TenantTxOptions = {},
): Promise<T> {
  assertTenantId(tenantId);
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        if (options.lockTimeoutMs !== undefined) {
          const lockTimeout = `${options.lockTimeoutMs}ms`;
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
        }
        return work(tx);
      },
      { isolationLevel: options.isolationLevel, timeout: options.timeoutMs },
    );
  } catch (error) {
    if (postgresCode(error) === "55P03") throw new LockNotAvailableError();
    throw error;
  }
}
