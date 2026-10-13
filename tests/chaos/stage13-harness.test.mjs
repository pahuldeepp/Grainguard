import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCleanupOwnership,
  validateWorkload,
} from "../../scripts/stage13-harness.mjs";

const valid = {
  environment: "local",
  execution: "validate-only",
  runId: "offline-example-01",
  durationSeconds: 30,
  offeredRps: 5,
  journeys: ["read-freshness"],
  cleanupOwner: "greenguard-stage13-offline-example-01",
};

test("workload validation rejects an absent environment", () => {
  assert.throws(() => validateWorkload(valid, undefined), /local-only/);
});

test("workload validation rejects AWS or other non-local environments", () => {
  assert.throws(() => validateWorkload(valid, "aws"), /local-only/);
  assert.throws(
    () => validateWorkload({ ...valid, environment: "aws" }, "local"),
    /manifest environment/,
  );
});

test("workload validation enforces bounded validate-only manifest and disclaims certification", () => {
  const result = validateWorkload(valid, "local");
  assert.equal(result.harnessResult, "validated-offline-only");
  assert.equal(result.certification, false);
  assert.throws(
    () => validateWorkload({ ...valid, execution: "run" }, "local"),
    /cannot run workload or faults/,
  );
  assert.throws(
    () => validateWorkload({ ...valid, offeredRps: 26 }, "local"),
    /offeredRps/,
  );
  assert.throws(
    () => validateWorkload({ ...valid, durationSeconds: 301 }, "local"),
    /durationSeconds/,
  );
});

test("cleanup guard accepts only resources tagged to the exact local run", () => {
  assert.equal(
    assertCleanupOwnership({
      environment: "local",
      runId: valid.runId,
      cleanupOwner: valid.cleanupOwner,
      resources: [
        { name: `${valid.cleanupOwner}-postgres`, owner: valid.cleanupOwner },
      ],
    }),
    true,
  );
  assert.throws(
    () =>
      assertCleanupOwnership({
        environment: "local",
        runId: valid.runId,
        cleanupOwner: valid.cleanupOwner,
        resources: [{ name: "production-postgres", owner: "production" }],
      }),
    /rejected a resource/,
  );
});

test("cleanup guard rejects missing or non-local environment before resource checks", () => {
  const request = {
    runId: valid.runId,
    cleanupOwner: valid.cleanupOwner,
    resources: [],
  };
  assert.throws(
    () => assertCleanupOwnership({ ...request, environment: undefined }),
    /local-only/,
  );
  assert.throws(
    () => assertCleanupOwnership({ ...request, environment: "aws" }),
    /local-only/,
  );
});
