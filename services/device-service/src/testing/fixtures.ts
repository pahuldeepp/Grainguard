import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb, type Db } from "../db/client.js";
import {
  createBin,
  createSite,
  registerDevice,
  type CommandContext,
} from "../inventory/repository.js";

export function env(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required: run make bootstrap and make db-migrate`,
    );
  return value;
}

// Runtime path: inventory_app through PgBouncer in transaction-pooling mode.
export const pooledDb = (maxConnections = 5): Db =>
  createDb(env("INVENTORY_DATABASE_URL"), maxConnections);

export function adminUrl(database: string): string {
  const url = new URL(env("POSTGRES_ADMIN_URL"));
  url.pathname = `/${database}`;
  return url.toString();
}

async function query<T>(url: string, sql: string, params: unknown[]) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

// Superuser: bypasses RLS, so tests can inspect what really was written.
export const adminQuery = <T>(sql: string, params: unknown[] = []) =>
  query<T>(
    adminUrl(new URL(env("INVENTORY_DIRECT_URL")).pathname.slice(1)),
    sql,
    params,
  );

// Test fixture only: inserts a control-plane-shaped tenant snapshot using the
// local administrator. Runtime inventory_app has no INSERT privilege on tenants.
export async function createTenant(_db: Db, tenantId: string, name: string) {
  await adminQuery(
    "INSERT INTO tenants (tenant_id,name) VALUES ($1::uuid,$2)",
    [tenantId, name],
  );
}

// inventory_app over a direct session, with no tenant context set.
export const appQuery = <T>(sql: string, params: unknown[] = []) =>
  query<T>(env("INVENTORY_DIRECT_URL"), sql, params);

export interface TenantFixture {
  tenantId: string;
  siteId: string;
  otherSiteId: string;
  binId: string;
  deviceId: string;
}

export function context(
  tenantId: string,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    tenantId,
    actorType: "user",
    actorId: "test-user",
    correlationId: randomUUID(),
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

export async function seedTenant(db: Db): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const binId = randomUUID();
  await createTenant(db, tenantId, `tenant ${tenantId.slice(0, 8)}`);
  await createSite(db, context(tenantId), siteId, "North yard");
  await createSite(db, context(tenantId), otherSiteId, "South yard");
  await createBin(db, context(tenantId), { binId, siteId, name: "Bin 1" });
  const { deviceId } = await registerDevice(db, context(tenantId), {
    serialNumber: `SN-${randomUUID()}`,
    siteId,
    binId,
  });
  return { tenantId, siteId, otherSiteId, binId, deviceId };
}
