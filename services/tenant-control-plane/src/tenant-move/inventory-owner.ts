import type { Pool } from "pg";
import { type CopyEvidence, type MoveReceipt } from "./pg-owner.js";
import { createReviewedOwnerMoveAdapter } from "./reviewed-owner-move.js";

const INVENTORY_TABLES = [
  "audit_events",
  "bin_cables",
  "bin_occupancies",
  "bins",
  "cable_sensors",
  "command_receipts",
  "devices",
  "grain_lots",
  "inventory_import_state",
  "inventory_saga_receipts",
  "inventory_saga_result_outbox",
  "outbox_events",
  "sites",
  "tenant_entitlements",
  "tenants",
] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InventoryMoveReceipt extends MoveReceipt {
  owner: "inventory";
}
export interface InventoryCopyResult {
  evidence: CopyEvidence;
  receipt: InventoryMoveReceipt;
}

/** Refuse schema drift or partitioned relations before using the generic copier.
 * The current inventory schema has a finite owner inventory and no partitioned
 * tenant tables; silently discovering a new table could omit dependencies/data. */
export async function assertInventoryMoveSchema(pool: Pool): Promise<void> {
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
    actual.length !== INVENTORY_TABLES.length ||
    actual.some((name, index) => name !== INVENTORY_TABLES[index]) ||
    result.rows.some((row) => row.relkind !== "r" || row.is_partition)
  )
    throw new Error(
      `inventory move schema differs from its reviewed table inventory; expected ${INVENTORY_TABLES.join(",")}, got ${actual.join(",")}`,
    );
}

/** Outbox history cannot be replayed safely by a row copy while CDC is active.
 * This preflight improves diagnostics; the owner SQL repeats the guard while
 * holding the ownership row lock, so a concurrent writer cannot race the check.
 */
export async function assertInventoryMoveEffectsDrained(
  pool: Pool,
  tenantId: string,
): Promise<void> {
  if (!UUID.test(tenantId)) throw new Error("invalid inventory move tenant id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Both owner tables use FORCE RLS. Scope this read in a transaction so the
    // tenant setting is local to this checked-out connection and cannot leak to
    // the next pool borrower.
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [
      tenantId,
    ]);
    const result = await client.query<{
      has_cdc_history: boolean;
      has_pending_saga_effects: boolean;
    }>(
      `SELECT EXISTS(SELECT 1 FROM public.outbox_events WHERE tenant_id=$1::uuid) AS has_cdc_history,
        EXISTS(SELECT 1 FROM public.inventory_saga_result_outbox WHERE tenant_id=$1::uuid AND published_at IS NULL) AS has_pending_saga_effects`,
      [tenantId],
    );
    const effects = result.rows[0];
    if (!effects)
      throw new Error("inventory move effect preflight returned no result");
    if (effects.has_cdc_history)
      throw new Error(
        "inventory move blocked: CDC outbox history needs a deduplication-aware migration protocol",
      );
    if (effects.has_pending_saga_effects)
      throw new Error(
        "inventory move blocked: pending saga result effects must be drained",
      );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original preflight error. Pool release handles a broken
      // connection according to pg's normal behavior.
    }
    throw error;
  } finally {
    client.release();
  }
}

// Keep owner-specific schema and effect guards bound to this adapter.
const adapter = createReviewedOwnerMoveAdapter("inventory", {
  assertSchema: assertInventoryMoveSchema,
  beforeFence: assertInventoryMoveEffectsDrained,
});
export const {
  prepareTarget: prepareInventoryMoveTarget,
  fenceSource: fenceInventoryMoveSource,
  copySnapshot: copyInventoryTenantSnapshot,
  activateTarget: activateInventoryMoveTarget,
  abortTarget: abortInventoryMoveTarget,
  reactivateSource: reactivateInventoryMoveSource,
} = adapter;
