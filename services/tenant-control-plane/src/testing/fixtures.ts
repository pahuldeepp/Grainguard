import { outboxRowToEvent } from "@greenguard/contracts";
import pg from "pg";
import { createDb, type Db } from "../db/client.js";
import { inScope } from "../db/session.js";
import {
  grantFirstMembership,
  createOrganization,
  type Actor,
  type Command,
} from "../domain/store.js";
import { identityIdOf } from "../domain/ids.js";

export function env(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required: run make bootstrap and make db-migrate`,
    );
  return value;
}

// Runtime path: control_app (PgBouncer in the full stack).
export const runtimeDb = (max = 5): Db =>
  createDb(env("CONTROL_DATABASE_URL"), max);

/**
 * Trusted fixture helper for domain tests that need an already usable tenant.
 * It explicitly simulates the post-owner-bootstrap activation step. Production
 * creation never calls this helper and remains provisioning until owner proofs
 * are available.
 */
export async function createActiveTenantFixture(
  db: Db,
  actor: Actor,
  name: string,
  cmd: Command,
) {
  const created = await createOrganization(db, actor, { name }, cmd);
  const tenantId = created.body.tenantId as string;
  await activateTenantFixture(db, actor, tenantId, cmd);
  return created;
}

/** Trusted test-only completion for an organization created through HTTP. */
export async function activateTenantFixture(
  db: Db,
  actor: Actor,
  tenantId: string,
  cmd: Command,
): Promise<void> {
  await inScope(db, { tenantId }, async (tx) => {
    await tx.$executeRaw`UPDATE organizations SET state='active',updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}::uuid AND state='provisioning'`;
    await grantFirstMembership(
      tx,
      tenantId,
      actor,
      "admin",
      identityIdOf(actor.issuer, actor.subject),
      cmd,
    );
  });
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

// Superuser view (bypasses RLS) of greenguard_control, to see what was written.
export function adminQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) {
  const url = new URL(env("POSTGRES_ADMIN_URL"));
  url.pathname = new URL(env("CONTROL_DATABASE_URL")).pathname;
  return query<T>(url.toString(), sql, params);
}

// control_app over a direct session in one transaction with the given settings.
export async function asRuntime(
  settings: Record<string, string>,
  sql: string,
  params: unknown[] = [],
) {
  const client = new pg.Client({ connectionString: env("CONTROL_DIRECT_URL") });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of Object.entries(settings))
      await client.query("SELECT set_config($1, $2, true)", [key, value]);
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

export const tenantRows = (table: string, tenantId: string) =>
  adminQuery(`SELECT * FROM ${table} WHERE tenant_id = $1`, [tenantId]);

let seq = 0;
export const uniqueSubject = (label: string) =>
  `${label}-${process.pid}-${Date.now()}-${++seq}`;
export const ISSUER = "https://issuer.test";

// The committed outbox rows of a tenant, as the canonical events CDC would publish.
export async function outboxEvents(tenantId: string) {
  const rows = await adminQuery<Record<string, unknown>>(
    `SELECT event_id AS "eventId", tenant_id AS "tenantId", aggregate_type AS "aggregateType",
            aggregate_id AS "aggregateId", aggregate_version AS "aggregateVersion",
            event_type AS "eventType", schema_version AS "schemaVersion", occurred_at AS "occurredAt",
            correlation_id AS "correlationId", causation_id AS "causationId", traceparent, payload
       FROM outbox_events WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return rows.map((r) =>
    outboxRowToEvent({
      ...r,
      aggregateVersion: BigInt(r.aggregateVersion as string),
    } as never),
  );
}
