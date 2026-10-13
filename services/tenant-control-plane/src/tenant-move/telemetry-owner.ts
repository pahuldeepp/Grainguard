import type { Pool } from "pg";
import { type CopyEvidence, type MoveReceipt } from "./pg-owner.js";
import {
  assertReviewedOwnerMoveEffectsDrained,
  createReviewedOwnerMoveAdapter,
} from "./reviewed-owner-move.js";

const TELEMETRY_TABLES = [
  "audit_events",
  "cable_layout_bindings",
  "consumer_inbox",
  "device_bindings",
  "device_streams",
  "ingest_quota_usage",
  "ingest_receipts",
  "ingest_rejection_samples",
  "outbox_events",
  "readings",
  "saga_binding_requests",
  "tenant_entitlements",
] as const;
export interface TelemetryMoveReceipt extends MoveReceipt {
  owner: "telemetry";
}
export interface TelemetryCopyResult {
  evidence: CopyEvidence;
  receipt: TelemetryMoveReceipt;
}

/** Refuse schema drift or partitioned relations before using the generic copier.
 * The current telemetry schema has a finite owner inventory and no partitioned
 * tenant tables; silently discovering a new table could omit dependencies/data. */
export async function assertTelemetryMoveSchema(pool: Pool): Promise<void> {
  const result = await pool.query<{
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
  const actual = result.rows.map((row) => row.table_name);
  if (
    actual.length !== TELEMETRY_TABLES.length ||
    actual.some((name, index) => name !== TELEMETRY_TABLES[index]) ||
    result.rows.some((row) => row.relkind !== "r" || row.is_partition)
  )
    throw new Error(
      `telemetry move schema differs from its reviewed table inventory; expected ${TELEMETRY_TABLES.join(",")}, got ${actual.join(",")}`,
    );
}

/** CDC history is not safe to duplicate with the current row-copy protocol.
 * The SQL fence repeats this check while holding the owner row lock to close races. */
export async function assertTelemetryMoveEffectsDrained(
  pool: Pool,
  tenantId: string,
): Promise<void> {
  return assertReviewedOwnerMoveEffectsDrained("telemetry", pool, tenantId);
}

// Keep owner-specific schema and effect guards bound to this adapter.
const adapter = createReviewedOwnerMoveAdapter("telemetry", {
  assertSchema: assertTelemetryMoveSchema,
  beforeFence: assertTelemetryMoveEffectsDrained,
});
export const {
  prepareTarget: prepareTelemetryMoveTarget,
  fenceSource: fenceTelemetryMoveSource,
  copySnapshot: copyTelemetryTenantSnapshot,
  activateTarget: activateTelemetryMoveTarget,
  abortTarget: abortTelemetryMoveTarget,
  reactivateSource: reactivateTelemetryMoveSource,
} = adapter;
