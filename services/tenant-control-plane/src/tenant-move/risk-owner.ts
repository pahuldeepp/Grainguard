import type { Pool } from "pg";
import {
  copyTenantSnapshot,
  recordRiskMoveCopy,
  type CopyEvidence,
  type MoveReceipt,
  type OwnerIdentity,
} from "./pg-owner.js";

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
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARD = /^s[1-4]$/;

export interface RiskMoveReceipt extends MoveReceipt {
  owner: "risk";
}
export interface RiskCopyResult {
  evidence: CopyEvidence;
  receipt: RiskMoveReceipt;
}

function validateMove(
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): void {
  if (!UUID.test(tenantId) || !UUID.test(operationId))
    throw new Error("invalid risk move tenant or operation id");
  if (
    !SHARD.test(source.shardId) ||
    !SHARD.test(target.shardId) ||
    source.shardId === target.shardId ||
    !UUID.test(source.incarnation) ||
    !UUID.test(target.incarnation) ||
    !/^[1-9][0-9]*$/.test(source.epoch) ||
    BigInt(target.epoch) !== BigInt(source.epoch) + 1n
  )
    throw new Error("invalid risk move placement identities");
}

function assertReceipt(
  receipt: unknown,
  tenantId: string,
  operationId: string,
  phase: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): RiskMoveReceipt {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw new Error(`risk ${phase} procedure returned no receipt`);
  const candidate = receipt as MoveReceipt;
  if (
    candidate.owner !== "risk" ||
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
    throw new Error(`risk ${phase} receipt identity is invalid`);
  return candidate as RiskMoveReceipt;
}

async function callReceipt(
  pool: Pool,
  sql: string,
  values: unknown[],
): Promise<MoveReceipt> {
  const result = await pool.query<{ receipt: MoveReceipt }>(sql, values);
  const receipt = result.rows[0]?.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw new Error("risk owner procedure returned no receipt");
  return receipt;
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

export async function prepareRiskMoveTarget(
  pool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): Promise<RiskMoveReceipt> {
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
    throw new Error("risk target preparation receipt is invalid");
  return proof;
}

/** Outbox history cannot be replayed safely by a row copy while CDC is active.
 * This preflight improves diagnostics; the owner SQL repeats the guard while
 * holding the ownership row lock, so a concurrent writer cannot race the check.
 */
export async function assertRiskMoveEffectsDrained(
  pool: Pool,
  tenantId: string,
): Promise<void> {
  if (!UUID.test(tenantId)) throw new Error("invalid risk move tenant id");
  const result = await pool.query<{ has_cdc_history: boolean }>(
    `SELECT greenguard_internal.tenant_move_has_cdc_history($1::uuid) AS has_cdc_history`,
    [tenantId],
  );
  const effects = result.rows[0];
  if (!effects)
    throw new Error("risk move effect preflight returned no result");
  if (effects.has_cdc_history)
    throw new Error(
      "risk move blocked: CDC outbox history needs a deduplication-aware migration protocol",
    );
}

export async function fenceRiskMoveSource(
  pool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): Promise<RiskMoveReceipt> {
  validateMove(tenantId, operationId, source, target);
  await assertRiskMoveEffectsDrained(pool, tenantId);
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
    throw new Error("risk source fence receipt is invalid");
  return proof;
}

/** Copy only after the source row-lock fence and target preparation have both
 * committed. The exact, nonpartitioned Risk table inventory is checked before copy. */
export async function copyRiskTenantSnapshot(
  sourcePool: Pool,
  targetPool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): Promise<RiskCopyResult> {
  validateMove(tenantId, operationId, source, target);
  await Promise.all([
    assertRiskMoveSchema(sourcePool),
    assertRiskMoveSchema(targetPool),
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
    throw new Error("risk source is not durably fenced");
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
      throw new Error("durable risk copy receipt is invalid");
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
    throw new Error("risk target is not prepared for copy");
  assertReceipt(
    targetState.receipt,
    tenantId,
    operationId,
    "target_prepared",
    source,
    target,
  );
  let copyReceipt: RiskMoveReceipt | undefined;
  const evidence = await copyTenantSnapshot(
    sourcePool,
    targetPool,
    tenantId,
    operationId,
    source,
    target,
    async (targetClient, proof) => {
      copyReceipt = assertReceipt(
        await recordRiskMoveCopy(targetClient, proof),
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
        throw new Error("risk copy receipt differs from verified snapshot");
    },
  );
  if (!copyReceipt)
    throw new Error("risk copy receipt was not persisted atomically");
  return { evidence, receipt: copyReceipt };
}

export async function activateRiskMoveTarget(
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
): Promise<RiskMoveReceipt> {
  validateMove(tenantId, operationId, source, target);
  if (
    route.tenantId !== tenantId ||
    route.shardId !== target.shardId ||
    route.placementEpoch !== target.epoch ||
    route.state !== "activating"
  )
    throw new Error("control-plane placement is not switched to risk target");
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
    throw new Error("risk target activation receipt is invalid");
  return proof;
}

export async function abortRiskMoveTarget(
  pool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): Promise<RiskMoveReceipt> {
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
    throw new Error("risk target abort receipt is invalid");
  return proof;
}

export async function reactivateRiskMoveSource(
  pool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
  targetAbortReceipt: RiskMoveReceipt,
): Promise<RiskMoveReceipt> {
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
      "risk target must be proven unactivated before source reactivation",
    );
  const receipt = await callReceipt(
    pool,
    `SELECT greenguard_internal.reactivate_tenant_move_source($1::uuid,$2::uuid,$3::jsonb) AS receipt`,
    [tenantId, operationId, JSON.stringify(targetAbortReceipt)],
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
    throw new Error("risk source reactivation receipt is invalid");
  return proof;
}
