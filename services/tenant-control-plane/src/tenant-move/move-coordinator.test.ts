import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  preflightTenantMoveAdapters,
  TENANT_MOVE_BOUNDARIES,
  TenantMoveAdaptersUnavailableError,
  type TenantMoveOwnerAdapter,
} from "./move-coordinator.js";

const adapter = (
  owner: (typeof SHARDED_MOVE_OWNERS)[number],
  boundaries: readonly (typeof TENANT_MOVE_BOUNDARIES)[number][] = TENANT_MOVE_BOUNDARIES,
): TenantMoveOwnerAdapter => ({
  owner,
  boundaries: new Set(boundaries),
  ownerLocal: true,
});

test("missing all-owner adapters are rejected without invoking owner code", () => {
  let sideEffects = 0;
  const existingPartialAdapters = ["inventory", "risk", "telemetry"].map(
    (owner) => ({
      owner: owner as (typeof SHARDED_MOVE_OWNERS)[number],
      boundaries: new Set(TENANT_MOVE_BOUNDARIES),
      ownerLocal: true as const,
      quiesce: async () => sideEffects++,
      copy: async () => sideEffects++,
      activate: async () => sideEffects++,
    }),
  );

  assert.throws(
    () => preflightTenantMoveAdapters(existingPartialAdapters),
    (error) => {
      assert.ok(error instanceof TenantMoveAdaptersUnavailableError);
      assert.deepEqual([...error.missingOwners].sort(), [
        "alerts",
        "hardware",
        "jobs",
        "notifications",
        "projection",
        "saga",
      ]);
      return true;
    },
  );
  assert.equal(sideEffects, 0);
});

test("a nominal adapter set still fails if one owner lacks any safety boundary", () => {
  const candidates = SHARDED_MOVE_OWNERS.map((owner) => adapter(owner));
  candidates[candidates.findIndex((item) => item.owner === "risk")] = adapter(
    "risk",
    TENANT_MOVE_BOUNDARIES.filter(
      (boundary) => boundary !== "verify_replica_freshness",
    ),
  );

  assert.throws(
    () => preflightTenantMoveAdapters(candidates),
    (error) => {
      assert.ok(error instanceof TenantMoveAdaptersUnavailableError);
      assert.deepEqual(error.incomplete.risk, ["verify_replica_freshness"]);
      return true;
    },
  );
});

test("duplicate or unexpected owner adapters fail exact-roster validation", () => {
  const complete = SHARDED_MOVE_OWNERS.map((owner) => adapter(owner));
  assert.throws(
    () => preflightTenantMoveAdapters([...complete, adapter("risk")]),
    /risk missing boundaries: duplicate adapter registration/,
  );
  assert.throws(
    () =>
      preflightTenantMoveAdapters([
        ...complete,
        { owner: "legacy_primary" } as unknown as TenantMoveOwnerAdapter,
      ]),
    /legacy_primary missing boundaries: unexpected owner adapter/,
  );
});

test("malformed adapter boundary declarations fail closed instead of throwing a TypeError", () => {
  const complete = SHARDED_MOVE_OWNERS.map((owner) => adapter(owner));
  const index = complete.findIndex((item) => item.owner === "risk");
  complete[index] = {
    ...complete[index],
    boundaries: undefined,
  } as unknown as TenantMoveOwnerAdapter;
  assert.throws(
    () => preflightTenantMoveAdapters(complete),
    (error) => {
      assert.ok(error instanceof TenantMoveAdaptersUnavailableError);
      assert.deepEqual(error.incomplete.risk, [
        "adapter boundary declaration is invalid",
      ]);
      return true;
    },
  );
});

test("boundary declarations cannot spoof completeness with a duck-typed or overridden has method", () => {
  const fake = SHARDED_MOVE_OWNERS.map((owner) => adapter(owner));
  const riskIndex = fake.findIndex((item) => item.owner === "risk");
  fake[riskIndex] = {
    ...fake[riskIndex],
    boundaries: { has: () => true },
  } as unknown as TenantMoveOwnerAdapter;
  assert.throws(
    () => preflightTenantMoveAdapters(fake),
    /risk missing boundaries: adapter boundary declaration is invalid/,
  );

  const overridden = SHARDED_MOVE_OWNERS.map((owner) => adapter(owner));
  const telemetryIndex = overridden.findIndex(
    (item) => item.owner === "telemetry",
  );
  const incomplete = new Set(
    TENANT_MOVE_BOUNDARIES.filter(
      (boundary) => boundary !== "verify_replica_freshness",
    ),
  );
  incomplete.has = (() => true) as typeof incomplete.has;
  overridden[telemetryIndex] = {
    ...overridden[telemetryIndex],
    boundaries: incomplete,
  };
  assert.throws(
    () => preflightTenantMoveAdapters(overridden),
    /telemetry missing boundaries: verify_replica_freshness/,
  );
});

test("complete owner-local adapters pass the pure preflight without running work", () => {
  const complete = SHARDED_MOVE_OWNERS.map((owner) => adapter(owner));
  const result = preflightTenantMoveAdapters(complete);
  assert.deepEqual(
    [...result.adapters.keys()].sort(),
    [...SHARDED_MOVE_OWNERS].sort(),
  );
  assert.equal(result.adapters.size, SHARDED_MOVE_OWNERS.length);
});
