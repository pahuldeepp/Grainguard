import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export interface OwnerIdentity {
  shardId: string;
  incarnation: string;
  epoch: string;
}

export interface CopyEvidence {
  tenantId: string;
  operationId: string;
  source: OwnerIdentity;
  target: OwnerIdentity;
  tableCount: number;
  rowCount: string;
  sourceSha256: string;
  targetSha256: string;
  verifiedAt: string;
}

interface TenantTable {
  name: string;
  columns: string[];
  types: Map<string, string>;
  primaryKeyTypes: Map<string, string>;
  primaryKey: string[];
  dependencies: Set<string>;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHARD = /^s[1-4]$/;
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

function validateIdentity(value: OwnerIdentity): void {
  if (
    !SHARD.test(value.shardId) ||
    !UUID.test(value.incarnation) ||
    !/^[1-9][0-9]*$/.test(value.epoch)
  ) {
    throw new Error("invalid owner identity");
  }
}

async function inspectTables(client: PoolClient): Promise<TenantTable[]> {
  const result = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_primary_key: boolean;
  }>(`
    SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS data_type,
      EXISTS (SELECT 1 FROM pg_index i
        WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS is_primary_key
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND a.attnum>0 AND NOT a.attisdropped
      AND EXISTS (SELECT 1 FROM pg_attribute tenant
        WHERE tenant.attrelid=c.oid AND tenant.attname='tenant_id'
          AND tenant.attnum>0 AND NOT tenant.attisdropped)
    ORDER BY c.relname,a.attnum`);
  const byName = new Map<string, TenantTable>();
  for (const row of result.rows) {
    const table = byName.get(row.table_name) ?? {
      name: row.table_name,
      columns: [],
      types: new Map<string, string>(),
      primaryKeyTypes: new Map<string, string>(),
      primaryKey: [],
      dependencies: new Set<string>(),
    };
    table.columns.push(row.column_name);
    table.types.set(row.column_name, row.data_type);
    if (row.is_primary_key) {
      table.primaryKey.push(row.column_name);
      table.primaryKeyTypes.set(row.column_name, row.data_type);
    }
    byName.set(row.table_name, table);
  }
  const fk = await client.query<{
    table_name: string;
    foreign_table_name: string;
  }>(`
    SELECT child.relname AS table_name, parent.relname AS foreign_table_name
    FROM pg_constraint con
    JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_namespace ns ON ns.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=con.confrelid
    WHERE con.contype='f' AND ns.nspname='public'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=child.oid
        AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=parent.oid
        AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped)`);
  for (const edge of fk.rows)
    byName.get(edge.table_name)?.dependencies.add(edge.foreign_table_name);
  const tables = [...byName.values()];
  if (tables.some((table) => table.primaryKey.length === 0)) {
    throw new Error(
      "tenant table without a primary key requires an explicit move adapter",
    );
  }
  return topologicalTables(tables);
}

function topologicalTables(tables: TenantTable[]): TenantTable[] {
  const pending = new Map(tables.map((table) => [table.name, table]));
  const ordered: TenantTable[] = [];
  while (pending.size) {
    const ready = [...pending.values()]
      .filter((table) =>
        [...table.dependencies].every((name) => !pending.has(name)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!ready.length)
      throw new Error(
        "tenant table foreign-key cycle requires an explicit move adapter",
      );
    for (const table of ready) {
      pending.delete(table.name);
      ordered.push(table);
    }
  }
  return ordered;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Buffer.isBuffer(value))
    return JSON.stringify({ bytea: value.toString("hex") });
  if (value instanceof Date)
    return JSON.stringify({ timestamp: value.toISOString() });
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function assertOwner(
  client: PoolClient,
  tenantId: string,
  identity: OwnerIdentity,
  state: "fenced" | "prepared",
): Promise<void> {
  const result = await client.query<{
    shard_id: string;
    incarnation: string;
    epoch: string;
    state: string;
  }>(
    `
    SELECT shard_id, shard_incarnation::text AS incarnation,
      placement_epoch::text AS epoch,state
    FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1::uuid`,
    [tenantId],
  );
  const owner = result.rows[0];
  if (
    !owner ||
    owner.shard_id !== identity.shardId ||
    owner.incarnation !== identity.incarnation ||
    owner.epoch !== identity.epoch ||
    owner.state !== state
  ) {
    throw new Error(
      `owner placement does not match required ${state} identity`,
    );
  }
}

export interface MoveReceipt {
  tenantId: string;
  operationId: string;
  phase: string;
  [key: string]: unknown;
}

async function callReceipt(
  pool: Pool,
  sql: string,
  values: unknown[],
): Promise<MoveReceipt> {
  const result = await pool.query<{ receipt: MoveReceipt }>(sql, values);
  if (!result.rows[0]?.receipt || typeof result.rows[0].receipt !== "object")
    throw new Error("owner move procedure returned no receipt");
  return result.rows[0].receipt;
}

function assertReceiptIdentity(
  receipt: MoveReceipt,
  tenantId: string,
  operationId: string,
  phase: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): void {
  if (
    receipt.tenantId !== tenantId ||
    receipt.operationId !== operationId ||
    receipt.phase !== phase ||
    receipt.sourceShardId !== source.shardId ||
    receipt.sourceIncarnation !== source.incarnation ||
    receipt.sourceEpoch !== source.epoch ||
    receipt.targetShardId !== target.shardId ||
    receipt.targetIncarnation !== target.incarnation ||
    receipt.targetEpoch !== target.epoch
  ) {
    throw new Error(
      `owner ${phase} receipt is not bound to the requested tenant move: ${JSON.stringify(receipt)}`,
    );
  }
}

export async function prepareRiskMoveTarget(
  pool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): Promise<MoveReceipt> {
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
  assertReceiptIdentity(
    receipt,
    tenantId,
    operationId,
    "target_prepared",
    source,
    target,
  );
  if (
    receipt.state !== "prepared" ||
    receipt.shardId !== target.shardId ||
    receipt.epoch !== target.epoch
  )
    throw new Error("Risk target preparation receipt is invalid");
  return receipt;
}

export async function fenceRiskMoveSource(
  pool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
): Promise<MoveReceipt> {
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
  assertReceiptIdentity(
    receipt,
    tenantId,
    operationId,
    "source_fenced",
    source,
    target,
  );
  if (
    receipt.state !== "fenced" ||
    receipt.shardId !== source.shardId ||
    receipt.epoch !== source.epoch
  )
    throw new Error("Risk source fence receipt is invalid");
  return receipt;
}

/** Persist Risk's copy proof on the target transaction's client. Call only from
 * copyTenantSnapshot(onVerified): this makes the durable receipt atomic with the
 * imported tenant rows and makes a post-COMMIT retry safely discoverable.
 */
export async function recordRiskMoveCopy(
  targetClient: PoolClient,
  evidence: CopyEvidence,
): Promise<MoveReceipt> {
  const result = await targetClient.query<{ receipt: MoveReceipt }>(
    `SELECT greenguard_internal.record_tenant_move_copy($1::uuid,$2::uuid,$3,$4,$5::bigint,$6::integer) AS receipt`,
    [
      evidence.tenantId,
      evidence.operationId,
      evidence.sourceSha256,
      evidence.targetSha256,
      evidence.rowCount,
      evidence.tableCount,
    ],
  );
  const receipt = result.rows[0]?.receipt;
  if (!receipt || typeof receipt !== "object")
    throw new Error("Risk copy receipt procedure returned no receipt");
  assertReceiptIdentity(
    receipt,
    evidence.tenantId,
    evidence.operationId,
    "copy_verified",
    evidence.source,
    evidence.target,
  );
  if (receipt.owner !== "risk")
    throw new Error("Risk copy receipt has no Risk owner identity");
  if (
    receipt.sourceSha256 !== evidence.sourceSha256 ||
    receipt.targetSha256 !== evidence.targetSha256 ||
    receipt.rowCount !== evidence.rowCount ||
    receipt.tableCount !== evidence.tableCount
  )
    throw new Error(
      "Risk copy receipt differs from verified snapshot evidence",
    );
  return receipt;
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
): Promise<MoveReceipt> {
  if (
    route.tenantId !== tenantId ||
    route.shardId !== target.shardId ||
    route.placementEpoch !== target.epoch ||
    route.state !== "activating"
  ) {
    throw new Error(
      "control-plane placement is not switched to this target; activation is refused",
    );
  }
  const receipt = await callReceipt(
    pool,
    `SELECT greenguard_internal.activate_tenant_move_target($1::uuid,$2::uuid) AS receipt`,
    [tenantId, operationId],
  );
  assertReceiptIdentity(
    receipt,
    tenantId,
    operationId,
    "target_activated",
    source,
    target,
  );
  if (
    receipt.tenantId !== tenantId ||
    receipt.operationId !== operationId ||
    receipt.phase !== "target_activated" ||
    receipt.shardId !== target.shardId ||
    receipt.incarnation !== target.incarnation ||
    receipt.epoch !== target.epoch ||
    receipt.state !== "active" ||
    typeof receipt.sourceSha256 !== "string" ||
    receipt.sourceSha256 !== receipt.targetSha256 ||
    !/^[0-9a-f]{64}$/.test(receipt.sourceSha256)
  ) {
    throw new Error("Risk target activation receipt is invalid");
  }
  return receipt;
}

/** Copy an immutable tenant snapshot between owner databases after the source has
 * been fenced. Target ownership must match the new route. It refuses to overwrite
 * any target rows, copies in FK order, and compares canonical full-slice digests
 * before commit. A table cycle fails closed and requires an owner-specific adapter.
 */
export async function copyTenantSnapshot(
  sourcePool: Pool,
  targetPool: Pool,
  tenantId: string,
  operationId: string,
  source: OwnerIdentity,
  target: OwnerIdentity,
  onVerified?: (
    targetClient: PoolClient,
    evidence: CopyEvidence,
  ) => Promise<void>,
): Promise<CopyEvidence> {
  if (!UUID.test(tenantId)) throw new Error("invalid tenant id");
  if (!UUID.test(operationId)) throw new Error("invalid move operation id");
  validateIdentity(source);
  validateIdentity(target);
  if (
    source.shardId === target.shardId ||
    BigInt(target.epoch) <= BigInt(source.epoch)
  )
    throw new Error("target placement must advance to another shard");

  const sourceClient = await sourcePool.connect();
  const targetClient = await targetPool.connect();
  try {
    await sourceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sourceClient.query("SET LOCAL TIME ZONE 'UTC'");
    await sourceClient.query("SELECT set_config('app.tenant_id',$1,true)", [
      tenantId,
    ]);
    await assertOwner(sourceClient, tenantId, source, "fenced");
    const tables = await inspectTables(sourceClient);
    await targetClient.query("BEGIN");
    await targetClient.query("SET LOCAL TIME ZONE 'UTC'");
    await targetClient.query("SELECT set_config('app.tenant_id',$1,true)", [
      tenantId,
    ]);
    await targetClient.query("SELECT set_config('app.shard_id',$1,true)", [
      target.shardId,
    ]);
    await targetClient.query(
      "SELECT set_config('app.shard_incarnation',$1,true)",
      [target.incarnation],
    );
    await targetClient.query(
      "SELECT set_config('app.placement_epoch',$1,true)",
      [target.epoch],
    );
    await targetClient.query(
      "SELECT set_config('app.tenant_move_operation_id',$1,true)",
      [operationId],
    );
    await assertOwner(targetClient, tenantId, target, "prepared");
    const sourceHash = createHash("sha256");
    const targetHash = createHash("sha256");
    let sourceRowCount = 0n;
    let targetRowCount = 0n;
    const pageSize = 500;
    const isTimestamp = (type: string | undefined) =>
      type !== undefined &&
      /^timestamp(?:\(\d+\))? (?:without|with) time zone$/.test(type);
    const tableCursorIndex = new Map<string, number>();
    const cursorColumn = (column: string) =>
      `__greenguard_move_cursor_${tableCursorIndex.get(column)}`;
    const selectedColumns = (table: TenantTable) => {
      const selected = table.columns.map((column) => {
        const type = table.types.get(column);
        // node-postgres parses timestamps into JavaScript Date (millisecond
        // precision). Keep their exact PostgreSQL text for hashing and import.
        if (isTimestamp(type))
          return `${identifier(column)}::text AS ${identifier(column)}`;
        if (type?.startsWith("json"))
          return `${identifier(column)}::text AS ${identifier(column)}`;
        return identifier(column);
      });
      tableCursorIndex.clear();
      table.primaryKey.forEach((column, index) => {
        if (!isTimestamp(table.primaryKeyTypes.get(column))) return;
        tableCursorIndex.set(column, index);
        selected.push(
          `${identifier(column)}::text AS ${identifier(cursorColumn(column))}`,
        );
      });
      return selected.join(",");
    };
    const readPage = async (
      client: PoolClient,
      table: TenantTable,
      cursor?: QueryResultRow,
    ) => {
      const keyColumns = table.primaryKey.map(identifier).join(",");
      const values: unknown[] = [tenantId];
      let after = "";
      if (cursor) {
        values.push(
          ...table.primaryKey.map((column) =>
            isTimestamp(table.primaryKeyTypes.get(column))
              ? cursor[cursorColumn(column)]
              : cursor[column],
          ),
        );
        after = ` AND (${keyColumns}) > (${table.primaryKey.map((_, index) => `$${index + 2}`).join(",")})`;
      }
      values.push(pageSize);
      const limit = `$${values.length}::integer`;
      return client.query(
        `SELECT ${selectedColumns(table)} FROM public.${identifier(table.name)} WHERE tenant_id=$1::uuid${after} ORDER BY ${keyColumns} LIMIT ${limit}`,
        values,
      );
    };
    for (const table of tables) {
      sourceHash.update(`table:${table.name}\n`);
      targetHash.update(`table:${table.name}\n`);
      const existing = await targetClient.query(
        `SELECT 1 FROM public.${identifier(table.name)} WHERE tenant_id=$1::uuid LIMIT 1`,
        [tenantId],
      );
      if (existing.rowCount)
        throw new Error(`target already contains tenant rows in ${table.name}`);
      let cursor: QueryResultRow | undefined;
      let sourceTableRowCount = 0n;
      for (;;) {
        const page = await readPage(sourceClient, table, cursor);
        for (const row of page.rows) {
          sourceHash.update(canonical(Object.fromEntries(
            table.columns.map((column) => [column, row[column]]),
          )));
          sourceHash.update("\n");
          sourceRowCount++;
          sourceTableRowCount++;
          const values = table.columns.map((column) => row[column]);
          const placeholders = table.columns.map(
            (column, index) =>
              `$${index + 1}${table.types.get(column)?.startsWith("json") ? `::${table.types.get(column)}` : ""}`,
          );
          await targetClient.query(
            `INSERT INTO public.${identifier(table.name)} (${table.columns.map(identifier).join(",")}) VALUES (${placeholders.join(",")})`,
            values,
          );
        }
        if (page.rows.length < pageSize) break;
        cursor = page.rows.at(-1);
      }
      cursor = undefined;
      let targetTableRowCount = 0n;
      for (;;) {
        const page = await readPage(targetClient, table, cursor);
        for (const row of page.rows) {
          targetHash.update(canonical(Object.fromEntries(
            table.columns.map((column) => [column, row[column]]),
          )));
          targetHash.update("\n");
          targetTableRowCount++;
          targetRowCount++;
        }
        if (page.rows.length < pageSize) break;
        cursor = page.rows.at(-1);
      }
      // Compare per-table counts, so one table's missing rows cannot be hidden by
      // another table's extra rows.
      if (targetTableRowCount !== sourceTableRowCount)
        throw new Error(`tenant row count mismatch in ${table.name}`);
    }
    const sourceEvidence = {
      sha256: sourceHash.digest("hex"),
      rowCount: sourceRowCount,
    };
    const targetEvidence = {
      sha256: targetHash.digest("hex"),
      rowCount: targetRowCount,
    };
    if (
      sourceEvidence.sha256 !== targetEvidence.sha256 ||
      sourceEvidence.rowCount !== targetEvidence.rowCount
    )
      throw new Error("tenant snapshot digest mismatch");
    const evidence: CopyEvidence = {
      tenantId,
      operationId,
      source,
      target,
      tableCount: tables.length,
      rowCount: sourceEvidence.rowCount.toString(),
      sourceSha256: sourceEvidence.sha256,
      targetSha256: targetEvidence.sha256,
      verifiedAt: new Date().toISOString(),
    };
    // Owner-specific durable copy evidence must commit atomically with imported
    // tenant rows. Without this hook a crash after COMMIT but before receipt
    // recording leaves an occupied prepared target that cannot be retried safely.
    await onVerified?.(targetClient, evidence);
    await targetClient.query("COMMIT");
    await sourceClient.query("COMMIT");
    return evidence;
  } catch (error) {
    await targetClient.query("ROLLBACK").catch(() => {});
    await sourceClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    sourceClient.release();
    targetClient.release();
  }
}
