import type { Db } from "../db/client.js";
import { inScope } from "../db/session.js";
import {
  activateProvisioningOrganization,
  type Command,
} from "../domain/store.js";
import {
  TenantBootstrapClaimLostError,
  type ClaimedTenantBootstrapJob,
  placementOf,
} from "./jobs.js";
import {
  requireCompleteBootstrapProofs,
  type TenantBootstrapOwnerProof,
} from "./preflight.js";

function decodeProofs(value: unknown): TenantBootstrapOwnerProof[] {
  if (!Array.isArray(value))
    throw new Error("tenant bootstrap owner proof ledger is invalid");
  return value as TenantBootstrapOwnerProof[];
}

/**
 * Final control-plane commit. The proof arrays come from the job's durable
 * receipt ledger populated only after repository-owned adapters call the
 * owner-side authenticated readback routines. The production adapter registry
 * remains empty until those adapters and their ledger-readiness checks exist.
 */
export async function finalizeTenantBootstrap(
  db: Db,
  job: ClaimedTenantBootstrapJob,
): Promise<void> {
  await inScope(db, { tenantId: job.tenantId }, async (tx) => {
    const [stored] = await tx.$queryRaw<
      {
        job_id: string;
        requested_admin_identity_id: string;
        shard_id: string;
        shard_incarnation: string;
        placement_epoch: bigint;
        correlation_id: string;
        traceparent: string;
        prepared_receipts: unknown;
        active_receipts: unknown;
      }[]
    >`
      SELECT job_id::text,requested_admin_identity_id::text,shard_id,
        shard_incarnation::text,placement_epoch,correlation_id::text,traceparent,
        prepared_receipts,active_receipts
        FROM tenant_bootstrap_jobs
       WHERE tenant_id=${job.tenantId}::uuid AND job_id=${job.jobId}::uuid
         AND state='running' AND claim_token=${job.claimToken}::uuid
         AND lease_until>clock_timestamp()
       FOR UPDATE`;
    if (!stored) throw new TenantBootstrapClaimLostError();

    const placement = placementOf({
      ...job,
      tenantId: job.tenantId,
      shardId: stored.shard_id,
      shardIncarnation: stored.shard_incarnation,
      placementEpoch: stored.placement_epoch.toString(),
    });
    const prepared = decodeProofs(stored.prepared_receipts);
    const active = decodeProofs(stored.active_receipts);
    requireCompleteBootstrapProofs(placement, "prepared", prepared);
    requireCompleteBootstrapProofs(placement, "active", active);

    const command: Command = {
      idempotencyKey: `tenant-bootstrap:${stored.job_id}`,
      correlationId: stored.correlation_id,
      traceparent: stored.traceparent,
    };
    await activateProvisioningOrganization(tx, {
      tenantId: job.tenantId,
      requestedAdminIdentityId: stored.requested_admin_identity_id,
      shardId: stored.shard_id,
      shardIncarnation: stored.shard_incarnation,
      placementEpoch: stored.placement_epoch.toString(),
      command,
    });

    const changed = await tx.$executeRaw`
      UPDATE tenant_bootstrap_jobs
         SET state='completed',claim_token=NULL,lease_until=NULL,
             completed_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE tenant_id=${job.tenantId}::uuid AND job_id=${job.jobId}::uuid
         AND state='running' AND claim_token=${job.claimToken}::uuid
         AND lease_until>clock_timestamp()`;
    if (changed !== 1) throw new TenantBootstrapClaimLostError();
  });
}
