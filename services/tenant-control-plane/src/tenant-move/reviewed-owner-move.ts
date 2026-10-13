import type { Pool } from "pg";
import {
  copyTenantSnapshot,
  recordRiskMoveCopy,
  type CopyEvidence,
  type MoveReceipt,
  type OwnerIdentity,
} from "./pg-owner.js";

// Only these reviewed owners share the same move protocol. Procedure SQL below
// is static; the owner identity never supplies a table or procedure name.
type ReviewedOwner = "inventory" | "telemetry" | "risk";
interface ReviewedMoveReceipt<Owner extends ReviewedOwner> extends MoveReceipt {
  owner: Owner;
}
interface ReviewedCopyResult<Owner extends ReviewedOwner> {
  evidence: CopyEvidence;
  receipt: ReviewedMoveReceipt<Owner>;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARD = /^s[1-4]$/;

/** Outbox history cannot be replayed safely by a row copy while CDC is active.
 * The owner SQL repeats this preflight under the ownership row lock to close races. */
export async function assertReviewedOwnerMoveEffectsDrained(
  owner: "risk" | "telemetry",
  pool: Pool,
  tenantId: string,
): Promise<void> {
  if (!UUID.test(tenantId)) throw new Error(`invalid ${owner} move tenant id`);
  const result = await pool.query<{ has_cdc_history: boolean }>(
    `SELECT greenguard_internal.tenant_move_has_cdc_history($1::uuid) AS has_cdc_history`,
    [tenantId],
  );
  const effects = result.rows[0];
  if (!effects)
    throw new Error(`${owner} move effect preflight returned no result`);
  if (effects.has_cdc_history)
    throw new Error(
      `${owner} move blocked: CDC outbox history needs a deduplication-aware migration protocol`,
    );
}

/** Bind shared orchestration to one reviewed owner. Schema inventories and
 * preflight guards stay in their owner modules. Copy proof still runs inside
 * copyTenantSnapshot's target transaction before either COMMIT. */
export function createReviewedOwnerMoveAdapter<Owner extends ReviewedOwner>(
  owner: Owner,
  guards: {
    assertSchema: (pool: Pool) => Promise<void>;
    beforeFence: (pool: Pool, tenantId: string) => Promise<void>;
  },
) {
  function validateMove(
    tenantId: string,
    operationId: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
  ): void {
    if (!UUID.test(tenantId) || !UUID.test(operationId))
      throw new Error(`invalid ${owner} move tenant or operation id`);
    if (
      !SHARD.test(source.shardId) ||
      !SHARD.test(target.shardId) ||
      source.shardId === target.shardId ||
      !UUID.test(source.incarnation) ||
      !UUID.test(target.incarnation) ||
      !/^[1-9]\d*$/.test(source.epoch) ||
      BigInt(target.epoch) !== BigInt(source.epoch) + 1n
    )
      throw new Error(`invalid ${owner} move placement identities`);
  }

  function assertReceipt(
    receipt: unknown,
    tenantId: string,
    operationId: string,
    phase: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
  ): ReviewedMoveReceipt<Owner> {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      throw new Error(`${owner} ${phase} procedure returned no receipt`);
    const candidate = receipt as MoveReceipt;
    if (
      candidate.owner !== owner ||
      candidate.tenantId !== tenantId ||
      candidate.operationId !== operationId ||
      candidate.phase !== phase ||
      candidate.sourceShardId !== source.shardId ||
      candidate.sourceIncarnation !== source.incarnation ||
      candidate.sourceEpoch !== source.epoch ||
      candidate.targetShardId !== target.shardId ||
      candidate.targetIncarnation !== target.incarnation ||
      candidate.targetEpoch !== target.epoch
    )
      throw new Error(`${owner} ${phase} receipt identity is invalid`);
    return candidate as ReviewedMoveReceipt<Owner>;
  }

  async function callReceipt(
    pool: Pool,
    sql: string,
    values: unknown[],
  ): Promise<MoveReceipt> {
    const result = await pool.query<{ receipt: MoveReceipt }>(sql, values);
    const receipt = result.rows[0]?.receipt;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      throw new Error(`${owner} owner procedure returned no receipt`);
    return receipt;
  }

  async function prepareTarget(
    pool: Pool,
    tenantId: string,
    operationId: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
  ): Promise<ReviewedMoveReceipt<Owner>> {
    validateMove(tenantId, operationId, source, target);
    const receipt = await callReceipt(
      pool,
      `SELECT greenguard_internal.prepare_tenant_move_target($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,$7::uuid,$8::bigint) AS receipt`,
      [
        tenantId,
        operationId,
        source.shardId,
        source.incarnation,
        source.epoch,
        target.shardId,
        target.incarnation,
        target.epoch,
      ],
    );
    const proof = assertReceipt(
      receipt,
      tenantId,
      operationId,
      "target_prepared",
      source,
      target,
    );
    if (
      proof.state !== "prepared" ||
      proof.shardId !== target.shardId ||
      proof.epoch !== target.epoch
    )
      throw new Error(`${owner} target preparation receipt is invalid`);
    return proof;
  }

  async function fenceSource(
    pool: Pool,
    tenantId: string,
    operationId: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
  ): Promise<ReviewedMoveReceipt<Owner>> {
    validateMove(tenantId, operationId, source, target);
    await guards.beforeFence(pool, tenantId);
    const receipt = await callReceipt(
      pool,
      `SELECT greenguard_internal.fence_tenant_move_source($1::uuid,$2::uuid,$3,$4::uuid,$5::bigint,$6,$7::uuid,$8::bigint) AS receipt`,
      [
        tenantId,
        operationId,
        source.shardId,
        source.incarnation,
        source.epoch,
        target.shardId,
        target.incarnation,
        target.epoch,
      ],
    );
    const proof = assertReceipt(
      receipt,
      tenantId,
      operationId,
      "source_fenced",
      source,
      target,
    );
    if (
      proof.state !== "fenced" ||
      proof.shardId !== source.shardId ||
      proof.epoch !== source.epoch
    )
      throw new Error(`${owner} source fence receipt is invalid`);
    return proof;
  }

  /** Copy only after the source row-lock fence and target preparation have both
   * committed. The reviewed fixed table inventory avoids partition-parent duplication. CDC outbox history is deliberately rejected until a dedup-aware transfer protocol exists. */
  async function copySnapshot(
    sourcePool: Pool,
    targetPool: Pool,
    tenantId: string,
    operationId: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
  ): Promise<ReviewedCopyResult<Owner>> {
    validateMove(tenantId, operationId, source, target);
    await Promise.all([
      guards.assertSchema(sourcePool),
      guards.assertSchema(targetPool),
    ]);
    const [sourceStatus, targetStatus] = await Promise.all([
      sourcePool.query<{
        status: { state: string; receipt: MoveReceipt } | null;
      }>(
        `SELECT greenguard_internal.tenant_move_status($1::uuid,$2::uuid,'source') AS status`,
        [tenantId, operationId],
      ),
      targetPool.query<{
        status: { state: string; receipt: MoveReceipt } | null;
      }>(
        `SELECT greenguard_internal.tenant_move_status($1::uuid,$2::uuid,'target') AS status`,
        [tenantId, operationId],
      ),
    ]);
    const sourceState = sourceStatus.rows[0]?.status;
    const targetState = targetStatus.rows[0]?.status;
    assertReceipt(
      sourceState?.receipt,
      tenantId,
      operationId,
      "source_fenced",
      source,
      target,
    );
    if (sourceState?.state !== "source_fenced")
      throw new Error(`${owner} source is not durably fenced`);
    if (targetState?.state === "copy_verified") {
      const receipt = assertReceipt(
        targetState.receipt,
        tenantId,
        operationId,
        "copy_verified",
        source,
        target,
      );
      if (
        typeof receipt.sourceSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(receipt.sourceSha256) ||
        receipt.sourceSha256 !== receipt.targetSha256 ||
        typeof receipt.rowCount !== "string" ||
        !/^\d+$/.test(receipt.rowCount) ||
        typeof receipt.tableCount !== "number" ||
        !Number.isInteger(receipt.tableCount) ||
        typeof receipt.verifiedAt !== "string"
      )
        throw new Error(`durable ${owner} copy receipt is invalid`);
      return {
        receipt,
        evidence: {
          tenantId,
          operationId,
          source,
          target,
          tableCount: receipt.tableCount,
          rowCount: receipt.rowCount,
          sourceSha256: receipt.sourceSha256,
          targetSha256: receipt.targetSha256 as string,
          verifiedAt: receipt.verifiedAt,
        },
      };
    }
    if (targetState?.state !== "prepared")
      throw new Error(`${owner} target is not prepared for copy`);
    assertReceipt(
      targetState.receipt,
      tenantId,
      operationId,
      "target_prepared",
      source,
      target,
    );
    let copyReceipt: ReviewedMoveReceipt<Owner> | undefined;
    const evidence = await copyTenantSnapshot(
      sourcePool,
      targetPool,
      tenantId,
      operationId,
      source,
      target,
      async (targetClient, proof) => {
        const receipt =
          owner === "risk"
            ? await recordRiskMoveCopy(targetClient, proof)
            : (
                await targetClient.query<{ receipt: MoveReceipt }>(
                  `SELECT greenguard_internal.record_tenant_move_copy($1::uuid,$2::uuid,$3,$4,$5::bigint,$6::integer) AS receipt`,
                  [
                    tenantId,
                    operationId,
                    proof.sourceSha256,
                    proof.targetSha256,
                    proof.rowCount,
                    proof.tableCount,
                  ],
                )
              ).rows[0]?.receipt;
        copyReceipt = assertReceipt(
          receipt,
          tenantId,
          operationId,
          "copy_verified",
          source,
          target,
        );
        if (
          copyReceipt.sourceSha256 !== proof.sourceSha256 ||
          copyReceipt.targetSha256 !== proof.targetSha256 ||
          copyReceipt.rowCount !== proof.rowCount ||
          copyReceipt.tableCount !== proof.tableCount
        )
          throw new Error(
            `${owner} copy receipt differs from verified snapshot`,
          );
      },
    );
    if (!copyReceipt)
      throw new Error(`${owner} copy receipt was not persisted atomically`);
    return { evidence, receipt: copyReceipt };
  }

  async function activateTarget(
    pool: Pool,
    tenantId: string,
    operationId: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
    route: {
      tenantId: string;
      shardId: string;
      placementEpoch: string;
      state: string;
    },
  ): Promise<ReviewedMoveReceipt<Owner>> {
    validateMove(tenantId, operationId, source, target);
    if (
      route.tenantId !== tenantId ||
      route.shardId !== target.shardId ||
      route.placementEpoch !== target.epoch ||
      route.state !== "activating"
    )
      throw new Error(
        `control-plane placement is not switched to ${owner} target`,
      );
    const receipt = await callReceipt(
      pool,
      `SELECT greenguard_internal.activate_tenant_move_target($1::uuid,$2::uuid) AS receipt`,
      [tenantId, operationId],
    );
    const proof = assertReceipt(
      receipt,
      tenantId,
      operationId,
      "target_activated",
      source,
      target,
    );
    if (
      proof.state !== "active" ||
      proof.shardId !== target.shardId ||
      proof.epoch !== target.epoch ||
      typeof proof.sourceSha256 !== "string" ||
      proof.sourceSha256 !== proof.targetSha256 ||
      !/^[0-9a-f]{64}$/.test(proof.sourceSha256)
    )
      throw new Error(`${owner} target activation receipt is invalid`);
    return proof;
  }

  async function abortTarget(
    pool: Pool,
    tenantId: string,
    operationId: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
  ): Promise<ReviewedMoveReceipt<Owner>> {
    validateMove(tenantId, operationId, source, target);
    const receipt = await callReceipt(
      pool,
      `SELECT greenguard_internal.abort_tenant_move_target($1::uuid,$2::uuid) AS receipt`,
      [tenantId, operationId],
    );
    const proof = assertReceipt(
      receipt,
      tenantId,
      operationId,
      "targets_unactivated",
      source,
      target,
    );
    if (proof.state !== "absent" || proof.shardId !== target.shardId)
      throw new Error(`${owner} target abort receipt is invalid`);
    return proof;
  }

  async function reactivateSource(
    pool: Pool,
    tenantId: string,
    operationId: string,
    source: OwnerIdentity,
    target: OwnerIdentity,
    targetAbortReceipt: ReviewedMoveReceipt<Owner>,
  ): Promise<ReviewedMoveReceipt<Owner>> {
    validateMove(tenantId, operationId, source, target);
    assertReceipt(
      targetAbortReceipt,
      tenantId,
      operationId,
      "targets_unactivated",
      source,
      target,
    );
    if (targetAbortReceipt.state !== "absent")
      throw new Error(
        `${owner} target must be proven unactivated before source reactivation`,
      );
    const receipt = await callReceipt(
      pool,
      owner === "risk"
        ? `SELECT greenguard_internal.reactivate_tenant_move_source($1::uuid,$2::uuid,$3::jsonb) AS receipt`
        : `SELECT greenguard_internal.reactivate_tenant_move_source($1::uuid,$2::uuid) AS receipt`,
      owner === "risk"
        ? [tenantId, operationId, JSON.stringify(targetAbortReceipt)]
        : [tenantId, operationId],
    );
    const proof = assertReceipt(
      receipt,
      tenantId,
      operationId,
      "source_reactivated",
      source,
      target,
    );
    if (
      proof.state !== "active" ||
      proof.shardId !== source.shardId ||
      proof.epoch !== target.epoch
    )
      throw new Error(`${owner} source reactivation receipt is invalid`);
    return proof;
  }

  return {
    prepareTarget,
    fenceSource,
    copySnapshot,
    activateTarget,
    abortTarget,
    reactivateSource,
  };
}
