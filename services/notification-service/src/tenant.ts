import {
  admitOwnerPlacement,
  createOwnerDatabase,
  resolveOwnerDatabase,
} from "@greenguard/membership-client/owner-db";
import pg from "pg";
import { registerPostgresPool } from "@greenguard/otel";
import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export class InvalidTenantError extends Error {
  constructor() {
    super("tenant identifier must be a lowercase UUID");
  }
}

/**
 * Runs fn in one transaction with a transaction-local tenant context
 * (set_config(..., true)), which is safe under PgBouncer transaction pooling.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { freshPlacement?: boolean } = {},
): Promise<T> {
  if (!isUuid(tenantId)) throw new InvalidTenantError();
  const owner = await resolveOwnerDatabase(pool, tenantId, {
    fresh: options.freshPlacement,
  });
  const client = await owner.database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await admitOwnerPlacement(tenantId, owner.route, (sql, params) =>
      client.query(sql, params),
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Operational delivery state is tenant-owned; no shared provider ledger pool. */
export function createNotificationPool(
  url: string,
  max: number,
  env: NodeJS.ProcessEnv = process.env,
): Pool {
  return createOwnerDatabase({
    legacyUrl: url,
    env,
    service: "notification-service",
    database: "greenguard_notifications",
    roles: ["notifications_app"],
    create: (connectionString) => {
      const pool = new pg.Pool({
        connectionString,
        max,
        connectionTimeoutMillis: 2000,
        query_timeout: 5000,
      });
      registerPostgresPool(pool, "notification_service");
      return pool;
    },
    close: (pool) => pool.end(),
  });
}
