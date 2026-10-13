import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateEvent } from "./index.js";

const load = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`../../../tests/fixtures/events/${name}`, import.meta.url),
      "utf8",
    ),
  );

test("v1 and additive telemetry fixture verdicts match", () => {
  for (const [name, expected] of Object.entries(
    load("telemetry-v2.expectations.json"),
  ))
    assert.equal(validateEvent(load(name)).ok, expected, name);
});

test("v1 stays strict and v2 rejects nonfinite measurements", () => {
  const legacy = load("telemetry-recorded.v1.valid.json");
  const payload = legacy["payload"] as Record<string, unknown>;
  (payload["measurements"] as Record<string, unknown>)["co2_ppm"] = 450;
  assert.equal(validateEvent(legacy).ok, false);
  for (const value of [NaN, Infinity, -Infinity]) {
    const event = load("telemetry-recorded.v2.valid.json");
    (
      (event["payload"] as Record<string, unknown>)["measurements"] as Record<
        string,
        unknown
      >
    )["co2_ppm"] = value;
    assert.equal(validateEvent(event).ok, false);
  }
});

test("cable owner snapshot denies duplicate identities, positions, nil IDs and invalid depth", () => {
  const event = load("cable-layout-changed.v1.valid.json");
  assert.equal(validateEvent(event).ok, true);
  for (const mutate of [
    (p: Record<string, unknown>) => {
      p["cable_version"] = "9223372036854775808";
    },
    (p: Record<string, unknown>) => {
      p["device_id"] = "00000000-0000-0000-0000-000000000000";
    },
    (p: Record<string, unknown>) => {
      const s = p["sensors"] as Record<string, unknown>[];
      s[1]["sensor_id"] = s[0]["sensor_id"];
    },
    (p: Record<string, unknown>) => {
      const s = p["sensors"] as Record<string, unknown>[];
      s[1]["position"] = s[0]["position"];
    },
    (p: Record<string, unknown>) => {
      (p["sensors"] as Record<string, unknown>[])[0]["depth_m"] = Infinity;
    },
  ]) {
    const changed = structuredClone(event);
    mutate(changed["payload"] as Record<string, unknown>);
    assert.equal(validateEvent(changed).ok, false);
  }
});
