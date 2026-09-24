import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { outboxRowToEvent, validateEvent, type OutboxRow } from "./index.js";

const fixtureDir = fileURLToPath(
  new URL("../../../tests/fixtures/events/", import.meta.url),
);
const load = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${fixtureDir}${path}`, "utf8"));
const validFixtures = readdirSync(fixtureDir).filter((f) =>
  f.endsWith(".v1.valid.json"),
);
const invalidFixtures = readdirSync(`${fixtureDir}invalid`);

const expectedRule: Record<string, string> = {
  "unknown-top-level-field.json": "must NOT have additional properties",
  "unknown-payload-field.json": "must NOT have additional properties",
  "missing-tenant-id.json": "must have required property 'tenant_id'",
  "missing-payload-site-id.json": "must have required property 'site_id'",
  "aggregate-version-is-number.json": "must be string",
  "uppercase-tenant-id.json": "must match pattern",
  "nil-tenant-id.json": "tenant_id must not be the all-zero UUID",
  "nil-event-id.json": "event_id must not be the all-zero UUID",
  "device-id-differs-from-aggregate-id.json":
    "payload.device_id must equal aggregate_id",
  "telemetry-device-id-differs-from-aggregate-id.json":
    "payload.device_id must equal aggregate_id",
  "binding-version-differs-from-aggregate-version.json":
    "payload.binding_version must equal aggregate_version",
  "aggregate-version-zero.json": "must match pattern",
  "aggregate-version-leading-zero.json": "must match pattern",
  "aggregate-version-negative.json": "must match pattern",
  "aggregate-version-exceeds-int64.json":
    "aggregate_version exceeds 9223372036854775807",
  "binding-version-exceeds-int64.json":
    "payload.binding_version exceeds 9223372036854775807",
  "traceparent-zero-trace-id.json":
    "traceparent trace-id must not be all zeros",
  "traceparent-zero-span-id.json": "traceparent span-id must not be all zeros",
  "occurred-at-seven-fraction-digits.json": "must match pattern",
  "occurred-at-not-utc.json": "must match pattern",
  "serial-number-empty.json": "must NOT have fewer than 1 characters",
  "status-not-in-enum.json": "must be equal to one of the allowed values",
  "bin-id-missing.json": "must have required property 'bin_id'",
  "unknown-event-type.json":
    "unknown event_type/schema_version: device.exploded@1",
  "unknown-schema-version.json":
    "unknown event_type/schema_version: device.registered@2",
};

for (const kind of ["site", "bin"]) {
  Object.assign(expectedRule, {
    [`${kind}-identity-mismatch.json`]: `payload.${kind}_id must equal aggregate_id`,
    [`${kind}-version-mismatch.json`]: `payload.${kind}_version must equal aggregate_version`,
    [`${kind}-version-overflow.json`]: `payload.${kind}_version exceeds 9223372036854775807`,
    [`${kind}-empty-name.json`]: "must NOT have fewer than 1 characters",
    [`${kind}-unknown-field.json`]: "must NOT have additional properties",
  });
}
expectedRule["bin-missing-site.json"] = "must have required property 'site_id'";

test("shared facility verdicts match", () => {
  for (const [file, accepted] of Object.entries(
    load("facility.expectations.json"),
  )) {
    assert.equal(validateEvent(load(file)).ok, accepted, file);
  }
});

function failure(input: unknown): string {
  const result = validateEvent(input);
  assert.equal(result.ok, false);
  return result.ok ? "" : result.errors.join("\n");
}

const registered = (): Record<string, unknown> =>
  load("device-registered.v1.valid.json");

test("C01 every valid fixture passes", () => {
  assert.equal(validFixtures.length, 8);
  for (const file of validFixtures) {
    const result = validateEvent(load(file));
    assert.deepEqual(result.ok ? [] : result.errors, [], file);
  }
});

test("risk assessment identity and severity invariants fail closed", () => {
  const risk = load("risk-assessed.v1.valid.json");
  assert.equal(validateEvent(risk).ok, true);
  assert.match(
    failure({
      ...risk,
      payload: { ...(risk["payload"] as object), score: null },
    }),
    /risk score must be null exactly when data is insufficient/,
  );
  assert.match(
    failure({
      ...risk,
      payload: { ...(risk["payload"] as object), alert_eligible: false },
    }),
    /risk alert_eligible must match severity/,
  );
  assert.match(
    failure({ ...risk, causation_id: "22222222-2222-4222-8222-222222222222" }),
    /payload.source_event_id must equal causation_id/,
  );
  assert.match(
    failure({
      ...risk,
      payload: {
        ...(risk["payload"] as object),
        assessment_id: "00000000-0000-0000-0000-000000000000",
      },
    }),
    /payload.assessment_id must not be the all-zero UUID/,
  );
  assert.match(
    failure({
      ...risk,
      payload: {
        ...(risk["payload"] as object),
        policy_version: "9223372036854775808",
      },
    }),
    /payload.policy_version exceeds 9223372036854775807/,
  );
});

test("risk invalidation has a registered versioned contract", () => {
  const assessed = load("risk-assessed.v1.valid.json");
  const p = assessed["payload"] as Record<string, unknown>;
  const event = {
    ...assessed,
    event_type: "risk.assessment_invalidated",
    causation_id: assessed["event_id"],
    aggregate_version: "2",
    payload: {
      assessment_id: p["assessment_id"],
      assessment_version: "2",
      device_id: p["device_id"],
      reading_id: p["reading_id"],
      source_event_id: p["source_event_id"],
      bin_id: p["bin_id"],
      previous_lot_id: p["lot_id"],
      replacement_lot_id: p["lot_id"],
      replacement_occupancy_version: "2",
      observed_at: assessed["occurred_at"],
      effective_from: assessed["occurred_at"],
      reason: "backdated_lot_placement",
    },
  };
  assert.notEqual(event.payload.source_event_id, event.causation_id);
  assert.equal(validateEvent(event).ok, true);
  for (const field of [
    "assessment_id",
    "reading_id",
    "source_event_id",
    "bin_id",
    "previous_lot_id",
    "replacement_lot_id",
  ]) {
    assert.match(
      failure({
        ...event,
        payload: {
          ...event.payload,
          [field]: "00000000-0000-0000-0000-000000000000",
        },
      }),
      new RegExp(`payload.${field} must not be the all-zero UUID`),
    );
  }
  assert.match(
    failure({
      ...event,
      payload: {
        ...event.payload,
        replacement_occupancy_version: "9223372036854775808",
      },
    }),
    /replacement_occupancy_version exceeds 9223372036854775807/,
  );
  assert.equal(
    validateEvent({ ...event, payload: { ...event.payload, reason: "wrong" } })
      .ok,
    false,
  );
});

test("C02 every invalid fixture fails with its exact rule", () => {
  assert.deepEqual(
    [...invalidFixtures].sort(),
    Object.keys(expectedRule).sort(),
  );
  for (const file of invalidFixtures) {
    assert.ok(
      failure(load(`invalid/${file}`)).includes(expectedRule[file] ?? ""),
      file,
    );
  }
});

test("shared telemetry identity verdicts match", () => {
  const expectations = load("telemetry-identity.expectations.json");
  for (const [file, accepted] of Object.entries(expectations)) {
    assert.equal(validateEvent(load(file)).ok, accepted, file);
  }
});

test("C03 versions beyond MAX_SAFE_INTEGER round-trip exactly", () => {
  for (const version of ["9007199254740993", "9223372036854775807"]) {
    const event = {
      ...registered(),
      aggregate_version: version,
      payload: {
        ...(registered()["payload"] as object),
        binding_version: version,
      },
    };
    const result = validateEvent(event);
    assert.ok(result.ok);
    assert.equal(result.ok && result.event.aggregate_version, version);
  }
});

test("C03 out-of-range versions fail", () => {
  for (const version of ["9223372036854775808", "0", "01", "-1"]) {
    const event = { ...registered(), aggregate_version: version };
    assert.notEqual(failure(event), "", version);
  }
});

test("C04 structural defects fail", () => {
  assert.match(failure(null), /must be a JSON object/);
  assert.match(failure([]), /must be a JSON object/);
  assert.match(
    failure({ ...registered(), extra: true }),
    /additional properties/,
  );
  const missing = registered();
  delete missing["tenant_id"];
  assert.match(failure(missing), /tenant_id/);
  assert.match(failure({ ...registered(), tenant_id: 5 }), /must be string/);
  assert.match(
    failure({ ...registered(), payload: [] }),
    /payload must be object/,
  );
});

test("C04 semantic defects report every failing rule", () => {
  const nil = "00000000-0000-0000-0000-000000000000";
  const text = failure({
    ...registered(),
    traceparent: `00-${"0".repeat(32)}-${"0".repeat(16)}-01`,
    aggregate_id: nil,
    payload: {
      ...(registered()["payload"] as object),
      device_id: "33333333-3333-4333-8333-333333333333",
    },
  });
  for (const rule of [
    "trace-id",
    "span-id",
    "aggregate_id must not",
    "payload.device_id must equal",
  ]) {
    assert.ok(text.includes(rule), rule);
  }
});

test("schema files resolve from the repo root", () => {
  assert.ok(
    existsSync(
      `${fixtureDir}../../../contracts/events/device-registered.v1.schema.json`,
    ),
  );
});

const row = (occurredAt: Date): OutboxRow => {
  const event = registered();
  return {
    eventId: event["event_id"] as string,
    tenantId: event["tenant_id"] as string,
    aggregateType: "device",
    aggregateId: event["aggregate_id"] as string,
    aggregateVersion: 7n,
    eventType: "device.registered",
    schemaVersion: 1,
    occurredAt,
    correlationId: event["correlation_id"] as string,
    causationId: event["causation_id"] as string,
    traceparent: event["traceparent"] as string,
    payload: event["payload"],
  };
};

test("outboxRowToEvent produces a valid event", () => {
  const event = outboxRowToEvent(row(new Date("2026-09-21T15:00:00.125Z")));
  assert.deepEqual(event, registered());
  assert.ok(validateEvent(event).ok);
});

test("outboxRowToEvent formats exactly six fractional digits", () => {
  const cases: [string, string][] = [
    ["2026-09-21T15:00:00.500Z", "2026-09-21T15:00:00.500000Z"],
    ["2026-09-21T15:00:00.125Z", "2026-09-21T15:00:00.125000Z"],
    ["2026-09-21T15:00:00.001Z", "2026-09-21T15:00:00.001000Z"],
    ["2026-09-21T15:00:00.000Z", "2026-09-21T15:00:00.000000Z"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(outboxRowToEvent(row(new Date(input))).occurred_at, expected);
  }
});

test("outboxRowToEvent renders bigint versions beyond safe integers exactly", () => {
  const big = { ...row(new Date(0)), aggregateVersion: 9223372036854775807n };
  assert.equal(outboxRowToEvent(big).aggregate_version, "9223372036854775807");
});

test("unknown event_type or schema_version fails", () => {
  assert.match(
    failure({ ...registered(), event_type: "nope.happened" }),
    /nope\.happened@1/,
  );
  assert.match(
    failure({ ...registered(), schema_version: 2 }),
    /device\.registered@2/,
  );
});
