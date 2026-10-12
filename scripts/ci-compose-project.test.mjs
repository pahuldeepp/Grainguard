import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ciComposeProjectName } from "./ci-compose-project.mjs";

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
