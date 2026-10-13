import type { Pool } from "pg";
import { type CopyEvidence, type MoveReceipt } from "./pg-owner.js";
import {
  assertReviewedOwnerMoveEffectsDrained,
  createReviewedOwnerMoveAdapter,
} from "./reviewed-owner-move.js";

const RISK_TABLES = [
  "bin_lot_intervals",
  "consumer_inbox",
  "device_bindings",
  "device_risk_streams",
  "grain_policies",
  "outbox_events",
  "risk_assessment_invalidations",
  "risk_assessments",
] as const;
export interface RiskMoveReceipt extends MoveReceipt {
  owner: "risk";
}
export interface RiskCopyResult {
  evidence: CopyEvidence;
  receipt: RiskMoveReceipt;
}

/** Refuse schema drift or partitioned relations before using the generic copier.
 * The current Risk schema uses this reviewed, nonpartitioned table inventory. */
export async function assertRiskMoveSchema(pool: Pool): Promise<void> {
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
    actual.length !== RISK_TABLES.length ||
    actual.some((name, index) => name !== RISK_TABLES[index]) ||
    result.rows.some((row) => row.relkind !== "r" || row.is_partition)
  )
    throw new Error(
      `risk move schema differs from its reviewed table inventory; expected ${RISK_TABLES.join(",")}, got ${actual.join(",")}`,
    );
}

/** Outbox history cannot be replayed safely by a row copy while CDC is active.
 * This preflight improves diagnostics; the owner SQL repeats the guard while
 * holding the ownership row lock, so a concurrent writer cannot race the check.
 */
export async function assertRiskMoveEffectsDrained(
  pool: Pool,
  tenantId: string,
): Promise<void> {
  return assertReviewedOwnerMoveEffectsDrained("risk", pool, tenantId);
}

// Keep owner-specific schema and effect guards bound to this adapter.
const adapter = createReviewedOwnerMoveAdapter("risk", {
  assertSchema: assertRiskMoveSchema,
  beforeFence: assertRiskMoveEffectsDrained,
});
export const {
  prepareTarget: prepareRiskMoveTarget,
  fenceSource: fenceRiskMoveSource,
  copySnapshot: copyRiskTenantSnapshot,
  activateTarget: activateRiskMoveTarget,
  abortTarget: abortRiskMoveTarget,
  reactivateSource: reactivateRiskMoveSource,
} = adapter;
