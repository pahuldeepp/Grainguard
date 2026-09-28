import pg from "pg";
import type { AuditEnvelope } from "@greenguard/audit";
import { UUID } from "../db/session.js";
import { InvalidInputError } from "../domain/errors.js";
import {
  createOwnerDatabase,
  resolveOwnerDatabase,
  admitOwnerPlacement,
  closeOwnerDatabase,
  ownerDatabases,
} from "@greenguard/membership-client/owner-db";
import type { TenantRoute } from "@greenguard/membership-client";

type Row = {
  audit_id: string;
  occurred_at: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: string;
};
export type AuditOwner = "inventory" | "billing";
export type AuditReader = Pick<AuditSources, "read">;
export type AuditSourceOptions = Readonly<{
  registryFileEnv?: string;
  service?: string;
  roles?: readonly string[];
}>;
const SQL: Record<AuditOwner, string> = {
  inventory: `SELECT audit_id::text,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
    actor_id, action, resource_type, resource_id::text, outcome
    FROM audit_events WHERE tenant_id=$1::uuid AND occurred_at >= $2::timestamptz
      AND occurred_at < $3::timestamptz
      AND ($4::timestamptz IS NULL OR
           (occurred_at,audit_id) > ($4::timestamptz,$5::uuid))
    ORDER BY occurred_at,audit_id LIMIT $6`,
  billing: `SELECT audit_id::text,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
    actor_id, action, 'billing'::text AS resource_type,
    object_id AS resource_id, 'success'::text AS outcome
    FROM billing_audit_events WHERE tenant_id=$1::uuid AND occurred_at >= $2::timestamptz
      AND occurred_at < $3::timestamptz
      AND ($4::timestamptz IS NULL OR
           (occurred_at,audit_id) > ($4::timestamptz,$5::uuid))
    ORDER BY occurred_at,audit_id LIMIT $6`,
};

export class AuditSources {
  private readonly inventory: pg.Pool;
  private readonly billing: pg.Pool;
  constructor(
    inventoryDatabaseUrl: string,
    billingDatabaseUrl: string,
    env: NodeJS.ProcessEnv = process.env,
    options: AuditSourceOptions = {},
  ) {
    const registryFileEnv =
      options.registryFileEnv ?? "INVENTORY_SHARD_REGISTRY_FILE";
    this.inventory = createOwnerDatabase({
      legacyUrl: inventoryDatabaseUrl,
      env: { ...env, SHARD_REGISTRY_FILE: env[registryFileEnv] },
      service: options.service ?? "device-service",
      database: "greenguard_inventory",
      roles: options.roles ?? ["inventory_app"],
      create: (url) =>
        new pg.Pool({
          connectionString: url,
          max: 3,
          connectionTimeoutMillis: 2000,
          query_timeout: 4000,
        }),
      close: (pool) => pool.end(),
    });
    this.billing = new pg.Pool({
      connectionString: billingDatabaseUrl,
      max: 3,
    });
  }
  async close() {
    await Promise.all([
      closeOwnerDatabase(this.inventory, 5000, (pool) => pool.end()),
      this.billing.end(),
    ]);
  }
  /** Probe every configured inventory shard and central billing source. */
  async healthcheck(): Promise<void> {
    await Promise.all([
      ...ownerDatabases(this.inventory).map((database) =>
        (database as pg.Pool).query("SELECT 1"),
      ),
      this.billing.query("SELECT 1"),
    ]);
  }
  /** A multi-page export restarts if placement changes between pages. */
  async session(tenantId: string): Promise<AuditReader> {
    const { route } = await resolveOwnerDatabase(this.inventory, tenantId);
    return {
      read: async (owner, tenant, from, to, cursor, limit) => {
        if (tenant !== tenantId)
          throw new InvalidInputError("audit session tenant mismatch");
        return this.read(owner, tenant, from, to, cursor, limit, route);
      },
    };
  }
  async read(
    owner: AuditOwner,
    tenantId: string,
    from: Date,
    to: Date,
    cursor: { at: string; id: string } | null,
    limit: number,
    expectedPlacement?: TenantRoute,
  ): Promise<AuditEnvelope[]> {
    if (
      !UUID.test(tenantId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 501
    )
      throw new InvalidInputError("invalid audit query");
    const selected =
      owner === "inventory"
        ? await resolveOwnerDatabase(this.inventory, tenantId, { fresh: true })
        : { database: this.billing, route: undefined };
    if (
      owner === "inventory" &&
      expectedPlacement &&
      (!selected.route ||
        selected.route.shardId !== expectedPlacement.shardId ||
        selected.route.shardIncarnation !==
          expectedPlacement.shardIncarnation ||
        selected.route.placementEpoch !== expectedPlacement.placementEpoch)
    )
      throw new Error("audit source placement changed; restart export");
    const client = await selected.database.connect();
    try {
      // Hold a shared ownership lock until this primary page commits.
      await client.query(selected.route ? "BEGIN" : "BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '4s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await admitOwnerPlacement(tenantId, selected.route, (sql, values) =>
        client.query(sql, values),
      );
      const result = await client.query<Row>(SQL[owner], [
        tenantId,
        from,
        to,
        cursor?.at ?? null,
        cursor?.id ?? null,
        limit,
      ]);
      await client.query("COMMIT");
      return result.rows.map((r) => ({
        auditId: r.audit_id,
        tenantId,
        occurredAt: r.occurred_at,
        actorId: r.actor_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        outcome: r.outcome,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
