import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import type { PoolConfig, QueryResultRow } from "pg";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION,
  type TenantBootstrapOwnerProof,
  type TenantBootstrapOwnerReadiness,
  type TenantBootstrapPlacement,
} from "./preflight.js";
import type { TenantBootstrapRuntimeAdapter } from "./run.js";

type Owner = (typeof SHARDED_MOVE_OWNERS)[number];
type LedgerKind = "golang-migrate" | "prisma" | "sha256" | "version-list";

interface MigrationEntry {
  version: string;
  path: string;
  sha256: string;
}

export interface TenantBootstrapOwnerMigrationManifest {
  database: string;
  source: string;
  ledger: LedgerKind;
  headVersion: string;
  migrations: MigrationEntry[];
  fingerprint: string;
}

interface LedgerManifest {
  schemaVersion: 1;
  owners: Record<Owner, TenantBootstrapOwnerMigrationManifest>;
}

interface ShardOwnerRegistry {
  version: 1;
  shardId: string;
  shardIncarnation: string;
  caCertPath: string;
  owners: Record<Owner, { url: string }>;
}

const OWNER_DATABASES: Record<Owner, string> = {
  telemetry: "greenguard_telemetry",
  projection: "greenguard_read",
  jobs: "greenguard_jobs",
  saga: "greenguard_sagas",
  hardware: "greenguard_hardware",
  inventory: "greenguard_inventory",
  alerts: "greenguard_alerts",
  risk: "greenguard_risk",
  notifications: "greenguard_notifications",
};
const SHARDS = ["s1", "s2", "s3", "s4"] as const;
const REGISTRY_DIRECTORY = "/var/run/greenguard/tenant-bootstrap";
const CA_PATH = `${REGISTRY_DIRECTORY}/ca/ca.crt`;
const MANIFEST_URL = new URL("./owner-migrations.json", import.meta.url);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function exactKeys(value: object, expected: readonly string[]): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function migrationFingerprintShape(
  owner: Owner,
  manifest: TenantBootstrapOwnerMigrationManifest,
): boolean {
  if (
    !SHA256.test(manifest.fingerprint) ||
    !manifest.migrations.length ||
    !manifest.migrations.every((migration) => SHA256.test(migration.sha256)) ||
    new Set(manifest.migrations.map(({ version }) => version)).size !==
      manifest.migrations.length ||
    manifest.headVersion !== manifest.migrations.at(-1)?.version
  )
    return false;
  const sourceFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        owner,
        database: manifest.database,
        ledger: manifest.ledger,
        migrations: manifest.migrations,
      }),
    )
    .digest("hex");
  return sourceFingerprint === manifest.fingerprint;
}

export function parseTenantBootstrapShardRegistry(
  raw: string,
  expectedShardId: string,
  caPath = CA_PATH,
): ShardOwnerRegistry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid tenant bootstrap shard registry JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid tenant bootstrap shard registry object");
  const registry = value as Record<string, unknown>;
  if (
    !exactKeys(registry, [
      "version",
      "shardId",
      "shardIncarnation",
      "caCertPath",
      "owners",
    ]) ||
    registry.version !== 1 ||
    registry.shardId !== expectedShardId ||
    typeof registry.shardIncarnation !== "string" ||
    !UUID.test(registry.shardIncarnation) ||
    registry.caCertPath !== caPath ||
    !registry.owners ||
    typeof registry.owners !== "object" ||
    Array.isArray(registry.owners)
  )
    throw new Error(
      `invalid tenant bootstrap registry identity for ${expectedShardId}`,
    );

  const rawOwners = registry.owners as Record<string, unknown>;
  if (!exactKeys(rawOwners, SHARDED_MOVE_OWNERS))
    throw new Error(
      `tenant bootstrap registry owner roster is incomplete for ${expectedShardId}`,
    );
  const owners = {} as Record<Owner, { url: string }>;
  for (const owner of SHARDED_MOVE_OWNERS) {
    const config = rawOwners[owner];
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      !exactKeys(config, ["url"]) ||
      typeof (config as { url?: unknown }).url !== "string"
    )
      throw new Error(
        `invalid tenant bootstrap URL entry for ${owner}/${expectedShardId}`,
      );
    const rawUrl = (config as { url: string }).url;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(
        `invalid tenant bootstrap URL for ${owner}/${expectedShardId}`,
      );
    }
    const options = url.searchParams.get("options")?.trim() ?? "";
    const searchKeys = [...url.searchParams.keys()].sort();
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      decodeURIComponent(url.username) !==
        `tenant_bootstrap_${expectedShardId}` ||
      !decodeURIComponent(url.password) ||
      url.pathname !== `/${OWNER_DATABASES[owner]}` ||
      !url.hostname ||
      url.port !== "5432" ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      url.searchParams.get("sslrootcert") !== caPath ||
      searchKeys.join("\0") !== ["sslmode", "sslrootcert"].join("\0") ||
      /\brole\s*=/i.test(options)
    )
      throw new Error(
        `unsafe tenant bootstrap connection contract for ${owner}/${expectedShardId}`,
      );
    owners[owner] = { url: rawUrl };
  }
  return {
    version: 1,
    shardId: expectedShardId,
    shardIncarnation: registry.shardIncarnation,
    caCertPath: caPath,
    owners,
  };
}

async function loadManifest(
  manifestPath: string | URL = MANIFEST_URL,
): Promise<LedgerManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(
      "tenant bootstrap service migration manifest is unavailable",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("tenant bootstrap service migration manifest is invalid");
  const manifest = value as Partial<LedgerManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.owners ||
    !exactKeys(manifest.owners, SHARDED_MOVE_OWNERS)
  )
    throw new Error(
      "tenant bootstrap service migration manifest roster is invalid",
    );
  for (const owner of SHARDED_MOVE_OWNERS) {
    const entry = manifest.owners[owner];
    if (
      !entry ||
      entry.database !== OWNER_DATABASES[owner] ||
      !["golang-migrate", "prisma", "sha256", "version-list"].includes(
        entry.ledger,
      ) ||
      !migrationFingerprintShape(owner, entry)
    )
      throw new Error(
        `tenant bootstrap migration contract is invalid for ${owner}`,
      );
  }
  return manifest as LedgerManifest;
}

export interface RepositoryBootstrapAdapterOptions {
  /** Test seam. Production calls use only the fixed mounted path. */
  registryDirectory?: string;
  manifestPath?: string | URL;
  caPath?: string;
}

export interface RepositoryBootstrapAdapters {
  adapters: readonly TenantBootstrapRuntimeAdapter[];
  close(): Promise<void>;
}

export async function createRepositoryTenantBootstrapAdapters(
  options: RepositoryBootstrapAdapterOptions = {},
): Promise<RepositoryBootstrapAdapters> {
  const registryDirectory = options.registryDirectory ?? REGISTRY_DIRECTORY;
  const caPath = options.caPath ?? CA_PATH;
  const manifest = await loadManifest(options.manifestPath ?? MANIFEST_URL);
  await access(caPath);
  const registries = new Map<string, ShardOwnerRegistry>();
  for (const shardId of SHARDS) {
    const registryPath = join(registryDirectory, `${shardId}.json`);
    registries.set(
      shardId,
      parseTenantBootstrapShardRegistry(
        await readFile(registryPath, "utf8"),
        shardId,
        caPath,
      ),
    );
  }

  const pools = new Map<string, Pool>();
  const poolFor = (owner: Owner, placement: TenantBootstrapPlacement): Pool => {
    const registry = registries.get(placement.shardId);
    if (
      !registry ||
      !sameUuid(registry.shardIncarnation, placement.shardIncarnation)
    )
      throw new Error(
        `tenant bootstrap registry incarnation mismatch for ${placement.shardId}`,
      );
    const key = `${placement.shardId}/${owner}`;
    let pool = pools.get(key);
    if (!pool) {
      const connectionString = registry.owners[owner].url;
      const url = new URL(connectionString);
      // The original registry has already been checked for strict TLS. Remove
      // libpq-style SSL parameters so node-postgres cannot override this explicit
      // CA bundle with a less strict parser mode.
      url.searchParams.delete("sslmode");
      url.searchParams.delete("sslrootcert");
      const config: PoolConfig = {
        connectionString: url.toString(),
        max: 1,
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 10_000,
        statement_timeout: 5_000,
        query_timeout: 7_000,
        ssl: { rejectUnauthorized: true, ca: readFileSync(caPath) },
        onConnect: async (client) => {
          await client.query("SET ROLE tenant_ownership_bootstrap");
          const [identity] = (
            await client.query<{
              session_user: string;
              current_user: string;
              current_database: string;
            }>("SELECT session_user,current_user,current_database()")
          ).rows;
          if (
            identity?.session_user !==
              `tenant_bootstrap_${placement.shardId}` ||
            identity.current_user !== "tenant_ownership_bootstrap" ||
            identity.current_database !== OWNER_DATABASES[owner]
          )
            throw new Error(
              `tenant bootstrap connection identity mismatch for ${owner}/${placement.shardId}`,
            );
        },
      };
      pool = new Pool(config);
      pool.on("error", (error) => {
        console.error(
          JSON.stringify({
            event: "tenant_bootstrap_owner_pool_error",
            owner,
            shardId: placement.shardId,
            error: error.name,
          }),
        );
      });
      pools.set(key, pool);
    }
    return pool;
  };

  const adapters = SHARDED_MOVE_OWNERS.map(
    (owner): TenantBootstrapRuntimeAdapter => ({
      owner,
      async probeReadiness(placement) {
        const pool = poolFor(owner, placement);
        const [identity] = (
          await pool.query<
            QueryResultRow & {
              current_database: string;
              session_user: string;
              current_user: string;
              contract_version: string;
            }
          >(`SELECT current_database(),session_user,current_user,
          greenguard_internal.tenant_ownership_bootstrap_contract_version() AS contract_version`)
        ).rows;
        if (
          identity?.current_database !== OWNER_DATABASES[owner] ||
          identity.session_user !== `tenant_bootstrap_${placement.shardId}` ||
          identity.current_user !== "tenant_ownership_bootstrap" ||
          identity.contract_version !==
            TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION
        )
          throw new Error(
            `tenant bootstrap readiness mismatch for ${owner}/${placement.shardId}`,
          );
        const ownerManifest = manifest.owners[owner];
        await verifyTenantBootstrapMigrationLedger(pool, ownerManifest);
        return {
          owner,
          shardId: placement.shardId,
          shardIncarnation: placement.shardIncarnation,
          status: "ready",
          ownershipContractVersion: identity.contract_version,
          serviceMigrationFingerprint: ownerManifest.fingerprint,
        } satisfies TenantBootstrapOwnerReadiness;
      },
      async prepareTenantOwnership(placement) {
        await poolFor(owner, placement).query(
          "SELECT greenguard_internal.prepare_tenant_ownership($1::uuid,$2::text,$3::uuid,$4::bigint)",
          [
            placement.tenantId,
            placement.shardId,
            placement.shardIncarnation,
            placement.placementEpoch,
          ],
        );
      },
      async verifyTenantOwnership(placement, phase = "prepared") {
        const [row] = (
          await poolFor(owner, placement).query<
            QueryResultRow & {
              receipt_version: string;
              tenant_id: string;
              shard_id: string;
              shard_incarnation: string;
              placement_epoch: string;
              state: string;
              observed_at: Date | string;
            }
          >(
            `SELECT * FROM greenguard_internal.get_tenant_ownership_bootstrap_receipt(
          $1::uuid,$2::text,$3::uuid,$4::bigint)`,
            [
              placement.tenantId,
              placement.shardId,
              placement.shardIncarnation,
              placement.placementEpoch,
            ],
          )
        ).rows;
        const observed =
          row?.observed_at instanceof Date
            ? row.observed_at.toISOString()
            : typeof row?.observed_at === "string"
              ? new Date(row.observed_at).toISOString()
              : "";
        if (
          !row ||
          row.receipt_version !== TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION ||
          !sameUuid(row.tenant_id, placement.tenantId) ||
          row.shard_id !== placement.shardId ||
          !sameUuid(row.shard_incarnation, placement.shardIncarnation) ||
          String(row.placement_epoch) !== placement.placementEpoch ||
          row.state !== phase ||
          !Number.isFinite(Date.parse(observed))
        )
          throw new Error(
            `tenant bootstrap ${phase} receipt mismatch for ${owner}`,
          );
        return {
          owner,
          ...placement,
          receiptVersion: TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION,
          observedAt: observed,
          state: phase,
        } satisfies TenantBootstrapOwnerProof;
      },
      async activateTenantOwnership(placement) {
        await poolFor(owner, placement).query(
          "SELECT greenguard_internal.activate_tenant_ownership($1::uuid,$2::text,$3::uuid,$4::bigint)",
          [
            placement.tenantId,
            placement.shardId,
            placement.shardIncarnation,
            placement.placementEpoch,
          ],
        );
      },
    }),
  );

  return {
    adapters,
    async close() {
      await Promise.all([...pools.values()].map((pool) => pool.end()));
      pools.clear();
    },
  };
}

export async function verifyTenantBootstrapMigrationLedger(
  pool: Pick<Pool, "query">,
  contract: TenantBootstrapOwnerMigrationManifest,
): Promise<void> {
  const expected = new Map(
    contract.migrations.map(({ version, sha256 }) => [version, sha256]),
  );
  if (expected.size !== contract.migrations.length)
    throw new Error(
      "duplicate migration versions in tenant bootstrap manifest",
    );
  if (contract.ledger === "golang-migrate") {
    const rows = (
      await pool.query<{ version: string; dirty: boolean }>(
        "SELECT version::text,dirty FROM public.schema_migrations",
      )
    ).rows;
    if (
      rows.length !== 1 ||
      rows[0]?.dirty !== false ||
      BigInt(rows[0]?.version ?? "-1") !== BigInt(contract.headVersion)
    )
      throw new Error(
        `service migration ledger is not at the reviewed head for ${contract.database}`,
      );
    return;
  }
  if (contract.ledger === "sha256") {
    const rows = (
      await pool.query<{ version: string; sha256: string }>(
        "SELECT version,sha256 FROM public.schema_migrations ORDER BY version",
      )
    ).rows;
    if (
      rows.length !== expected.size ||
      rows.some((row) => expected.get(row.version) !== row.sha256)
    )
      throw new Error(
        `service migration checksum ledger does not match repository for ${contract.database}`,
      );
    return;
  }
  if (contract.ledger === "version-list") {
    const rows = (
      await pool.query<{ version: string }>(
        "SELECT version FROM public.schema_migrations ORDER BY version",
      )
    ).rows;
    if (
      rows.length !== expected.size ||
      rows.some((row) => !expected.has(row.version))
    )
      throw new Error(
        `service migration version ledger does not match repository for ${contract.database}`,
      );
    return;
  }
  const rows = (
    await pool.query<{
      migration_name: string;
      checksum: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>(`SELECT migration_name,checksum,finished_at,rolled_back_at
        FROM public._prisma_migrations ORDER BY migration_name,started_at`)
  ).rows;
  const applied = new Map<string, string>();
  for (const row of rows) {
    if (row.finished_at && !row.rolled_back_at) {
      if (applied.has(row.migration_name))
        throw new Error(
          `duplicate successful migration ledger entry for ${contract.database}`,
        );
      applied.set(row.migration_name, row.checksum);
    } else if (!row.rolled_back_at) {
      throw new Error(`unfinished Prisma migration in ${contract.database}`);
    }
  }
  if (
    applied.size !== expected.size ||
    [...expected].some(
      ([version, checksum]) => applied.get(version) !== checksum,
    )
  )
    throw new Error(
      `Prisma migration ledger does not match repository for ${contract.database}`,
    );
}
