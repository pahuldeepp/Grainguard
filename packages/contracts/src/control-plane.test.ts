import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateEvent } from "./index.js";

// Stage 09a (ADR-0017) tenant.created and membership.changed fixtures, in their own
// folder so older fixture sets keep their exact file counts.
const dir = fileURLToPath(
  new URL("../../../tests/fixtures/events/control-plane/", import.meta.url),
);
const load = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${dir}${file}`, "utf8"));

const expected: Record<string, RegExp> = {
  "org-not-tenant.json": /aggregate_id must equal tenant_id for organizations/,
  "org-version-differs.json":
    /payload.organization_version must equal aggregate_version/,
  "membership-id-differs.json": /payload.membership_id must equal aggregate_id/,
  "device-role.json": /must be equal to one of the allowed values/,
  "revoked-state-without-action.json":
    /payload.action must be revoked exactly when state is revoked/,
  "raw-subject-on-bus.json": /must NOT have additional properties/,
  "unknown-action.json": /must be equal to one of the allowed values/,
};

test("tenant.created and membership.changed fixtures are valid", () => {
  const valid = readdirSync(dir).filter((f) => f.endsWith(".v1.valid.json"));
  assert.equal(valid.length, 2);
  for (const file of valid) {
    const result = validateEvent(load(file));
    assert.deepEqual(result.ok ? [] : result.errors, [], file);
  }
});

test("every invalid control-plane event fails with its exact rule", () => {
  const invalid = readdirSync(`${dir}invalid`).sort();
  assert.deepEqual(invalid, Object.keys(expected).sort());
  for (const file of invalid) {
    const result = validateEvent(load(`invalid/${file}`));
    assert.equal(result.ok, false, file);
    assert.match(result.ok ? "" : result.errors.join("\n"), expected[file]!);
  }
});
