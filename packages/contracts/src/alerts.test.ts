import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateEvent } from "./index.js";

// Stage 06b fixtures for greenguard.alerts.lifecycle.v1 live in their own folder so
// the older per-topic fixture sets keep their exact file counts.
const dir = fileURLToPath(
  new URL("../../../tests/fixtures/events/alerts/", import.meta.url),
);
const load = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${dir}${file}`, "utf8"));

const expected: Record<string, RegExp> = {
  "episode-id-differs.json": /payload.episode_id must equal aggregate_id/,
  "episode-version-differs.json":
    /payload.episode_version must equal aggregate_version/,
  "opened-not-open.json": /alert.opened must not carry state resolved/,
  "ack-without-actor.json":
    /alert.acknowledged requires payload.acknowledged_by/,
  "source-not-causation.json":
    /payload.source_event_id must equal causation_id/,
  "escalated-with-source.json":
    /source_event_id is required exactly for risk-caused transitions/,
  "severity-normal.json": /must be equal to one of the allowed values/,
  "unknown-payload-field.json": /must NOT have additional properties/,
};

test("every alert lifecycle type has a valid fixture", () => {
  const valid = readdirSync(dir).filter((f) => f.endsWith(".v1.valid.json"));
  const types = valid.map((f) => load(f)["event_type"]).sort();
  assert.deepEqual(types, [
    "alert.acknowledged",
    "alert.escalated",
    "alert.opened",
    "alert.resolved",
    "alert.updated",
  ]);
  for (const file of valid) {
    const result = validateEvent(load(file));
    assert.equal(result.ok, true, `${file}: ${JSON.stringify(result)}`);
  }
});

test("invalid alert fixtures fail for their named rule", () => {
  const files = readdirSync(`${dir}invalid`).sort();
  assert.deepEqual(files, Object.keys(expected).sort());
  for (const file of files) {
    const result = validateEvent(load(`invalid/${file}`));
    assert.equal(result.ok, false, file);
    if (!result.ok)
      assert.match(result.errors.join("\n"), expected[file], file);
  }
});

test("an alert event cannot claim another aggregate type", () => {
  const opened = load("alert-opened.v1.valid.json");
  const result = validateEvent({ ...opened, aggregate_type: "bin" });
  assert.equal(result.ok, false);
});
