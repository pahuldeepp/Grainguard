import {
  createOwnerDatabase,
  admitOwnerPlacement,
} from "@greenguard/membership-client/owner-db";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb, type Db } from "../db/client.js";
import {
  createBin,
  createSite,
  registerDevice,
  type CommandContext,
} from "../inventory/repository.js";

// Test-only trusted placement. Every business transaction still invokes the
// production local ownership admission; no runtime role can seed ownership.
const fixtureIncarnation = "20000000-0000-4000-8000-000000000091";
export async function fixtureRoute(tenantId: string) {
  await adminQuery(
    "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,1,'active') ON CONFLICT(tenant_id) DO NOTHING",
    [tenantId, fixtureIncarnation],
  );
  return {
    tenantId,
    shardId: "s1",
    shardIncarnation: fixtureIncarnation,
    placementEpoch: "1",
    state: "active" as const,
    expiresAt: new Date(Date.now() + 1900).toISOString(),
  };
}
export function fixtureDb(url: string, max = 5): Db {
  const physical = createDb(url, max, {});
  const role = decodeURIComponent(new URL(url).username);
  // Unused ring entries are descriptors only; all fixture work resolves to s1.
  const shards = Object.fromEntries(
    [1, 2, 3, 4].map((n) => {
      const endpoint = new URL(url);
      endpoint.port = String(Number(endpoint.port || 5432) + n - 1);
      return [
        `s${n}`,
        {
          incarnation: fixtureIncarnation,
          primaryUrl: endpoint.toString(),
          replicaUrls: [],
        },
      ];
    }),
  );
  createOwnerDatabase<Db>({
    legacyUrl: url,
    env: { SHARD_REGISTRY_FILE: "test-fixture", SHARD_LOCAL_LOOPBACK: "true" },
    service: "device-service",
    database: "greenguard_inventory",
    roles: [role],
    readRegistry: () =>
      JSON.stringify({
        formatVersion: 1,
        service: "device-service",
        database: "greenguard_inventory",
        shards,
      }),
    resolve: fixtureRoute,
    create: () => physical,
    close: (client) => client.$disconnect(),
  });
  return physical;
}

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
  fixtureDb(env("INVENTORY_DATABASE_URL"), maxConnections);

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

// Explicit administrator fixture transaction with the same placement admission.
export async function adminTenantQuery<T>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const route = await fixtureRoute(tenantId);
  const url = new URL(env("POSTGRES_ADMIN_URL"));
  url.pathname = "/greenguard_inventory";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await admitOwnerPlacement(tenantId, route, (statement, values) =>
      client.query(statement, values),
    );
    const rows = (await client.query(sql, params)).rows as T[];
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
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
  const route = await fixtureRoute(tenantId);
  const client = new pg.Client({
    connectionString: adminUrl(
      new URL(env("INVENTORY_DIRECT_URL")).pathname.slice(1),
    ),
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await admitOwnerPlacement(tenantId, route, (sql, params) =>
      client.query(sql, params),
    );
    await client.query(
      "INSERT INTO tenants (tenant_id,name) VALUES ($1::uuid,$2)",
      [tenantId, name],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

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
