import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db } from "../db/client.js";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  TENANT_BOOTSTRAP_OWNER_CONTRACTS,
  type TenantBootstrapOwnerProof,
  type TenantBootstrapOwnerReadiness,
  type TenantBootstrapPlacement,
} from "./preflight.js";
import {
  executeTenantBootstrap,
  processNextTenantBootstrap,
  type TenantBootstrapRuntimeAdapter,
} from "./run.js";

const placement: TenantBootstrapPlacement = {
  tenantId: "f0123456-0000-4000-8000-000000000001",
  shardId: "s2",
  shardIncarnation: "f1123456-0000-4000-8000-000000000002",
  placementEpoch: "1",
};

function adapters(events: string[], options: { badProofOwner?: string } = {}) {
  const readiness: TenantBootstrapOwnerReadiness[] = [];
  const result: TenantBootstrapRuntimeAdapter[] = SHARDED_MOVE_OWNERS.map(
    (owner) => {
      const record = (
        phase: "prepared" | "active",
      ): TenantBootstrapOwnerProof => ({
        ...placement,
        owner,
        receiptVersion:
          TENANT_BOOTSTRAP_OWNER_CONTRACTS[owner].ownershipContractVersion,
        observedAt: "2026-09-29T00:00:00.000Z",
        state: owner === options.badProofOwner ? "prepared" : phase,
      });
      return {
        owner,
        async probeReadiness() {
          events.push(`ready:${owner}`);
          const proof = {
            owner,
            shardId: placement.shardId,
            shardIncarnation: placement.shardIncarnation,
            status: "ready" as const,
            ownershipContractVersion:
              TENANT_BOOTSTRAP_OWNER_CONTRACTS[owner].ownershipContractVersion,
            serviceMigrationFingerprint: "a".repeat(64),
          };
          readiness.push(proof);
          return proof;
        },
        async prepareTenantOwnership() {
          events.push(`prepare:${owner}`);
        },
        async verifyTenantOwnership(_placement, requestedPhase = "prepared") {
          const phase = events.includes(`activate:${owner}`)
            ? "active"
            : requestedPhase;
          events.push(`read:${owner}:${phase}`);
          return record(phase);
        },
        async activateTenantOwnership() {
          events.push(`activate:${owner}`);
        },
      };
    },
  );
  return { adapters: result, readiness };
}

test("test-injected owner adapters execute both phases and commit only after exact proofs", async () => {
  const events: string[] = [];
  const { adapters: ownerAdapters } = adapters(events);
  const persisted: string[] = [];
  let activated = false;

  await executeTenantBootstrap(placement, ownerAdapters, {
    async persistProofs(phase, proofs) {
      events.push(`persist:${phase}`);
      persisted.push(phase);
      assert.equal(proofs.length, SHARDED_MOVE_OWNERS.length);
    },
    async activateControlPlane() {
      events.push("control-plane-activate");
      activated = true;
    },
  });

  assert.deepEqual(persisted, ["prepared", "active"]);
  assert.equal(activated, true);
  assert.ok(
    events.indexOf("persist:prepared") < events.indexOf("persist:active"),
  );
  assert.ok(
    events.indexOf("persist:active") < events.indexOf("control-plane-activate"),
  );
});

test("an invalid active owner readback prevents proof persistence and control-plane activation", async () => {
  const events: string[] = [];
  const { adapters: ownerAdapters } = adapters(events, {
    badProofOwner: "risk",
  });
  let activated = false;
  const persisted: string[] = [];

  await assert.rejects(
    executeTenantBootstrap(placement, ownerAdapters, {
      async persistProofs(phase) {
        persisted.push(phase);
      },
      async activateControlPlane() {
        activated = true;
      },
    }),
    /read-back proof does not match/,
  );
  assert.deepEqual(persisted, ["prepared"]);
  assert.equal(activated, false);
});

test("retry with durable prepared proofs skips non-idempotent prepare state and resumes activation", async () => {
  const events: string[] = [];
  const { adapters: ownerAdapters } = adapters(events);
  const prepared = SHARDED_MOVE_OWNERS.map(
    (owner): TenantBootstrapOwnerProof => ({
      ...placement,
      owner,
      receiptVersion:
        TENANT_BOOTSTRAP_OWNER_CONTRACTS[owner].ownershipContractVersion,
      observedAt: "2026-09-29T00:00:00.000Z",
      state: "prepared",
    }),
  );
  const persisted: string[] = [];
  let activated = false;
  await executeTenantBootstrap(
    placement,
    ownerAdapters,
    {
      async persistProofs(phase) {
        persisted.push(phase);
      },
      async activateControlPlane() {
        activated = true;
      },
    },
    { preparedProofs: prepared },
  );
  assert.equal(
    events.some((event) => event.startsWith("prepare:")),
    false,
  );
  assert.equal(
    events.filter((event) => event.startsWith("activate:")).length,
    SHARDED_MOVE_OWNERS.length,
  );
  assert.deepEqual(persisted, ["active"]);
  assert.equal(activated, true);
});

test("retry with durable active receipts rereads all owners before finalizing without repeating activation", async () => {
  const events: string[] = [];
  const { adapters: ownerAdapters } = adapters(events);
  const proofs = (state: "prepared" | "active") =>
    SHARDED_MOVE_OWNERS.map((owner): TenantBootstrapOwnerProof => ({
      ...placement,
      owner,
      receiptVersion:
        TENANT_BOOTSTRAP_OWNER_CONTRACTS[owner].ownershipContractVersion,
      observedAt: "2026-09-29T00:00:00.000Z",
      state,
    }));
  let activated = false;
  const persisted: string[] = [];
  await executeTenantBootstrap(
    placement,
    ownerAdapters,
    {
      async persistProofs(phase) {
        persisted.push(phase);
      },
      async activateControlPlane() {
        activated = true;
      },
    },
    { preparedProofs: proofs("prepared"), activeProofs: proofs("active") },
  );
  assert.equal(
    events.some(
      (event) => event.startsWith("prepare:") || event.startsWith("activate:"),
    ),
    false,
  );
  assert.equal(
    events.filter((event) => event.startsWith("read:")).length,
    SHARDED_MOVE_OWNERS.length,
  );
  assert.deepEqual(persisted, ["active"]);
  assert.equal(activated, true);
});

test("the unconfigured polling entry point requeues instead of trusting arbitrary adapters", async () => {
  const job = {
    tenantId: placement.tenantId,
    jobId: "a0123456-0000-4000-8000-000000000001",
    operationId: "a1123456-0000-4000-8000-000000000001",
    requestedAdminIdentityId: "a2123456-0000-4000-8000-000000000001",
    correlationId: "a3123456-0000-4000-8000-000000000001",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    shardId: placement.shardId,
    shardIncarnation: placement.shardIncarnation,
    placementEpoch: placement.placementEpoch,
    attempts: 1,
    claimToken: "a4123456-0000-4000-8000-000000000001",
    leaseUntil: new Date("2026-09-29T00:01:30.000Z"),
    preparedReceipts: [],
    activeReceipts: [],
  };
  const statements: string[] = [];
  const db = {
    async $queryRaw(strings: TemplateStringsArray) {
      const query = strings.join("?");
      statements.push(query);
      if (query.includes("FROM claim_tenant_bootstrap_job")) return [job];
      if (query.includes("retry_tenant_bootstrap_job"))
        return [{ state: "retry_wait" }];
      throw new Error("unexpected database call");
    },
  } as unknown as Db;

  assert.equal(await processNextTenantBootstrap(db), true);
  assert.equal(statements.length, 2);
  assert.ok(statements[1]!.includes("retry_tenant_bootstrap_job"));
  assert.ok(!statements.some((statement) => statement.includes("activate")));
});
