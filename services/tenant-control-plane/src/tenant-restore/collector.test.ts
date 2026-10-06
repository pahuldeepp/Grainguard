import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import type { Principal } from "@greenguard/tenant-auth";
import {
  collectRestoreEvidence,
  type StorageObservation,
  type RestoreEvidenceAdapters,
} from "./collector.js";
import { observeLocalInventory } from "./postgres-collector.js";
import { INVENTORY_RESTORE_TABLES } from "./preflight.js";
const tenant = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  sha = "a".repeat(64),
  now = Date.parse("2026-10-04T12:00:00.000Z");
const principal: Principal = {
  tenantId: tenant,
  issuer: "https://issuer.test",
  subject: "private-subject",
  roles: ["admin"],
  expiresAt: new Date(now + 10000),
};
const route = {
  tenantId: tenant,
  shardId: "s1",
  shardIncarnation: other,
  placementEpoch: "1",
  state: "active" as const,
  expiresAt: new Date(now + 1000).toISOString(),
};
function stores(): StorageObservation[] {
  return (["legacy", "s1", "s2", "s3", "s4"] as const).map((label) => ({
    label,
    physicalShardId: label === "legacy" ? null : label,
    physicalIncarnation: null,
    ownership:
      label === "legacy"
        ? { shardId: "s1", incarnation: tenant, epoch: "1", state: "active" }
        : null,
    schemaSha256: sha,
    migrationChecksumsVerified: true,
    forceRlsVerified: true,
    tables: INVENTORY_RESTORE_TABLES.map((name) => ({
      name,
      rowCount: label === "legacy" ? "1" : "0",
      sha256: sha,
    })),
    snapshotSha256: sha,
    pendingSagaRows: "0",
  }));
}
function adapters(): RestoreEvidenceAdapters {
  return {
    membershipSource: "control-plane",
    verifyFresh: async () => structuredClone(principal),
    resolveAuthority: async (t) => {
      assert.equal(t, tenant);
      return structuredClone(route);
    },
    readStorage: async (t) => {
      assert.equal(t, tenant);
      return stores();
    },
    now: () => now,
  };
}
test("actual missing canonical target is blocked; metadata never includes human/tenant/physical identities", async () => {
  const result = await collectRestoreEvidence(adapters());
  assert.equal(result.freshControlPlaneMembershipVerified, true);
  assert.equal(result.authorityStable, true);
  assert.equal(result.executionAllowed, false);
  assert.ok(result.blockers.includes("missing_canonical_target"));
  assert.ok(result.unmeasured.includes("kafka_cdc_frontier"));
  assert.ok(!JSON.stringify(result).includes(tenant));
  assert.ok(!JSON.stringify(result).includes("private-subject"));
  assert.match(result.manifestSha256!, /^[a-f0-9]{64}$/);
});
test("fresh control identity change or revocation discards collected evidence", async () => {
  for (const scenario of ["foreign", "revoked"]) {
    const a = adapters();
    let calls = 0;
    a.verifyFresh = async () => {
      calls++;
      if (calls === 2 && scenario === "revoked")
        throw new Error("private error");
      return { ...principal, tenantId: calls === 2 ? other : tenant };
    };
    const result = await collectRestoreEvidence(a);
    assert.deepEqual(result.storage, []);
    assert.deepEqual(result.blockers, ["trusted_collection_failed"]);
    assert.equal(result.freshControlPlaneMembershipVerified, false);
    assert.equal(calls, 2);
  }
});
test("file membership, service identities, expired humans and viewer reject before forensic reads", async () => {
  for (const invalid of [
    { ...principal, roles: ["viewer"] as Principal["roles"] },
    { ...principal, principalType: "service" as const },
    { ...principal, deviceId: other },
    { ...principal, expiresAt: new Date(now - 1) },
  ]) {
    const a = adapters();
    a.verifyFresh = async () => invalid;
    let readCalled = false;
    a.readStorage = async () => {
      readCalled = true;
      throw new Error("must not read");
    };
    const result = await collectRestoreEvidence(a);
    assert.equal(result.storage.length, 0);
    assert.equal(readCalled, false);
    assert.ok(result.blockers.includes("trusted_collection_failed"));
  }
  const a = adapters();
  Object.assign(a, { membershipSource: "file" });
  let calls = 0;
  a.verifyFresh = async () => {
    calls++;
    return principal;
  };
  await collectRestoreEvidence(a);
  assert.equal(calls, 0);
});
test("changed authority, unverified RLS/migrations and malformed inventory cannot imply recovery", async () => {
  const a = adapters();
  let calls = 0;
  a.resolveAuthority = async () => ({
    ...route,
    placementEpoch: ++calls === 2 ? "2" : "1",
  });
  assert.deepEqual((await collectRestoreEvidence(a)).blockers, [
    "stale_or_changed_authority",
  ]);
  const b = adapters();
  b.readStorage = async () => {
    const s = stores();
    s[0]!.forceRlsVerified = false;
    return s;
  };
  assert.ok(
    (await collectRestoreEvidence(b)).blockers.includes(
      "owner_schema_not_verified",
    ),
  );
  const c = adapters();
  c.readStorage = async () => stores().slice(1);
  assert.deepEqual((await collectRestoreEvidence(c)).storage, []);
});
test("even canonical target proof leaves unmeasured fencing/backup/frontier and execution disabled", async () => {
  const a = adapters();
  a.readStorage = async () => {
    const s = stores();
    s[1]!.physicalIncarnation = other;
    return s;
  };
  const result = await collectRestoreEvidence(a);
  assert.equal(result.storage[1]!.canonicalTarget, true);
  assert.equal(result.status, "blocked");
  assert.equal(result.executionAllowed, false);
  assert.deepEqual(result.blockers, ["restore_prerequisites_unmeasured"]);
});
test("PostgreSQL adapter executes read-only transactions and explicit verified tenant predicates; never exposes raw rows", async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let released = 0;
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("FROM pg_class"))
        return {
          rows: INVENTORY_RESTORE_TABLES.map((name) => ({
            name,
            enabled: true,
            forced: true,
            column: "tenant_id",
            type: "uuid",
          })),
        };
      if (sql.includes("FROM greenguard_internal.tenant_ownership"))
        return {
          rows: [
            { shard_id: "s1", incarnation: other, epoch: "1", state: "active" },
          ],
        };
      if (sql.includes("sum(octet_length"))
        return {
          rows: [
            {
              count: sql.includes('"devices"') ? "1" : "0",
              bytes: sql.includes('"devices"') ? "100" : "0",
            },
          ],
        };
      if (sql.includes("row_to_json"))
        return {
          rows: sql.includes('"devices"')
            ? [
                {
                  body: '{"tenant_id":"' + tenant + '","secret":"private-row"}',
                },
              ]
            : [],
        };
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("_prisma_migrations"))
        return {
          rows: [
            {
              migration_name: "one",
              checksum: sha,
              finished: true,
              rolled_back: false,
            },
          ],
        };
      return { rows: [] };
    },
    release: () => released++,
  };
  const pool = { connect: async () => db } as unknown as Pool;
  const result = await observeLocalInventory(
    {
      label: "legacy",
      inventory: pool,
      physical: null,
      composeProject: "greenguard-sharding-proof",
      expectedMigrations: [{ name: "one", sha256: sha }],
    },
    tenant,
  );
  assert.equal(result.tables.find((t) => t.name === "devices")!.rowCount, "1");
  assert.equal(result.migrationChecksumsVerified, true);
  assert.equal(result.forceRlsVerified, true);
  assert.ok(!JSON.stringify(result).includes("private-row"));
  assert.equal(released, 1);
  assert.match(calls[0]!.sql, /READ ONLY/);
  for (const call of calls) {
    assert.ok(
      !/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER)\b/.test(call.sql),
    );
    if (
      /row_to_json|tenant_ownership WHERE|published_at IS NULL/.test(call.sql)
    ) {
      assert.match(call.sql, /tenant_id=\$1/);
      assert.deepEqual(call.values, [tenant]);
    }
  }
});

test("oversized table is rejected before any row body crosses the adapter boundary", async () => {
  let rowBodiesFetched = false,
    released = false;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("FROM pg_class"))
        return {
          rows: INVENTORY_RESTORE_TABLES.map((name) => ({
            name,
            enabled: true,
            forced: true,
            column: "tenant_id",
            type: "uuid",
          })),
        };
      if (sql.includes("sum(octet_length"))
        return { rows: [{ count: "5001", bytes: "1" }] };
      if (sql.includes("AS body")) rowBodiesFetched = true;
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  await assert.rejects(
    () =>
      observeLocalInventory(
        {
          label: "legacy",
          inventory: { connect: async () => client } as unknown as Pool,
          physical: null,
          composeProject: "greenguard-sharding-proof",
          expectedMigrations: [],
        },
        tenant,
      ),
    /bounded snapshot exceeded/,
  );
  assert.equal(rowBodiesFetched, false);
  assert.equal(released, true);
});
