import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateEvent } from "./index.js";

// Stage 08 (ADR-0016) greenguard.projection.notification.v1 fixtures. They live in their
// own folder so older fixture sets keep their exact file counts.
const dir = fileURLToPath(
  new URL("../../../tests/fixtures/events/projection/", import.meta.url),
);
const load = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${dir}${file}`, "utf8"));

const expected: Record<string, RegExp> = {
  "resource-differs.json": /payload.resource_id must equal aggregate_id/,
  "version-differs.json": /payload.source_version must equal aggregate_version/,
  "source-not-causation.json":
    /payload.source_event_id must equal causation_id/,
  "telemetry-tenant-scope.json":
    /payload.scope must be device exactly for telemetry changes/,
  "unknown-scope.json": /must be equal to one of the allowed values/,
  "unknown-payload-field.json": /must NOT have additional properties/,
};

test("device-, tenant- and epoch-scoped projection notifications are valid", () => {
  const valid = readdirSync(dir).filter((f) => f.endsWith(".v1.valid.json"));
  assert.equal(valid.length, 3);
  for (const file of valid) {
    const result = validateEvent(load(file));
    assert.deepEqual(result.ok ? [] : result.errors, [], file);
  }
});

test("every invalid projection notification fails with its exact rule", () => {
  const invalid = readdirSync(`${dir}invalid`).sort();
  assert.deepEqual(invalid, Object.keys(expected).sort());
  for (const file of invalid) {
    const result = validateEvent(load(`invalid/${file}`));
    assert.equal(result.ok, false, file);
    assert.match(result.ok ? "" : result.errors.join("\n"), expected[file]!);
  }
});
