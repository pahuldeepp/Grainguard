import type { Db, Tx } from "../db/client.js";
import { inScope } from "../db/session.js";
import { nameId } from "../domain/ids.js";
import type { Command } from "../domain/store.js";
import {
  requireCompleteBootstrapProofs,
  type TenantBootstrapOwnerProof,
  type TenantBootstrapPlacement,
} from "./preflight.js";

const MAX_ATTEMPTS = 8;

export interface TenantBootstrapJob extends TenantBootstrapPlacement {
  tenantId: string;
  jobId: string;
  operationId: string;
  requestedAdminIdentityId: string;
  correlationId: string;
  traceparent: string;
}

export interface ClaimedTenantBootstrapJob extends TenantBootstrapJob {
  claimToken: string;
  leaseUntil: Date | string;
  attempts: number;
  preparedReceipts: unknown;
  activeReceipts: unknown;
}

export type TenantBootstrapFailureCode =
  | "owner_unavailable"
  | "owner_contract_unavailable"
  | "lease_lost"
  | "retryable_failure";

export class TenantBootstrapQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantBootstrapQueueError";
  }
}

export class TenantBootstrapClaimLostError extends Error {
  constructor() {
    super("tenant bootstrap claim lost");
    this.name = "TenantBootstrapClaimLostError";
  }
}

/**
 * Atomically persist durable onboarding intent with the provisioning tenant.
 * The admin identity is the authenticated creator supplied by the control-plane
 * transaction, never an unverified request payload.
 */
export async function enqueueTenantBootstrap(
  tx: Tx,
  tenantId: string,
  requestedAdminIdentityId: string,
  cmd: Command,
): Promise<TenantBootstrapJob> {
  const jobId = nameId("tenant-bootstrap-job", tenantId);
  const operationId = nameId("tenant-bootstrap-operation", tenantId);
  const inserted = await tx.$queryRaw<TenantBootstrapJob[]>`
    INSERT INTO tenant_bootstrap_jobs (
      tenant_id, job_id, operation_id, requested_admin_identity_id,
      correlation_id, traceparent, shard_id, shard_incarnation,
      placement_epoch, state
    )
    SELECT o.tenant_id, ${jobId}::uuid, ${operationId}::uuid,
      ${requestedAdminIdentityId}::uuid, ${cmd.correlationId}::uuid,
      ${cmd.traceparent}, o.shard_id, s.shard_incarnation, o.routing_epoch, 'queued'
      FROM organizations o JOIN shard_registry s ON s.shard_id=o.shard_id
     WHERE o.tenant_id=${tenantId}::uuid AND o.created_by=${requestedAdminIdentityId}::uuid
       AND o.state='provisioning' AND s.state='active'
    ON CONFLICT (tenant_id) DO NOTHING
    RETURNING tenant_id::text AS "tenantId", job_id::text AS "jobId",
      operation_id::text AS "operationId",
      requested_admin_identity_id::text AS "requestedAdminIdentityId",
      correlation_id::text AS "correlationId", traceparent, shard_id AS "shardId",
      shard_incarnation::text AS "shardIncarnation",
      placement_epoch::text AS "placementEpoch"`;
  if (inserted[0]) return inserted[0];

  const [existing] = await tx.$queryRaw<TenantBootstrapJob[]>`
    SELECT tenant_id::text AS "tenantId", job_id::text AS "jobId",
      operation_id::text AS "operationId",
      requested_admin_identity_id::text AS "requestedAdminIdentityId",
      correlation_id::text AS "correlationId", traceparent, shard_id AS "shardId",
      shard_incarnation::text AS "shardIncarnation",
      placement_epoch::text AS "placementEpoch"
      FROM tenant_bootstrap_jobs WHERE tenant_id=${tenantId}::uuid`;
  if (
    !existing ||
    existing.requestedAdminIdentityId !== requestedAdminIdentityId ||
    existing.jobId !== jobId ||
    existing.operationId !== operationId
  )
    throw new TenantBootstrapQueueError(
      "provisioning organization has no matching durable bootstrap job",
    );
  return existing;
}

/** Claim one due job. PostgreSQL performs the SKIP LOCKED claim atomically. */
export async function claimTenantBootstrapJob(
  db: Db,
): Promise<ClaimedTenantBootstrapJob | null> {
  const [row] = await db.$queryRaw<ClaimedTenantBootstrapJob[]>`
    SELECT tenant_id::text AS "tenantId", job_id::text AS "jobId",
      operation_id::text AS "operationId",
      requested_admin_identity_id::text AS "requestedAdminIdentityId",
      correlation_id::text AS "correlationId", traceparent,
      shard_id AS "shardId", shard_incarnation::text AS "shardIncarnation",
      placement_epoch::text AS "placementEpoch", attempts,
      claim_token::text AS "claimToken", lease_until AS "leaseUntil",
      prepared_receipts AS "preparedReceipts", active_receipts AS "activeReceipts"
      FROM claim_tenant_bootstrap_job()`;
  return row ?? null;
}

export async function renewTenantBootstrapClaim(
  db: Db,
  job: ClaimedTenantBootstrapJob,
): Promise<void> {
  const [row] = await db.$queryRaw<{ renewed: boolean }[]>`
    SELECT renew_tenant_bootstrap_job(
      ${job.tenantId}::uuid, ${job.jobId}::uuid, ${job.claimToken}::uuid
    ) AS renewed`;
  if (!row?.renewed) throw new TenantBootstrapClaimLostError();
}

export async function retryTenantBootstrap(
  db: Db,
  job: ClaimedTenantBootstrapJob,
  code: TenantBootstrapFailureCode,
): Promise<"retry_wait" | "blocked"> {
  const [row] = await db.$queryRaw<{ state: "retry_wait" | "blocked" }[]>`
    SELECT retry_tenant_bootstrap_job(
      ${job.tenantId}::uuid, ${job.jobId}::uuid, ${job.claimToken}::uuid, ${code}
    ) AS state`;
  if (!row || !["retry_wait", "blocked"].includes(row.state))
    throw new TenantBootstrapClaimLostError();
  return row.state;
}

export async function persistTenantBootstrapProofs(
  db: Db,
  job: ClaimedTenantBootstrapJob,
  phase: "prepared" | "active",
  proofs: readonly TenantBootstrapOwnerProof[],
): Promise<void> {
  requireCompleteBootstrapProofs(placementOf(job), phase, proofs);
  await inScope(db, { tenantId: job.tenantId }, async (tx) => {
    const serialized = JSON.stringify(proofs);
    const changed =
      phase === "prepared"
        ? await tx.$executeRaw`
          UPDATE tenant_bootstrap_jobs SET prepared_receipts=${serialized}::jsonb,
            updated_at=clock_timestamp()
           WHERE tenant_id=${job.tenantId}::uuid AND job_id=${job.jobId}::uuid
             AND state='running' AND claim_token=${job.claimToken}::uuid
             AND lease_until>clock_timestamp()`
        : await tx.$executeRaw`
          UPDATE tenant_bootstrap_jobs SET active_receipts=${serialized}::jsonb,
            updated_at=clock_timestamp()
           WHERE tenant_id=${job.tenantId}::uuid AND job_id=${job.jobId}::uuid
             AND state='running' AND claim_token=${job.claimToken}::uuid
             AND lease_until>clock_timestamp()`;
    if (changed !== 1) throw new TenantBootstrapClaimLostError();
  });
}

export function placementOf(job: TenantBootstrapJob): TenantBootstrapPlacement {
  return {
    tenantId: job.tenantId,
    shardId: job.shardId,
    shardIncarnation: job.shardIncarnation,
    placementEpoch: job.placementEpoch,
  };
}

export function maximumTenantBootstrapAttempts() {
  return MAX_ATTEMPTS;
}
