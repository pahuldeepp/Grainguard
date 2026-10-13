import type { Pool } from "pg";

/**
 * Alerts deliberately exposes a preflight, not a copy/activate adapter yet.
 * Its outbox is a CDC publication and downstream alert effects are owned by
 * Jobs/Notifications. Copying the rows without a coordinated owner protocol
 * can replay external effects or strand consumer offsets.
 */
const ALERTS_TABLES = [
  "alert_episodes",
  "alert_rules",
  "alert_transitions",
  "command_receipts",
  "consumer_inbox",
  "outbox_events",
  "risk_stream_positions",
] as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AlertsMoveBlockers {
  cdcOutboxRows: string;
}

/** Fail closed on schema drift, partitioning, and uncoordinated CDC effects. */
export async function assertAlertsMovePreflight(
  pool: Pool,
  tenantId: string,
): Promise<void> {
  if (!UUID.test(tenantId)) throw new Error("invalid alerts move tenant id");

  const schema = await pool.query<{
    table_name: string;
    relkind: string;
    is_partition: boolean;
  }>(`
    SELECT c.relname AS table_name,c.relkind,c.relispartition AS is_partition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped)
    ORDER BY c.relname`);
  const actual = schema.rows.map((row) => row.table_name);
  if (
    actual.length !== ALERTS_TABLES.length ||
    actual.some((name, index) => name !== ALERTS_TABLES[index]) ||
    schema.rows.some((row) => row.relkind !== "r" || row.is_partition)
  ) {
    throw new Error(
      `alerts move schema differs from its reviewed table inventory; expected ${ALERTS_TABLES.join(",")}, got ${actual.join(",")}`,
    );
  }

  const effects = await pool.query<AlertsMoveBlockers>(
    `SELECT count(*)::text AS "cdcOutboxRows"
     FROM public.outbox_events WHERE tenant_id=$1::uuid`,
    [tenantId],
  );
  const blockers = effects.rows[0];
  if (!blockers)
    throw new Error("alerts move effect preflight returned no result");

  // PostgreSQL logical publication does not retain a per-row acknowledgement
  // that proves all downstream consumers have applied historical records.
  // Therefore any history is enough to refuse this owner-only move attempt.
  if (BigInt(blockers.cdcOutboxRows) > 0n) {
    throw new Error(
      `alerts tenant move blocked: ${blockers.cdcOutboxRows} CDC outbox row(s) exist; Jobs/Notifications cutover and CDC replay/deduplication receipts are not coordinated`,
    );
  }
}

export const ALERTS_MOVE_TABLE_INVENTORY = ALERTS_TABLES;
