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
  "telemetry.recorded@2": "telemetry-recorded.v2.schema.json",
  "cable.layout_changed@1": "cable-layout-changed.v1.schema.json",
  "risk.assessed@1": "risk-assessed.v1.schema.json",
  "risk.assessed@2": "risk-assessed.v2.schema.json",
  "risk.policy_changed@1": "risk-policy-changed.v1.schema.json",
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
  // Stage 08 (ADR-0016): committed read-model changes for cache invalidation.
  "projection.notification@1": "projection-notification.v1.schema.json",
  // Stage 09a (ADR-0017): tenant-control-plane organization and membership events.
  "tenant.created@1": "tenant-created.v1.schema.json",
  "membership.changed@1": "membership-changed.v1.schema.json",
  "identity_connection.changed@1": "identity-connection-changed.v1.schema.json",
  "service_principal.created@1": "service-principal-changed.v1.schema.json",
  "service_principal.rotated@1": "service-principal-changed.v1.schema.json",
  "service_principal.revoked@1": "service-principal-changed.v1.schema.json",
  "subscription.changed@1": "subscription-changed.v1.schema.json",
  "entitlements.changed@1": "entitlements-changed.v1.schema.json",
  "usage.accepted@1": "usage-accepted.v1.schema.json",
  "billing.reconciliation_required@1":
    "billing-reconciliation-required.v1.schema.json",
  "billing.command_requested@1": "billing-command-requested.v1.schema.json",
  "flag.configuration_changed@1": "flag-configuration-changed.v1.schema.json",
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
  if (event.aggregate_type === "grain_policy") return ["policy_id", "version"];
  if (event.event_type === "cable.layout_changed")
    return ["cable_id", "cable_version"];
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
  if (event.aggregate_type === "projection_notification") {
    return ["resource_id", "source_version"];
  }
  if (event.aggregate_type === "organization") {
    return ["tenant_id", "organization_version"];
  }
  if (event.aggregate_type === "membership") {
    return ["membership_id", "membership_version"];
  }
  if (event.aggregate_type === "identity_connection") {
    return ["connection_id", "connection_version"];
  }
  if (event.aggregate_type === "service_principal") {
    return ["principal_id", "principal_version"];
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
  if (
    event.schema_version === 2 &&
    event.payload["policy_calibrated"] === false &&
    (score !== null || severity !== "insufficient_data" || eligible !== false)
  ) {
    errors.push(
      "uncalibrated risk policy must not produce an alertable assessment",
    );
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

function notificationErrors(event: DomainEvent, errors: string[]): void {
  if (event.payload["source_event_id"] !== event.causation_id) {
    errors.push("payload.source_event_id must equal causation_id");
  }
  if (event.payload["scope"] === "epoch") {
    if (
      event.payload["source_event_type"] !== "projection.promoted" ||
      event.payload["purpose"] !== "promotion_changed" ||
      event.tenant_id !== "00000000-0000-4000-8000-000000000001"
    ) {
      errors.push(
        "epoch notification must be a promotion for the infrastructure tenant",
      );
    }
    return;
  }
  if (
    event.payload["purpose"] === "promotion_changed" ||
    event.payload["source_event_type"] === "projection.promoted"
  ) {
    errors.push("promotion notification must use global epoch scope");
  }
  const telemetry = event.payload["source_event_type"] === "telemetry.recorded";
  if ((event.payload["scope"] === "device") !== telemetry) {
    errors.push("payload.scope must be device exactly for telemetry changes");
  }
}

function identityErrors(event: DomainEvent, errors: string[]): void {
  for (const field of ID_FIELDS) {
    if (event[field] === NIL_UUID) {
      errors.push(`${field} must not be the all-zero UUID`);
    }
  }
  if (BigInt(event.aggregate_version) > MAX_BIGINT)
    errors.push("aggregate_version exceeds 9223372036854775807");
  if (event.event_type === "subscription.changed") {
    if (event.payload["version"] !== event.aggregate_version)
      errors.push("payload.version must equal aggregate_version");
    return;
  }
  if (event.event_type === "flag.configuration_changed") {
    if (event.payload["config_version"] !== event.aggregate_version)
      errors.push("payload.config_version must equal aggregate_version");
    if (
      (event.payload["scope"] === "global") !==
      (event.tenant_id === "00000000-0000-4000-8000-000000000001")
    )
      errors.push("flag scope and tenant_id mismatch");
    return;
  }
  if (event.event_type === "entitlements.changed") {
    if (
      event.payload["tenant_id"] !== event.tenant_id ||
      event.aggregate_id !== event.tenant_id
    )
      errors.push("entitlement tenant identity mismatch");
    if (event.payload["source_version"] !== event.aggregate_version)
      errors.push("payload.source_version must equal aggregate_version");
    return;
  }
  if (event.event_type === "usage.accepted") {
    if (
      event.payload["tenant_id"] !== event.tenant_id ||
      event.payload["version"] !== event.aggregate_version
    )
      errors.push("usage identity or version mismatch");
    return;
  }
  if (
    event.event_type === "billing.reconciliation_required" ||
    event.event_type === "billing.command_requested"
  ) {
    const field =
      event.event_type === "billing.command_requested"
        ? "command_id"
        : "finding_id";
    if (
      event.payload[field] !== event.aggregate_id ||
      (event.payload["tenant_id"] &&
        event.payload["tenant_id"] !== event.tenant_id)
    )
      errors.push("billing aggregate identity mismatch");
    return;
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
    !(event.event_type === "risk.assessed" && event.schema_version === 2) &&
    payloadVersion !== event.aggregate_version
  ) {
    errors.push(`payload.${versionField} must equal aggregate_version`);
  }
}

function controlPlaneErrors(event: DomainEvent, errors: string[]): void {
  if (event.aggregate_type === "service_principal") {
    if (event.payload["tenant_id"] !== event.tenant_id)
      errors.push("payload.tenant_id must equal tenant_id");
    if (
      (event.event_type === "service_principal.revoked") !==
      (event.payload["state"] === "revoked")
    )
      errors.push("service principal state must match event type");
  }
  if (
    event.aggregate_type === "organization" &&
    event.aggregate_id !== event.tenant_id
  ) {
    errors.push("aggregate_id must equal tenant_id for organizations");
  }
  const revoked = event.payload["state"] === "revoked";
  if (
    event.aggregate_type === "membership" &&
    revoked !== (event.payload["action"] === "revoked")
  ) {
    errors.push("payload.action must be revoked exactly when state is revoked");
  }
}

function telemetryErrors(event: DomainEvent, errors: string[]): void {
  if (event.event_type !== "telemetry.recorded" || event.schema_version !== 2)
    return;
  const measurements = event.payload["measurements"] as Record<string, number>;
  const units = event.payload["measurement_units"] as Record<string, string>;
  const expected: Record<string, string> = {
    temperature_c: "Cel",
    relative_humidity_percent: "%",
    co2_ppm: "ppm",
    grain_moisture_percent: "%",
  };
  if (Object.keys(measurements).length !== Object.keys(units).length)
    errors.push("measurement units must match actual measurements");
  for (const [metric, value] of Object.entries(measurements)) {
    if (!Number.isFinite(value) || units[metric] !== expected[metric])
      errors.push("measurement must be finite and carry its physical unit");
  }
  const identities = new Set<string>();
  for (const observation of (event.payload["sensor_observations"] ??
    []) as Record<string, unknown>[]) {
    const identity = `${String(observation["sensor_id"])}:${String(observation["metric"])}`;
    if (
      identities.has(identity) ||
      observation["sensor_id"] === NIL_UUID ||
      observation["cable_id"] === NIL_UUID
    )
      errors.push("sensor/metric identities must be unique and non-nil");
    identities.add(identity);
    if (
      !Number.isFinite(observation["value"]) ||
      (observation["depth_m"] !== null &&
        !Number.isFinite(observation["depth_m"]))
    )
      errors.push("sensor value/depth must be finite");
    if (BigInt(observation["layout_version"] as string) > MAX_BIGINT)
      errors.push("layout_version exceeds 9223372036854775807");
  }
}

function cableLayoutErrors(event: DomainEvent, errors: string[]): void {
  if (event.event_type !== "cable.layout_changed") return;
  for (const field of ["device_id", "bin_id", "cable_id"])
    if (event.payload[field] === NIL_UUID)
      errors.push(`payload.${field} must not be nil`);
  const ids = new Set<unknown>();
  const positions = new Set<unknown>();
  for (const sensor of event.payload["sensors"] as Record<string, unknown>[]) {
    if (
      ids.has(sensor["sensor_id"]) ||
      positions.has(sensor["position"]) ||
      sensor["sensor_id"] === NIL_UUID
    )
      errors.push("sensor identities and positions must be unique and non-nil");
    ids.add(sensor["sensor_id"]);
    positions.add(sensor["position"]);
    if (sensor["depth_m"] !== null && !Number.isFinite(sensor["depth_m"]))
      errors.push("depth must be finite");
  }
}

function semanticErrors(event: DomainEvent): string[] {
  const errors: string[] = [];
  identityErrors(event, errors);
  telemetryErrors(event, errors);
  cableLayoutErrors(event, errors);
  controlPlaneErrors(event, errors);
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
  if (event.aggregate_type === "projection_notification") {
    notificationErrors(event, errors);
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
