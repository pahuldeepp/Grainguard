import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ciComposeProjectName,
  composeContainerName,
} from "./ci-compose-project.mjs";

test("keeps local Compose project naming unchanged", () => {
  assert.equal(ciComposeProjectName({}), undefined);
});

test("names a deterministic, isolated project for each Actions runner temp dir", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    RUNNER_TEMP: "/runner/_temp/job-123",
  };
  const expected = createHash("sha256")
    .update(env.RUNNER_TEMP)
    .digest("hex")
    .slice(0, 12);
  assert.equal(ciComposeProjectName(env), `greenguard-ci-${expected}`);
  assert.notEqual(
    ciComposeProjectName(env),
    ciComposeProjectName({ ...env, RUNNER_TEMP: "/runner/_temp/job-456" }),
  );
});

test("fails closed if Actions has no per-job temporary directory", () => {
  assert.throws(
    () => ciComposeProjectName({ GITHUB_ACTIONS: "true" }),
    /RUNNER_TEMP is required/,
  );
});

test("resolves Compose containers from the active project without changing local defaults", () => {
  assert.equal(
    composeContainerName("postgres", {}),
    "greenguard-dev-postgres-1",
  );
  assert.equal(
    composeContainerName("kafka", {
      COMPOSE_PROJECT_NAME: "greenguard-ci-a1b2c3d4e5f6",
    }),
    "greenguard-ci-a1b2c3d4e5f6-kafka-1",
  );
  assert.equal(
    composeContainerName("redis-node-1", {
      COMPOSE_PROJECT_NAME: "greenguard-ci-a1b2c3d4e5f6",
    }),
    "greenguard-ci-a1b2c3d4e5f6-redis-node-1-1",
  );
  assert.throws(
    () => composeContainerName("../postgres", {}),
    /Invalid Compose service name/,
  );
  assert.throws(
    () =>
      composeContainerName("postgres", {
        COMPOSE_PROJECT_NAME: "unsafe/project",
      }),
    /Invalid COMPOSE_PROJECT_NAME/,
  );
});
