import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  requireCompleteBootstrapAdapters,
  requireCompleteBootstrapProofs,
  requireReadyShardOwners,
  TenantBootstrapPreflightError,
  type TenantBootstrapOwnerAdapter,
  type TenantBootstrapOwnerProof,
  type TenantBootstrapOwnerReadiness,
  type TenantBootstrapPlacement,
} from "./preflight.js";

const placement: TenantBootstrapPlacement = {
  tenantId: "f0123456-0000-4000-8000-000000000001",
  shardId: "s2",
  shardIncarnation: "f1123456-0000-4000-8000-000000000002",
  placementEpoch: "1",
};
const hash = "a".repeat(64);
const adapters = (called: () => void = () => {}) =>
  SHARDED_MOVE_OWNERS.map((owner): TenantBootstrapOwnerAdapter => ({
    owner,
    prepareTenantOwnership: async () => called(),
    verifyTenantOwnership: async () => called(),
    activateTenantOwnership: async () => called(),
  }));
const readiness = (): TenantBootstrapOwnerReadiness[] =>
  SHARDED_MOVE_OWNERS.map((owner) => ({
    owner,
    shardId: placement.shardId,
    shardIncarnation: placement.shardIncarnation,
    status: "ready",
    migrationVersion: hash,
  }));
const proofs = (phase: "prepared" | "active" = "prepared") =>
  SHARDED_MOVE_OWNERS.map((owner): TenantBootstrapOwnerProof => ({
    ...placement,
    owner,
    phase,
    state: phase,
    verified: true,
  }));

function rejectsPreflight(action: () => unknown) {
  assert.throws(action, TenantBootstrapPreflightError);
}

test("bootstrap preflight requires all nine unique provisioning adapters without invoking them", () => {
  let calls = 0;
  const complete = adapters(() => calls++);
  const indexed = requireCompleteBootstrapAdapters(complete);
  assert.equal(indexed.size, SHARDED_MOVE_OWNERS.length);
  assert.deepEqual([...indexed.keys()].sort(), [...SHARDED_MOVE_OWNERS].sort());
  assert.equal(calls, 0);

  rejectsPreflight(() => requireCompleteBootstrapAdapters(complete.slice(1)));
  rejectsPreflight(() =>
    requireCompleteBootstrapAdapters([...complete.slice(0, -1), complete[0]!]),
  );
  rejectsPreflight(() =>
    requireCompleteBootstrapAdapters([
      ...complete.slice(1),
      {
        ...complete[0]!,
        owner: "unknown",
      } as unknown as TenantBootstrapOwnerAdapter,
    ]),
  );
  rejectsPreflight(() =>
    requireCompleteBootstrapAdapters([
      ...complete.slice(1),
      { owner: complete[0]!.owner } as TenantBootstrapOwnerAdapter,
    ]),
  );
  assert.equal(calls, 0);
});

test("a target shard is ready only when every owner proves matching identity and migration", () => {
  requireReadyShardOwners(placement, readiness());

  rejectsPreflight(() =>
    requireReadyShardOwners(placement, readiness().slice(1)),
  );
  rejectsPreflight(() =>
    requireReadyShardOwners(
      { ...placement, tenantId: "not-a-uuid" },
      readiness(),
    ),
  );
  rejectsPreflight(() =>
    requireReadyShardOwners(
      { ...placement, placementEpoch: "9223372036854775808" },
      readiness(),
    ),
  );
  rejectsPreflight(() =>
    requireReadyShardOwners(placement, [
      ...readiness().slice(1),
      {
        ...readiness()[0]!,
        status: "offline",
      } as unknown as TenantBootstrapOwnerReadiness,
    ]),
  );
  rejectsPreflight(() =>
    requireReadyShardOwners(placement, [
      ...readiness().slice(1),
      {
        ...readiness()[0]!,
        shardIncarnation: "f2123456-0000-4000-8000-000000000002",
      },
    ]),
  );
  rejectsPreflight(() =>
    requireReadyShardOwners(placement, [
      ...readiness().slice(1),
      { ...readiness()[0]!, migrationVersion: "unverified" },
    ]),
  );
});

test("placement activation proof gate requires exact positive owner read-backs", () => {
  requireCompleteBootstrapProofs(placement, "prepared", proofs());
  requireCompleteBootstrapProofs(placement, "active", proofs("active"));

  rejectsPreflight(() =>
    requireCompleteBootstrapProofs(placement, "prepared", proofs().slice(1)),
  );
  rejectsPreflight(() =>
    requireCompleteBootstrapProofs(placement, "prepared", [
      ...proofs().slice(1),
      { ...proofs()[0]!, placementEpoch: "2" },
    ]),
  );
  rejectsPreflight(() =>
    requireCompleteBootstrapProofs(placement, "prepared", [
      ...proofs().slice(1),
      {
        ...proofs()[0]!,
        verified: false,
      } as unknown as TenantBootstrapOwnerProof,
    ]),
  );
  rejectsPreflight(() =>
    requireCompleteBootstrapProofs(placement, "active", proofs()),
  );
  rejectsPreflight(() =>
    requireCompleteBootstrapProofs(
      { ...placement, placementEpoch: "0" },
      "prepared",
      proofs(),
    ),
  );
});
