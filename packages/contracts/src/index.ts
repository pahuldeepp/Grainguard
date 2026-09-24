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
  "telemetry.recorded@1": "telemetry-recorded.v1.schema.json",
  "device.registered@1": "device-registered.v1.schema.json",
  "device.binding_changed@1": "device-binding-changed.v1.schema.json",
  "device.status_changed@1": "device-status-changed.v1.schema.json",
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

const validators = new Map<string, ValidateFunction>(
  Object.entries(SCHEMA_FILES).map(([key, file]) => [
    key,
    ajv.compile(JSON.parse(readFileSync(new URL(file, schemaDir), "utf8"))),
  ]),
);

function semanticErrors(event: DomainEvent): string[] {
  const errors: string[] = [];
  for (const field of ID_FIELDS) {
    if (event[field] === NIL_UUID) {
      errors.push(`${field} must not be the all-zero UUID`);
    }
  }
  const bindingVersion = event.payload["binding_version"] as string;
  for (const [name, value] of [
    ["aggregate_version", event.aggregate_version],
    ["payload.binding_version", bindingVersion],
  ]) {
    if (BigInt(value) > MAX_BIGINT) {
      errors.push(`${name} exceeds 9223372036854775807`);
    }
  }
  if (event.aggregate_type === "device") {
    if (event.payload["device_id"] !== event.aggregate_id) {
      errors.push("payload.device_id must equal aggregate_id");
    }
    if (bindingVersion !== event.aggregate_version) {
      errors.push("payload.binding_version must equal aggregate_version");
    }
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
