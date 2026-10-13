import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { Pool } from "pg";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  parseTenantBootstrapShardRegistry,
  createRepositoryTenantBootstrapAdapters,
  verifyTenantBootstrapMigrationLedger,
  type TenantBootstrapOwnerMigrationManifest,
} from "./repository-adapters.js";

type RegistryFixture = {
  version: number;
  shardId: string;
  shardIncarnation: string;
  caCertPath: string;
  owners: Record<(typeof SHARDED_MOVE_OWNERS)[number], { url: string }>;
  TENANT_BOOTSTRAP_PASSWORD?: string;
};

const caPath = "/tmp/tenant-bootstrap-tests/ca.pem";
const databases = {
  telemetry: "greenguard_telemetry",
  projection: "greenguard_read",
  jobs: "greenguard_jobs",
  saga: "greenguard_sagas",
  hardware: "greenguard_hardware",
  inventory: "greenguard_inventory",
  alerts: "greenguard_alerts",
  risk: "greenguard_risk",
  notifications: "greenguard_notifications",
} as const;

function registry(shardId = "s2") {
  return JSON.stringify({
    version: 1,
    shardId,
    shardIncarnation: "f1123456-0000-4000-8000-000000000002",
    caCertPath: caPath,
    owners: Object.fromEntries(
      SHARDED_MOVE_OWNERS.map((owner) => [
        owner,
        {
          url: `postgresql://tenant_bootstrap_${shardId}:secret%3Avalue@rds.example:5432/${databases[owner]}?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`,
        },
      ]),
    ),
  });
}

test("shard registry accepts only the exact shard owner DB, login, and verified TLS contract", () => {
  const parsed = parseTenantBootstrapShardRegistry(registry(), "s2", caPath);
  assert.equal(parsed.shardId, "s2");
  assert.equal(Object.keys(parsed.owners).length, 9);
  for (const owner of SHARDED_MOVE_OWNERS) {
    const url = new URL(parsed.owners[owner].url);
    assert.equal(url.username, "tenant_bootstrap_s2");
    assert.equal(url.pathname, `/${databases[owner]}`);
    assert.equal(url.searchParams.get("sslmode"), "verify-full");
  }
});

test("shard registry rejects wrong owner DB, role override, TLS mode, and extra secret fields", () => {
  const wrongDatabase = JSON.parse(registry()) as RegistryFixture;
  wrongDatabase.owners.inventory.url =
    wrongDatabase.owners.inventory.url.replace(
      "greenguard_inventory",
      "greenguard_read",
    );
  assert.throws(() =>
    parseTenantBootstrapShardRegistry(
      JSON.stringify(wrongDatabase),
      "s2",
      caPath,
    ),
  );

  const roleOverride = JSON.parse(registry()) as RegistryFixture;
  roleOverride.owners.risk.url += "&options=-c%20role%3Dcontrol_app";
  assert.throws(() =>
    parseTenantBootstrapShardRegistry(
      JSON.stringify(roleOverride),
      "s2",
      caPath,
    ),
  );

  const wrongTls = JSON.parse(registry()) as RegistryFixture;
  wrongTls.owners.jobs.url = wrongTls.owners.jobs.url.replace(
    "verify-full",
    "require",
  );
  assert.throws(() =>
    parseTenantBootstrapShardRegistry(JSON.stringify(wrongTls), "s2", caPath),
  );

  const extra = JSON.parse(registry()) as RegistryFixture;
  extra.TENANT_BOOTSTRAP_PASSWORD = "must-not-be-mounted";
  assert.throws(() =>
    parseTenantBootstrapShardRegistry(JSON.stringify(extra), "s2", caPath),
  );
});

test("repository adapter startup requires all four immutable shard registry files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tenant-bootstrap-registry-"));
  const caPath = join(directory, "ca.crt");
  const registryDirectory = join(directory, "registry");
  await mkdir(registryDirectory);
  await writeFile(caPath, "test certificate bytes");
  const manifestPath = new URL("./owner-migrations.json", import.meta.url);
  try {
    for (const shardId of ["s1", "s2", "s3", "s4"]) {
      const incarnation = `f1123456-0000-4000-8000-00000000000${Number(shardId[1])}`;
      const parsed = JSON.parse(registry(shardId)) as RegistryFixture;
      parsed.shardIncarnation = incarnation;
      parsed.caCertPath = caPath;
      for (const owner of SHARDED_MOVE_OWNERS) {
        const url = new URL(parsed.owners[owner].url);
        url.searchParams.set("sslrootcert", caPath);
        parsed.owners[owner].url = url.toString();
      }
      await writeFile(
        join(registryDirectory, `${shardId}.json`),
        JSON.stringify(parsed),
      );
    }
    const repository = await createRepositoryTenantBootstrapAdapters({
      registryDirectory,
      manifestPath,
      caPath,
    });
    assert.deepEqual(
      repository.adapters.map(({ owner }) => owner),
      [...SHARDED_MOVE_OWNERS],
    );
    await repository.close();
    await rm(join(registryDirectory, "s4.json"));
    await assert.rejects(
      createRepositoryTenantBootstrapAdapters({
        registryDirectory,
        manifestPath,
        caPath,
      }),
      /s4\.json/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function ownerManifest(): Promise<
  Record<string, TenantBootstrapOwnerMigrationManifest>
> {
  const manifestPath = new URL("./owner-migrations.json", import.meta.url);
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
    owners: Record<string, TenantBootstrapOwnerMigrationManifest>;
  };
  return parsed.owners;
}

test("repository ledger manifest covers all nine services and each ledger's real storage model", async () => {
  const manifests = await ownerManifest();
  assert.deepEqual(
    Object.keys(manifests).sort(),
    [...SHARDED_MOVE_OWNERS].sort(),
  );
  const kinds = new Set(Object.values(manifests).map((owner) => owner.ledger));
  assert.deepEqual(
    kinds,
    new Set(["golang-migrate", "prisma", "sha256", "version-list"]),
  );
  for (const owner of SHARDED_MOVE_OWNERS) {
    assert.equal(manifests[owner]!.migrations.length > 0, true);
    assert.match(manifests[owner]!.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(
      manifests[owner]!.headVersion,
      manifests[owner]!.migrations.at(-1)!.version,
    );
  }
});

test("migration ledger verification follows each service runner and rejects stale or dirty databases", async () => {
  const manifests = await ownerManifest();
  for (const owner of SHARDED_MOVE_OWNERS) {
    const manifest = manifests[owner]!;
    const rows =
      manifest.ledger === "golang-migrate"
        ? [{ version: String(BigInt(manifest.headVersion)), dirty: false }]
        : manifest.ledger === "sha256"
          ? manifest.migrations.map(({ version, sha256 }) => ({
              version,
              sha256,
            }))
          : manifest.ledger === "version-list"
            ? manifest.migrations.map(({ version }) => ({ version }))
            : manifest.migrations.map(({ version, sha256 }) => ({
                migration_name: version,
                checksum: sha256,
                finished_at: new Date(),
                rolled_back_at: null,
              }));
    const pool = {
      async query() {
        return { rows };
      },
    } as unknown as Pool;
    await verifyTenantBootstrapMigrationLedger(pool, manifest);
  }

  const goManifest = manifests.telemetry!;
  await assert.rejects(
    verifyTenantBootstrapMigrationLedger(
      {
        async query() {
          return {
            rows: [
              { version: String(BigInt(goManifest.headVersion)), dirty: true },
            ],
          };
        },
      } as unknown as Pool,
      goManifest,
    ),
    /not at the reviewed head/,
  );

  const riskManifest = manifests.risk!;
  await assert.rejects(
    verifyTenantBootstrapMigrationLedger(
      {
        async query() {
          return {
            rows: riskManifest.migrations.map(({ version, sha256 }, index) => ({
              version,
              sha256: index === 0 ? "0".repeat(64) : sha256,
            })),
          };
        },
      } as unknown as Pool,
      riskManifest,
    ),
    /checksum ledger does not match/,
  );

  const prismaManifest = manifests.inventory!;
  await assert.rejects(
    verifyTenantBootstrapMigrationLedger(
      {
        async query() {
          return {
            rows: prismaManifest.migrations.map(({ version, sha256 }) => ({
              migration_name: version,
              checksum: sha256,
              finished_at: null,
              rolled_back_at: null,
            })),
          };
        },
      } as unknown as Pool,
      prismaManifest,
    ),
    /unfinished Prisma migration/,
  );
});
