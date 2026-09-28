#!/usr/bin/env node
// Offline-only Stage 13 workload and ownership guard. This validates metadata;
// it deliberately does not generate traffic, execute faults, or clean resources.

import { readFile } from "node:fs/promises";

export const MAX_DURATION_SECONDS = 300;
export const MAX_OFFERED_RPS = 25;
const RUN_ID = /^[a-z0-9][a-z0-9-]{2,47}$/;

export function assertLocalEnvironment(environment) {
  if (environment !== "local") {
    throw new Error(
      "Stage 13 harness validation is local-only; environment must be 'local'",
    );
  }
}

export function validateWorkload(manifest, environment) {
  assertLocalEnvironment(environment);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("workload manifest must be a JSON object");
  }
  if (manifest.environment !== "local") {
    throw new Error("manifest environment must be 'local'");
  }
  if (manifest.execution !== "validate-only") {
    throw new Error(
      "execution must be 'validate-only'; this harness cannot run workload or faults",
    );
  }
  if (typeof manifest.runId !== "string" || !RUN_ID.test(manifest.runId)) {
    throw new Error(
      "runId must be a lowercase alphanumeric/hyphen identifier (3-48 chars)",
    );
  }
  if (
    !Number.isInteger(manifest.durationSeconds) ||
    manifest.durationSeconds < 1 ||
    manifest.durationSeconds > MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `durationSeconds must be an integer from 1 to ${MAX_DURATION_SECONDS}`,
    );
  }
  if (
    !Number.isInteger(manifest.offeredRps) ||
    manifest.offeredRps < 1 ||
    manifest.offeredRps > MAX_OFFERED_RPS
  ) {
    throw new Error(
      `offeredRps must be an integer from 1 to ${MAX_OFFERED_RPS}`,
    );
  }
  if (
    !Array.isArray(manifest.journeys) ||
    manifest.journeys.length === 0 ||
    manifest.journeys.some(
      (journey) => typeof journey !== "string" || !journey.trim(),
    )
  ) {
    throw new Error("journeys must be a non-empty array of named journeys");
  }
  if (
    typeof manifest.cleanupOwner !== "string" ||
    manifest.cleanupOwner !== `greenguard-stage13-${manifest.runId}`
  ) {
    throw new Error(
      "cleanupOwner must exactly match the run-scoped Stage 13 owner name",
    );
  }
  return {
    ...manifest,
    harnessResult: "validated-offline-only",
    certification: false,
  };
}

// This is a dry guard only. Any future cleanup implementation must call this
// before touching resources, and must still verify ownership at the provider.
export function assertCleanupOwnership({
  environment,
  runId,
  cleanupOwner,
  resources,
}) {
  assertLocalEnvironment(environment);
  if (typeof runId !== "string" || !RUN_ID.test(runId))
    throw new Error("valid runId is required for cleanup guard");
  const expectedOwner = `greenguard-stage13-${runId}`;
  if (cleanupOwner !== expectedOwner)
    throw new Error("cleanup owner does not match this run");
  if (!Array.isArray(resources)) throw new Error("resources must be an array");
  const expectedPrefix = `${expectedOwner}-`;
  for (const resource of resources) {
    if (
      !resource ||
      resource.owner !== expectedOwner ||
      typeof resource.name !== "string" ||
      !resource.name.startsWith(expectedPrefix)
    ) {
      throw new Error(
        "cleanup guard rejected a resource not owned by this Stage 13 run",
      );
    }
  }
  return true;
}

async function main() {
  const [command, manifestPath] = process.argv.slice(2);
  const environment = process.env.GREENGUARD_STAGE13_ENV;
  assertLocalEnvironment(environment);
  if (command !== "validate" || !manifestPath) {
    throw new Error(
      "usage: GREENGUARD_STAGE13_ENV=local node scripts/stage13-harness.mjs validate <workload.json>",
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = validateWorkload(manifest, environment);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    "Harness metadata validated offline; no traffic, faults, cleanup, or Stage 13 certification performed.\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`Stage 13 harness blocked: ${error.message}\n`);
    process.exitCode = 1;
  });
}
