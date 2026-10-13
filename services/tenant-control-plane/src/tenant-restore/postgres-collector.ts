import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  INVENTORY_RESTORE_TABLES,
  deriveLocalShardIncarnation,
} from "./preflight.js";
import type { StorageObservation } from "./collector.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export interface LocalStorageSource {
  label: StorageObservation["label"];
  inventory: Pool;
  physical: Pool | null;
  composeProject: string;
  expectedMigrations: { name: string; sha256: string }[];
}
/** Privileged forensic read only. This adapter never serves application data.
 * Runtime credentials must remain separate; schema-owner access is supplied by
 * the explicitly authorized local operator helper, never an HTTP caller. */
export async function observeLocalInventory(
  source: LocalStorageSource,
  tenantId: string,
): Promise<StorageObservation> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      tenantId,
    ) ||
    !/^greenguard-sharding(?:-[a-z0-9-]+)?$/.test(source.composeProject)
  )
    throw new Error("invalid trusted collector scope");
  const db = await source.inventory.connect();
  try {
    await db.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='2s';SET LOCAL lock_timeout='500ms'",
    );
    const schema = await db.query(
      "SELECT c.relname AS name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,a.attname AS column,format_type(a.atttypid,a.atttypmod) AS type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND EXISTS(SELECT 1 FROM pg_attribute t WHERE t.attrelid=c.oid AND t.attname='tenant_id' AND t.attnum>0 AND NOT t.attisdropped) ORDER BY c.relname,a.attnum",
    );
    const names = [...new Set(schema.rows.map((r) => r.name))];
    if (JSON.stringify(names) !== JSON.stringify(INVENTORY_RESTORE_TABLES))
      throw new Error("unreviewed tenant schema");
    const ownership = (
      await db.query(
        "SELECT shard_id,shard_incarnation::text AS incarnation,placement_epoch::text AS epoch,state FROM greenguard_internal.tenant_ownership WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows[0];
    const tables: StorageObservation["tables"] = [];
    let bytes = 0;
    for (const name of INVENTORY_RESTORE_TABLES) {
      const size = (
        await db.query(
          `SELECT count(*)::text AS count,coalesce(sum(octet_length(row_to_json(t)::text)),0)::text AS bytes FROM public."${name}" t WHERE tenant_id=$1`,
          [tenantId],
        )
      ).rows[0];
      if (
        !/^(0|[1-9][0-9]*)$/.test(size.count) ||
        !/^(0|[1-9][0-9]*)$/.test(size.bytes) ||
        BigInt(size.count) > 5000n ||
        BigInt(size.bytes) + BigInt(bytes) > 2n * 1024n * 1024n
      )
        throw new Error("bounded snapshot exceeded");

      const rows = await db.query(
        `SELECT row_to_json(t)::text AS body FROM public."${name}" t WHERE tenant_id=$1 ORDER BY row_to_json(t)::text LIMIT 5001`,
        [tenantId],
      );
      if (rows.rows.length > 5000) throw new Error("bounded snapshot exceeded");
      const digest = createHash("sha256");
      for (const row of rows.rows) {
        bytes += Buffer.byteLength(row.body);
        if (bytes > 2 * 1024 * 1024)
          throw new Error("bounded snapshot exceeded");
        digest.update(row.body).update("\n");
      }
      tables.push({
        name,
        rowCount: String(rows.rows.length),
        sha256: digest.digest("hex"),
      });
    }
    const pending = (
      await db.query(
        "SELECT count(*)::text AS count FROM public.inventory_saga_result_outbox WHERE tenant_id=$1 AND published_at IS NULL",
        [tenantId],
      )
    ).rows[0].count;
    const ledger = await db.query(
      "SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations ORDER BY migration_name",
    );
    const expected = (
      source as LocalStorageSource & {
        expectedMigrations?: { name: string; sha256: string }[];
      }
    ).expectedMigrations;
    const migrationChecksumsVerified =
      !!expected &&
      ledger.rows.length === expected.length &&
      ledger.rows.every(
        (row, i) =>
          row.migration_name === expected[i]!.name &&
          row.checksum === expected[i]!.sha256 &&
          row.finished &&
          !row.rolled_back,
      );
    await db.query("ROLLBACK");
    let physicalShardId: string | null = null,
      physicalIncarnation: string | null = null;
    if (source.physical) {
      const physical = await source.physical.connect();
      try {
        await physical.query(
          "BEGIN READ ONLY;SET LOCAL statement_timeout='2s'",
        );
        const id = (
          await physical.query(
            "SELECT shard_id FROM public.greenguard_shard_identity",
          )
        ).rows[0]?.shard_id;
        const system = (
          await physical.query(
            "SELECT system_identifier::text AS id FROM pg_control_system()",
          )
        ).rows[0]?.id;
        if (!/^s[1-4]$/.test(id) || !/^\d{1,20}$/.test(system))
          throw new Error("invalid physical identity");
        physicalShardId = id;
        physicalIncarnation = deriveLocalShardIncarnation(
          source.composeProject,
          id,
          system,
        );
        await physical.query("ROLLBACK");
      } finally {
        await physical.query("ROLLBACK").catch(() => {});
        physical.release();
      }
    }
    return {
      label: source.label,
      physicalShardId,
      physicalIncarnation,
      ownership: ownership
        ? {
            shardId: ownership.shard_id,
            incarnation: ownership.incarnation,
            epoch: ownership.epoch,
            state: ownership.state,
          }
        : null,
      schemaSha256: sha(JSON.stringify(schema.rows)),
      migrationChecksumsVerified,
      forceRlsVerified: schema.rows.every((r) => r.enabled && r.forced),
      tables,
      snapshotSha256: sha(JSON.stringify(tables)),
      pendingSagaRows: pending,
    };
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    db.release();
  }
}
