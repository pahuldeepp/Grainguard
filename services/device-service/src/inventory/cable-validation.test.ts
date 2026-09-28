import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cableVersion,
  MAX_SENSORS_PER_CABLE,
  parseCable,
} from "./cable-validation.js";
import { InvalidInputError } from "./errors.js";

const input = () => ({
  binId: randomUUID(),
  deviceId: randomUUID(),
  label: "Cable north",
  sensors: [
    { label: "Upper", position: 1, depthM: null },
    { label: "Lower", position: 2, depthM: 0 },
  ],
});
test("sensor layout validation preserves absent depths and zero meters, and sorts positions", () => {
  const value = input();
  value.sensors.reverse();
  const parsed = parseCable(value);
  assert.deepEqual(
    parsed.sensors.map((s) => [s.position, s.depthM]),
    [
      [1, null],
      [2, 0],
    ],
  );
  const missing = parseCable({
    ...value,
    sensors: [{ position: 1, label: "Unknown depth" }],
  });
  assert.equal(missing.sensors[0].depthM, null);
});
test("sensor layout rejects malformed IDs, unknown fields, duplicate positions and invalid depths", () => {
  for (const value of [
    { ...input(), tenantId: randomUUID() },
    { ...input(), assetId: randomUUID() },
    { ...input(), binId: "not-a-bin" },
    { ...input(), label: " " },
    { ...input(), sensors: [{ label: "Top", position: 0, depthM: null }] },
    { ...input(), sensors: [{ label: "Top", position: 1.5, depthM: null }] },
    ...[-1, NaN, Infinity, -Infinity, "2"].map((depthM) => ({
      ...input(),
      sensors: [{ label: "Top", position: 1, depthM }],
    })),
    {
      ...input(),
      sensors: [
        { label: "Top", position: 1 },
        { label: "Bottom", position: 1 },
      ],
    },
    {
      ...input(),
      sensors: Array.from({ length: MAX_SENSORS_PER_CABLE + 1 }, (_, i) => ({
        label: "S",
        position: i + 1,
      })),
    },
    { ...input(), sensors: [{ label: "Top", position: 1, depth_m: 1 }] },
  ])
    assert.throws(() => parseCable(value), InvalidInputError);
});
test("stable sensor IDs are owner-assigned on create and distinct on edits", () => {
  const sensorId = randomUUID();
  const body = {
    ...input(),
    sensors: [{ sensorId, label: "Top", position: 1 }],
  };
  assert.throws(() => parseCable(body), InvalidInputError);
  assert.equal(parseCable(body, true).sensors[0].sensorId, sensorId);
  assert.throws(
    () =>
      parseCable(
        {
          ...body,
          sensors: [body.sensors[0], { ...body.sensors[0], position: 2 }],
        },
        true,
      ),
    InvalidInputError,
  );
});
test("layout versions must leave room for a PostgreSQL bigint increment", () => {
  assert.equal(cableVersion("9223372036854775806"), 9223372036854775806n);
  for (const value of [
    "0",
    "-1",
    "1.2",
    "01",
    "9223372036854775807",
    "9223372036854775808",
  ])
    assert.throws(() => cableVersion(value), InvalidInputError);
});
