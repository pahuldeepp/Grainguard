import type { Tx } from "./db.js";
import { context, outbox } from "./events.js";

export interface Finding {
  objectType: "subscription" | "invoice" | "meter";
  objectId: string;
  diffClass: string;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
}

// Persists one finding under its run and emits billing.reconciliation_required in the same
// transaction. Deterministic IDs make a replay of the same cause a no-op. It never changes
// invoice amounts: a human resolves the finding.
export async function writeFinding(
  tx: Tx,
  tenantId: string,
  runId: string,
  findingId: string,
  finding: Finding,
): Promise<void> {
  const inserted = await tx.$executeRaw`INSERT INTO reconciliation_findings
    (tenant_id,finding_id,run_id,object_type,object_id,diff_class,local_value,remote_value)
    VALUES (${tenantId}::uuid,${findingId}::uuid,${runId}::uuid,
      ${finding.objectType},${finding.objectId},${finding.diffClass},
      ${JSON.stringify(finding.local)}::jsonb,${JSON.stringify(finding.remote)}::jsonb)
    ON CONFLICT DO NOTHING`;
  if (inserted === 0) return;
  await outbox(
    tx,
    tenantId,
    "reconciliation_finding",
    findingId,
    1n,
    {
      type: "billing.reconciliation_required",
      payload: {
        tenant_id: tenantId,
        finding_id: findingId,
        object_type: finding.objectType,
        object_id: finding.objectId,
        diff_class: finding.diffClass,
      },
    },
    context(),
  );
}

// A finding raised outside a scheduled reconciliation run gets its own one-finding run.
export async function raiseFinding(
  tx: Tx,
  tenantId: string,
  runId: string,
  findingId: string,
  finding: Finding,
): Promise<void> {
  await tx.$executeRaw`INSERT INTO reconciliation_runs (tenant_id,run_id,period_start)
    VALUES (${tenantId}::uuid,${runId}::uuid,date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    ON CONFLICT DO NOTHING`;
  await writeFinding(tx, tenantId, runId, findingId, finding);
}
