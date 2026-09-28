import type { Pool } from "pg";
import type { OwnerIdentity } from "./pg-owner.js";

const JOBS_TABLES = [
  "dead_letter_outbox",
  "dispatch_outbox",
  "inbox",
  "intent_redrives",
  "notification_intents",
] as const;
const NOTIFICATION_TABLES = [
  "deliveries",
  "delivery_attempts",
  "notification_preferences",
] as const;
const SHARD = /^s[1-4]$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface JobsNotificationsDrainResult {
  owner: "jobs" | "notifications";
  tenantId: string;
  shardId: string;
  incarnation: string;
  epoch: string;
  liveRows: number;
  pendingDispatch: number;
  pendingDeadLetter: number;
  checkedAt: string;
}

function validate(tenantId: string, source: OwnerIdentity): void {
  if (
    !UUID.test(tenantId) ||
    !SHARD.test(source.shardId) ||
    !UUID.test(source.incarnation) ||
    !/^[1-9][0-9]*$/.test(source.epoch)
  )
    throw new Error("invalid Jobs/Notifications move source identity");
}

async function assertExactSchema(
  pool: Pool,
  owner: "jobs" | "notifications",
  expected: readonly string[],
): Promise<void> {
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
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index]) ||
    result.rows.some((row) => row.relkind !== "r" || row.is_partition)
  )
    throw new Error(
      `${owner} move schema differs from the reviewed table inventory; expected ${expected.join(",")}, got ${actual.join(",")}`,
    );
}

async function assertFencedSource(
  pool: Pool,
  tenantId: string,
  source: OwnerIdentity,
): Promise<void> {
  const result = await pool.query<{
    shard_id: string;
    incarnation: string;
    epoch: string;
    state: string;
  }>(
    `SELECT shard_id,shard_incarnation::text AS incarnation,
       placement_epoch::text AS epoch,state
       FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1::uuid`,
    [tenantId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.state !== "fenced" ||
    row.shard_id !== source.shardId ||
    row.incarnation !== source.incarnation ||
    row.epoch !== source.epoch
  )
    throw new Error(
      "Jobs/Notifications drain gate requires the exact source placement to be durably fenced",
    );
}

function count(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`invalid ${label} count in Jobs/Notifications drain gate`);
  return parsed;
}

/**
 * Read-only fail-closed preflight for a coordinated Jobs + Notifications move.
 * It is intentionally not a move receipt: it checks one owner at a time, and the
 * global coordinator must fence both owners before calling either function.
 */
export async function inspectJobsMoveDrain(
  pool: Pool,
  tenantId: string,
  source: OwnerIdentity,
): Promise<JobsNotificationsDrainResult> {
  validate(tenantId, source);
  await assertExactSchema(pool, "jobs", JOBS_TABLES);
  await assertFencedSource(pool, tenantId, source);
  const result = await pool.query<{
    live_rows: string | number;
    pending_dispatch: string | number;
    pending_dead_letter: string | number;
  }>(
    `SELECT
       (SELECT count(*) FROM notification_intents
          WHERE tenant_id=$1::uuid AND status NOT IN ('sent','failed','suppressed')) AS live_rows,
       (SELECT count(*) FROM dispatch_outbox
          WHERE tenant_id=$1::uuid AND dispatched_at IS NULL) AS pending_dispatch,
       (SELECT count(*) FROM dead_letter_outbox
          WHERE tenant_id=$1::uuid AND published_at IS NULL) AS pending_dead_letter`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Jobs drain query returned no result");
  const proof: JobsNotificationsDrainResult = {
    owner: "jobs",
    tenantId,
    shardId: source.shardId,
    incarnation: source.incarnation,
    epoch: source.epoch,
    liveRows: count(row.live_rows, "Jobs live row"),
    pendingDispatch: count(row.pending_dispatch, "Jobs pending dispatch"),
    pendingDeadLetter: count(row.pending_dead_letter, "Jobs pending dead-letter"),
    checkedAt: new Date().toISOString(),
  };
  assertDrained(proof);
  return proof;
}

export async function inspectNotificationsMoveDrain(
  pool: Pool,
  tenantId: string,
  source: OwnerIdentity,
): Promise<JobsNotificationsDrainResult> {
  validate(tenantId, source);
  await assertExactSchema(pool, "notifications", NOTIFICATION_TABLES);
  await assertFencedSource(pool, tenantId, source);
  const result = await pool.query<{
    live_rows: string | number;
  }>(
    `SELECT count(*) AS live_rows FROM deliveries
      WHERE tenant_id=$1::uuid AND status NOT IN ('sent','failed','suppressed')`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Notifications drain query returned no result");
  const proof: JobsNotificationsDrainResult = {
    owner: "notifications",
    tenantId,
    shardId: source.shardId,
    incarnation: source.incarnation,
    epoch: source.epoch,
    liveRows: count(row.live_rows, "Notifications live row"),
    pendingDispatch: 0,
    pendingDeadLetter: 0,
    checkedAt: new Date().toISOString(),
  };
  assertDrained(proof);
  return proof;
}

function assertDrained(proof: JobsNotificationsDrainResult): void {
  if (
    proof.liveRows !== 0 ||
    proof.pendingDispatch !== 0 ||
    proof.pendingDeadLetter !== 0
  )
    throw new Error(
      `${proof.owner} tenant work is not drained: live=${proof.liveRows}, pendingDispatch=${proof.pendingDispatch}, pendingDeadLetter=${proof.pendingDeadLetter}; resolve/reconcile broker and provider work before moving`,
    );
}
