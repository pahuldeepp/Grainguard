import pg from "pg";
import type { AuditEnvelope } from "@greenguard/audit";
import { UUID } from "../db/session.js";
import { InvalidInputError } from "../domain/errors.js";

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
  constructor(inventoryDatabaseUrl: string, billingDatabaseUrl: string) {
    this.inventory = new pg.Pool({
      connectionString: inventoryDatabaseUrl,
      max: 3,
    });
    this.billing = new pg.Pool({
      connectionString: billingDatabaseUrl,
      max: 3,
    });
  }
  async close() {
    await Promise.all([this.inventory.end(), this.billing.end()]);
  }
  async read(
    owner: AuditOwner,
    tenantId: string,
    from: Date,
    to: Date,
    cursor: { at: string; id: string } | null,
    limit: number,
  ): Promise<AuditEnvelope[]> {
    if (
      !UUID.test(tenantId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 501
    )
      throw new InvalidInputError("invalid audit query");
    const client = await (
      owner === "inventory" ? this.inventory : this.billing
    ).connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [
        tenantId,
      ]);
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
