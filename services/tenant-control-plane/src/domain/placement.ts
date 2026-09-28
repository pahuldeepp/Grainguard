import type { TenantRoute } from "@greenguard/membership-client";
import { placementEpoch } from "@greenguard/membership-client";
import type { Db, Tx } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import { identityIdOf } from "./ids.js";
import type { Actor } from "./store.js";
import {
  DomainConflictError,
  IdempotencyConflictError,
  InvalidInputError,
  NotFoundError,
} from "./errors.js";

export class PlacementUnavailableError extends Error {}
export class PlacementConflictError extends DomainConflictError {}

interface OrganizationRow {
  tenant_id: string;
  shard_id: string;
  routing_epoch: bigint;
  placement_state: TenantRoute["state"];
}
export interface PlacementMove {
  tenantId: string;
  operationId: string;
  sourceShardId: string;
  targetShardId: string;
  expectedEpoch: string;
  resultingEpoch: string | null;
  state: "preparing" | "quiescing" | "switched" | "completed" | "aborted";
  receipts: Record<string, unknown>;
}
interface MoveRow {
  tenant_id: string;
  operation_id: string;
  source_shard_id: string;
  target_shard_id: string;
  expected_epoch: bigint;
  resulting_epoch: bigint | null;
  state: PlacementMove["state"];
  receipts: Record<string, unknown>;
}
const moveDto = (row: MoveRow): PlacementMove => ({
  tenantId: row.tenant_id,
  operationId: row.operation_id,
  sourceShardId: row.source_shard_id,
  targetShardId: row.target_shard_id,
  expectedEpoch: row.expected_epoch.toString(),
  resultingEpoch: row.resulting_epoch?.toString() ?? null,
  state: row.state,
  receipts: row.receipts,
});
function input(expectedEpoch: string, shardId: string, operationId: string) {
  try {
    placementEpoch(expectedEpoch);
  } catch {
    throw new InvalidInputError("invalid placement epoch");
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(shardId) || !UUID.test(operationId))
    throw new InvalidInputError("invalid placement operation");
}

/** Internal service context only: the tenant must come from a verified principal,
 * authenticated device binding or validated event, never an external route hint.
 * 1-second authority lease; clients fail closed after expiry and DB-local owners
 * still enforce their fence for every transaction (Task 3).
 */
export async function resolveTenant(
  db: Db,
  tenantId: string,
  actor?: Actor,
): Promise<TenantRoute> {
  return inScope(db, { tenantId }, async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout','2s',true)`;
    if (actor) {
      const members = await tx.$queryRaw<unknown[]>`SELECT 1 FROM memberships
        WHERE tenant_id=${tenantId}::uuid AND identity_id=${identityIdOf(actor.issuer, actor.subject)}::uuid AND state='active'`;
      if (!members.length) throw new NotFoundError();
    }
    const [row] = await tx.$queryRaw<
      (OrganizationRow & {
        expires_at: Date;
        shard_state: string;
        shard_incarnation: string;
      })[]
    >`
      SELECT o.tenant_id::text, o.shard_id, o.routing_epoch, o.placement_state,
        s.state AS shard_state, s.shard_incarnation::text, clock_timestamp() + interval '1 second' AS expires_at
      FROM organizations o JOIN shard_registry s ON s.shard_id=o.shard_id
      WHERE o.tenant_id=${tenantId}::uuid AND o.state='active'`;
    if (!row) throw new NotFoundError();
    if (row.shard_state === "offline") throw new PlacementUnavailableError();
    return {
      tenantId: row.tenant_id,
      shardId: row.shard_id,
      shardIncarnation: row.shard_incarnation,
      placementEpoch: row.routing_epoch.toString(),
      state: row.placement_state,
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

async function organization(
  tx: Tx,
  tenantId: string,
): Promise<OrganizationRow> {
  const [row] = await tx.$queryRaw<
    OrganizationRow[]
  >`SELECT tenant_id::text, shard_id, routing_epoch, placement_state
    FROM organizations WHERE tenant_id=${tenantId}::uuid AND state='active' FOR UPDATE`;
  if (!row) throw new NotFoundError();
  return row;
}
async function move(tx: Tx, tenantId: string, operationId: string) {
  const [row] = await tx.$queryRaw<
    MoveRow[]
  >`SELECT tenant_id::text, operation_id::text, source_shard_id,
    target_shard_id, expected_epoch, resulting_epoch, state, receipts FROM placement_moves
    WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid FOR UPDATE`;
  return row;
}
function sameRequest(
  row: MoveRow,
  expectedEpoch: string,
  targetShardId: string,
) {
  if (
    row.expected_epoch.toString() !== expectedEpoch ||
    row.target_shard_id !== targetShardId
  )
    throw new IdempotencyConflictError();
}
async function activeTarget(tx: Tx, shardId: string) {
  const rows = await tx.$queryRaw<
    unknown[]
  >`SELECT 1 FROM shard_registry WHERE shard_id=${shardId} AND state='active'`;
  if (!rows.length) throw new PlacementUnavailableError();
}

/** Trusted migration controller only; no public HTTP mutation is mounted. */
export async function preparePlacementMove(
  db: Db,
  tenantId: string,
  expectedEpoch: string,
  targetShardId: string,
  operationId: string,
): Promise<PlacementMove> {
  input(expectedEpoch, targetShardId, operationId);
  return inScope(db, { tenantId }, async (tx) => {
    const org = await organization(tx, tenantId);
    const previous = await move(tx, tenantId, operationId);
    if (previous) {
      sameRequest(previous, expectedEpoch, targetShardId);
      return moveDto(previous);
    }
    if (
      org.routing_epoch.toString() !== expectedEpoch ||
      org.placement_state !== "active" ||
      org.shard_id === targetShardId
    )
      throw new PlacementConflictError(
        "placement changed or a move is already active",
      );
    const pending = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM placement_moves WHERE tenant_id=${tenantId}::uuid AND state IN ('preparing','quiescing','switched')`;
    if (pending.length)
      throw new PlacementConflictError("a move is already active");
    await activeTarget(tx, targetShardId);
    await tx.$executeRaw`INSERT INTO placement_moves (tenant_id,operation_id,expected_epoch,source_shard_id,target_shard_id,state)
      VALUES (${tenantId}::uuid,${operationId}::uuid,${BigInt(expectedEpoch)},${org.shard_id},${targetShardId},'preparing')`;
    return moveDto((await move(tx, tenantId, operationId))!);
  });
}

export async function beginPlacementMove(
  db: Db,
  tenantId: string,
  expectedEpoch: string,
  targetShardId: string,
  operationId: string,
): Promise<PlacementMove> {
  input(expectedEpoch, targetShardId, operationId);
  return inScope(db, { tenantId }, async (tx) => {
    const org = await organization(tx, tenantId);
    const previous = await move(tx, tenantId, operationId);
    if (previous) {
      sameRequest(previous, expectedEpoch, targetShardId);
      if (previous.state === "preparing") {
        if (
          org.routing_epoch.toString() !== expectedEpoch ||
          org.placement_state !== "active" ||
          org.shard_id !== previous.source_shard_id
        )
          throw new PlacementConflictError("placement changed");
        await activeTarget(tx, targetShardId);
        await tx.$executeRaw`UPDATE placement_moves SET state='quiescing',updated_at=clock_timestamp()
          WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid`;
        await tx.$executeRaw`UPDATE organizations SET placement_state='quiescing',updated_at=clock_timestamp() WHERE tenant_id=${tenantId}::uuid`;
        return moveDto((await move(tx, tenantId, operationId))!);
      }
      return moveDto(previous);
    }
    if (
      org.routing_epoch.toString() !== expectedEpoch ||
      org.placement_state !== "active" ||
      org.shard_id === targetShardId
    )
      throw new PlacementConflictError(
        "placement changed or a move is already active",
      );
    const pending = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM placement_moves WHERE tenant_id=${tenantId}::uuid AND state IN ('preparing','quiescing','switched')`;
    if (pending.length)
      throw new PlacementConflictError("a move is already active");
    await activeTarget(tx, targetShardId);
    await tx.$executeRaw`INSERT INTO placement_moves (tenant_id,operation_id,expected_epoch,source_shard_id,target_shard_id,state)
      VALUES (${tenantId}::uuid,${operationId}::uuid,${BigInt(expectedEpoch)},${org.shard_id},${targetShardId},'quiescing')`;
    await tx.$executeRaw`UPDATE organizations SET placement_state='quiescing',updated_at=clock_timestamp() WHERE tenant_id=${tenantId}::uuid`;
    return moveDto((await move(tx, tenantId, operationId))!);
  });
}

/** Called only after the migration controller verifies all source fences, final
 * copy and target-preparation receipts. CAS commits the durable route once;
 * activating blocks normal admission until all target owners are activated.
 */
export async function compareAndSetPlacement(
  db: Db,
  tenantId: string,
  expectedEpoch: string,
  targetShardId: string,
  operationId: string,
): Promise<PlacementMove> {
  input(expectedEpoch, targetShardId, operationId);
  return inScope(db, { tenantId }, async (tx) => {
    const org = await organization(tx, tenantId);
    const pending = await move(tx, tenantId, operationId);
    if (!pending)
      throw new PlacementConflictError("move must be prepared first");
    sameRequest(pending, expectedEpoch, targetShardId);
    if (pending.state === "switched" || pending.state === "completed")
      return moveDto(pending);
    if (
      pending.state !== "quiescing" ||
      org.routing_epoch.toString() !== expectedEpoch ||
      org.placement_state !== "quiescing" ||
      org.shard_id !== pending.source_shard_id
    )
      throw new PlacementConflictError("placement changed");
    requireReceipts(pending, [
      "source_fenced",
      "target_prepared",
      "copy_verified",
    ]);
    await activeTarget(tx, targetShardId);
    const nextEpoch = BigInt(expectedEpoch) + 1n;
    if (nextEpoch > 9223372036854775807n)
      throw new PlacementConflictError("placement epoch exhausted");
    // Ledger and route commit atomically; the ownership trigger requires this
    // matching switched operation before permitting the shard change.
    await tx.$executeRaw`UPDATE placement_moves SET state='switched',resulting_epoch=${nextEpoch},updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid`;
    const updated =
      await tx.$executeRaw`UPDATE organizations SET shard_id=${targetShardId},routing_epoch=${nextEpoch},placement_state='activating',updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}::uuid AND routing_epoch=${BigInt(expectedEpoch)}`;
    if (updated !== 1) throw new PlacementConflictError("placement changed");
    return moveDto((await move(tx, tenantId, operationId))!);
  });
}

/** Finish after positive activation receipts. Abort is only a pre-switch operation
 * after positively proving every target remains unactivated; it advances epoch
 * so previously fenced source workers cannot regain authority by replaying.
 */
export async function finishPlacementMove(
  db: Db,
  tenantId: string,
  operationId: string,
  outcome: "completed" | "aborted",
): Promise<PlacementMove> {
  if (!UUID.test(operationId) || !["completed", "aborted"].includes(outcome))
    throw new InvalidInputError("invalid placement operation");
  return inScope(db, { tenantId }, async (tx) => {
    const org = await organization(tx, tenantId);
    const pending = await move(tx, tenantId, operationId);
    if (!pending) throw new NotFoundError("placement move");
    if (pending.state === outcome) return moveDto(pending);
    if (
      (outcome === "completed" &&
        (pending.state !== "switched" ||
          org.shard_id !== pending.target_shard_id ||
          org.routing_epoch !== pending.resulting_epoch ||
          org.placement_state !== "activating")) ||
      (outcome === "aborted" &&
        (!["preparing", "quiescing"].includes(pending.state) ||
          org.shard_id !== pending.source_shard_id ||
          org.routing_epoch !== pending.expected_epoch ||
          org.placement_state !==
            (pending.state === "preparing" ? "active" : "quiescing")))
    )
      throw new PlacementConflictError("move cannot finish in this state");
    requireReceipts(
      pending,
      outcome === "completed"
        ? ["target_activated"]
        : ["targets_unactivated", "source_reactivated"],
    );
    const epoch =
      outcome === "aborted" ? org.routing_epoch + 1n : org.routing_epoch;
    if (epoch > 9223372036854775807n)
      throw new PlacementConflictError("placement epoch exhausted");
    await tx.$executeRaw`UPDATE placement_moves SET state=${outcome},resulting_epoch=${epoch},updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid`;
    await tx.$executeRaw`UPDATE organizations SET placement_state='active',routing_epoch=${epoch},updated_at=clock_timestamp() WHERE tenant_id=${tenantId}::uuid`;
    return moveDto((await move(tx, tenantId, operationId))!);
  });
}

function requireReceipts(row: MoveRow, keys: string[]) {
  const evidenceMatches = (key: string, receipt: Record<string, unknown>) => {
    if (
      receipt.phase !== key ||
      receipt.tenantId !== row.tenant_id ||
      receipt.operationId !== row.operation_id
    )
      return false;
    if (
      receipt.sourceShardId !== row.source_shard_id ||
      receipt.targetShardId !== row.target_shard_id ||
      receipt.sourceEpoch !== row.expected_epoch.toString() ||
      receipt.targetEpoch !== (row.expected_epoch + 1n).toString() ||
      typeof receipt.sourceIncarnation !== "string" ||
      !UUID.test(receipt.sourceIncarnation) ||
      typeof receipt.targetIncarnation !== "string" ||
      !UUID.test(receipt.targetIncarnation)
    )
      return false;
    if (key === "source_fenced")
      return (
        receipt.shardId === row.source_shard_id &&
        receipt.incarnation === receipt.sourceIncarnation &&
        receipt.epoch === row.expected_epoch.toString() &&
        receipt.state === "fenced"
      );
    if (key === "target_prepared")
      return (
        receipt.shardId === row.target_shard_id &&
        receipt.incarnation === receipt.targetIncarnation &&
        receipt.epoch === (row.expected_epoch + 1n).toString() &&
        receipt.state === "prepared"
      );
    if (key === "copy_verified" || key === "baseline_copied")
      return (
        typeof receipt.sourceSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(receipt.sourceSha256) &&
        receipt.sourceSha256 === receipt.targetSha256 &&
        typeof receipt.rowCount === "string" &&
        /^[0-9]+$/.test(receipt.rowCount) &&
        (key !== "copy_verified" ||
          (Number.isSafeInteger(receipt.tableCount) &&
            Number(receipt.tableCount) > 0))
      );
    if (key === "target_activated")
      return (
        receipt.shardId === row.target_shard_id &&
        receipt.incarnation === receipt.targetIncarnation &&
        receipt.epoch === (row.expected_epoch + 1n).toString() &&
        receipt.state === "active"
      );
    if (key === "targets_unactivated")
      return (
        receipt.shardId === row.target_shard_id && receipt.state === "absent"
      );
    if (key === "source_reactivated")
      return (
        receipt.shardId === row.source_shard_id &&
        receipt.incarnation === receipt.sourceIncarnation &&
        receipt.epoch === (row.expected_epoch + 1n).toString() &&
        receipt.state === "active"
      );
    return false;
  };
  const valid = (key: string, value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const receipt = value as Record<string, unknown>;
    return evidenceMatches(key, receipt);
  };
  if (keys.some((key) => !valid(key, row.receipts[key])))
    throw new PlacementConflictError(
      "operation-bound placement evidence is missing or invalid",
    );
}

/** The internal move controller stores operation-bound evidence produced by owner
 * adapters after querying committed database state. Callers cannot submit a boolean
 * success marker; cutover requires typed identities, epochs, and matching digests. */
export async function recordPlacementMoveReceipt(
  db: Db,
  tenantId: string,
  operationId: string,
  key: string,
  receipt: Record<string, unknown>,
): Promise<PlacementMove> {
  if (
    !UUID.test(operationId) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    receipt.tenantId !== tenantId ||
    receipt.operationId !== operationId ||
    receipt.phase !== key
  )
    throw new InvalidInputError("invalid placement receipt");
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > 64_000)
    throw new InvalidInputError("placement receipt is too large");
  return inScope(db, { tenantId }, async (tx) => {
    await organization(tx, tenantId);
    const pending = await move(tx, tenantId, operationId);
    if (!pending) throw new NotFoundError("placement move");
    if (Object.hasOwn(pending.receipts, key)) {
      const [existing] = await tx.$queryRaw<
        { equal: boolean }[]
      >`SELECT receipts->${key} = ${serialized}::jsonb AS equal
        FROM placement_moves WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid`;
      if (!existing?.equal) throw new IdempotencyConflictError();
      return moveDto(pending);
    }
    if (["completed", "aborted"].includes(pending.state))
      throw new PlacementConflictError("move is already closed");
    if (Object.keys(pending.receipts).length >= 64)
      throw new InvalidInputError("too many placement receipts");
    await tx.$executeRaw`UPDATE placement_moves SET receipts=receipts || jsonb_build_object(${key}::text,${serialized}::jsonb),updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}::uuid AND operation_id=${operationId}::uuid`;
    return moveDto((await move(tx, tenantId, operationId))!);
  });
}

export async function placementMove(
  db: Db,
  tenantId: string,
  operationId: string,
): Promise<PlacementMove> {
  if (!UUID.test(operationId))
    throw new InvalidInputError("invalid placement operation");
  return inScope(db, { tenantId }, async (tx) => {
    const pending = await move(tx, tenantId, operationId);
    if (!pending) throw new NotFoundError("placement move");
    return moveDto(pending);
  });
}
