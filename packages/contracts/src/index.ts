import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats =
  addFormatsModule as unknown as typeof addFormatsModule.default;

export interface DomainEvent {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  correlation_id: string;
  causation_id: string;
  traceparent: string;
  payload: Record<string, unknown>;
}

export interface ValidationSuccess {
  ok: true;
  event: DomainEvent;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface OutboxRow {
  eventId: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: bigint;
  eventType: string;
  schemaVersion: number;
  occurredAt: Date;
  correlationId: string;
  causationId: string;
  traceparent: string;
  payload: unknown;
}

const SCHEMA_FILES: Record<string, string> = {
  "site.changed@1": "site-changed.v1.schema.json",
  "bin.changed@1": "bin-changed.v1.schema.json",
  "lot.changed@1": "lot-changed.v1.schema.json",
  "telemetry.recorded@1": "telemetry-recorded.v1.schema.json",
  "risk.assessed@1": "risk-assessed.v1.schema.json",
  "risk.assessment_invalidated@1": "risk-assessment-invalidated.v1.schema.json",
  "device.registered@1": "device-registered.v1.schema.json",
  "device.binding_changed@1": "device-binding-changed.v1.schema.json",
  "device.status_changed@1": "device-status-changed.v1.schema.json",
  // Stage 06b: greenguard.alerts.lifecycle.v1 carries five types under one schema.
  "alert.opened@1": "alert-lifecycle.v1.schema.json",
  "alert.updated@1": "alert-lifecycle.v1.schema.json",
  "alert.acknowledged@1": "alert-lifecycle.v1.schema.json",
  "alert.escalated@1": "alert-lifecycle.v1.schema.json",
  "alert.resolved@1": "alert-lifecycle.v1.schema.json",
};

const MAX_BIGINT = 9223372036854775807n;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const ID_FIELDS = [
  "tenant_id",
  "event_id",
  "aggregate_id",
  "correlation_id",
  "causation_id",
] as const;

const schemaDir = new URL("../../../contracts/events/", import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

// One compiled validator per schema file: several event types may share a file.
const compiled = new Map<string, ValidateFunction>();
const compileFile = (file: string): ValidateFunction => {
  let validate = compiled.get(file);
  if (!validate) {
    validate = ajv.compile(
      JSON.parse(readFileSync(new URL(file, schemaDir), "utf8")),
    );
    compiled.set(file, validate);
  }
  return validate;
};
const validators = new Map<string, ValidateFunction>(
  Object.entries(SCHEMA_FILES).map(([key, file]) => [key, compileFile(file)]),
);

function payloadFields(event: DomainEvent): [string, string] {
  if (event.event_type === "lot.changed") {
    return ["bin_id", "occupancy_version"];
  }
  if (
    event.event_type === "risk.assessed" ||
    event.event_type === "risk.assessment_invalidated"
  ) {
    return ["device_id", "assessment_version"];
  }
  if (event.aggregate_type === "alert_episode") {
    return ["episode_id", "episode_version"];
  }
  if (event.aggregate_type === "site" || event.aggregate_type === "bin") {
    return [`${event.aggregate_type}_id`, `${event.aggregate_type}_version`];
  }
  return ["device_id", "binding_version"];
}

function riskErrors(event: DomainEvent, errors: string[]): void {
  const score = event.payload["score"];
  const severity = event.payload["severity"];
  const eligible = event.payload["alert_eligible"];
  for (const field of ["assessment_id", "reading_id", "bin_id", "lot_id"]) {
    if (event.payload[field] === NIL_UUID) {
      errors.push(`payload.${field} must not be the all-zero UUID`);
    }
  }
  for (const field of ["policy_version", "occupancy_version"]) {
    if (BigInt(event.payload[field] as string) > MAX_BIGINT) {
      errors.push(`payload.${field} exceeds 9223372036854775807`);
    }
  }
  if (event.payload["source_event_id"] !== event.causation_id) {
    errors.push("payload.source_event_id must equal causation_id");
  }
  if ((score === null) !== (severity === "insufficient_data")) {
    errors.push("risk score must be null exactly when data is insufficient");
  }
  if (eligible !== (severity === "warning" || severity === "critical")) {
    errors.push("risk alert_eligible must match severity");
  }
}

function riskInvalidationErrors(event: DomainEvent, errors: string[]): void {
  for (const field of [
    "assessment_id",
    "reading_id",
    "source_event_id",
    "bin_id",
    "previous_lot_id",
    "replacement_lot_id",
  ]) {
    if (event.payload[field] === NIL_UUID) {
      errors.push(`payload.${field} must not be the all-zero UUID`);
    }
  }
  if (
    BigInt(event.payload["replacement_occupancy_version"] as string) >
    MAX_BIGINT
  ) {
    errors.push(
      "payload.replacement_occupancy_version exceeds 9223372036854775807",
    );
  }
  // causation_id identifies the lot placement; source_event_id identifies the
  // original telemetry reading. They are intentionally different events.
}

const ALERT_STATES: Record<string, string[]> = {
  "alert.opened": ["open"],
  "alert.updated": ["open", "acknowledged"],
  "alert.acknowledged": ["acknowledged"],
  "alert.escalated": ["open"],
  "alert.resolved": ["resolved"],
};
const RISK_CAUSED = new Set([
  "alert.opened",
  "alert.updated",
  "alert.resolved",
]);

// Lifecycle cross-field rules: state per event type, and risk-caused transitions
// name their source risk event, which is also the causation.
function alertErrors(event: DomainEvent, errors: string[]): void {
  const { state, source_event_id: source } = event.payload;
  if (!ALERT_STATES[event.event_type].includes(state as string)) {
    errors.push(`${event.event_type} must not carry state ${String(state)}`);
  }
  if (RISK_CAUSED.has(event.event_type) !== (source !== null)) {
    errors.push(
      "payload.source_event_id is required exactly for risk-caused transitions",
    );
  } else if (source !== null && source !== event.causation_id) {
    errors.push("payload.source_event_id must equal causation_id");
  }
  if (
    event.event_type === "alert.acknowledged" &&
    event.payload["acknowledged_by"] === null
  ) {
    errors.push("alert.acknowledged requires payload.acknowledged_by");
  }
}

function lotErrors(event: DomainEvent, errors: string[]): void {
  for (const field of ["site_id", "lot_id", "previous_lot_id"]) {
    if (event.payload[field] === NIL_UUID) {
      errors.push(`payload.${field} must not be the all-zero UUID`);
    }
  }
  if (event.payload["lot_id"] === event.payload["previous_lot_id"]) {
    errors.push("payload.lot_id must differ from previous_lot_id");
  }
}

function identityErrors(event: DomainEvent, errors: string[]): void {
  for (const field of ID_FIELDS) {
    if (event[field] === NIL_UUID) {
      errors.push(`${field} must not be the all-zero UUID`);
    }
  }
  const [identityField, versionField] = payloadFields(event);
  const payloadVersion = event.payload[versionField] as string;
  for (const [name, value] of [
    ["aggregate_version", event.aggregate_version],
    [`payload.${versionField}`, payloadVersion],
  ]) {
    if (BigInt(value) > MAX_BIGINT) {
      errors.push(`${name} exceeds 9223372036854775807`);
    }
  }
  if (event.payload[identityField] !== event.aggregate_id) {
    errors.push(`payload.${identityField} must equal aggregate_id`);
  }
  if (
    event.event_type !== "telemetry.recorded" &&
    payloadVersion !== event.aggregate_version
  ) {
    errors.push(`payload.${versionField} must equal aggregate_version`);
  }
}

function semanticErrors(event: DomainEvent): string[] {
  const errors: string[] = [];
  identityErrors(event, errors);
  if (event.event_type === "risk.assessed") {
    riskErrors(event, errors);
  }
  if (event.event_type === "risk.assessment_invalidated") {
    riskInvalidationErrors(event, errors);
  }
  if (event.event_type === "lot.changed") {
    lotErrors(event, errors);
  }
  if (event.aggregate_type === "alert_episode") {
    alertErrors(event, errors);
  }
  if (/^00-0{32}-/.test(event.traceparent)) {
    errors.push("traceparent trace-id must not be all zeros");
  }
  if (/-0{16}-\d{2}$/.test(event.traceparent)) {
    errors.push("traceparent span-id must not be all zeros");
  }
  return errors;
}

export function validateEvent(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["event must be a JSON object"] };
  }
  const { event_type: type, schema_version: version } = input as Record<
    string,
    unknown
  >;
  const validate = validators.get(`${String(type)}@${String(version)}`);
  if (!validate) {
    return {
      ok: false,
      errors: [
        `unknown event_type/schema_version: ${String(type)}@${String(version)}`,
      ],
    };
  }
  if (!validate(input)) {
    return {
      ok: false,
      errors: ajv
        .errorsText(validate.errors, { separator: "\n", dataVar: "event" })
        .split("\n"),
    };
  }
  const event = input as DomainEvent;
  const errors = semanticErrors(event);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, event };
}

export function outboxRowToEvent(row: OutboxRow): DomainEvent {
  const head = row.occurredAt.toISOString().slice(0, 19);
  const micros = String(row.occurredAt.getUTCMilliseconds()).padStart(3, "0");
  return {
    event_id: row.eventId,
    event_type: row.eventType,
    schema_version: row.schemaVersion,
    occurred_at: `${head}.${micros}000Z`,
    tenant_id: row.tenantId,
    aggregate_type: row.aggregateType,
    aggregate_id: row.aggregateId,
    aggregate_version: row.aggregateVersion.toString(),
    correlation_id: row.correlationId,
    causation_id: row.causationId,
    traceparent: row.traceparent,
    payload: row.payload as Record<string, unknown>,
  };
}
