import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb, type Db } from "../db/client.js";

export function env(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required: run make bootstrap and make db-migrate`,
    );
  return value;
}

// Runtime path: alerts_app through PgBouncer transaction pooling.
export const pooledDb = (max = 5): Db =>
  createDb(env("ALERTS_DATABASE_URL"), max);

async function run<T>(url: string, sql: string, params: unknown[]) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

// Superuser (bypasses RLS) to inspect what was really written.
export function adminQuery<T>(sql: string, params: unknown[] = []) {
  const url = new URL(env("POSTGRES_ADMIN_URL"));
  url.pathname = "/greenguard_alerts";
  return run<T>(url.toString(), sql, params);
}

// alerts_app over a direct session; callers set tenant context themselves.
export const appQuery = <T>(sql: string, params: unknown[] = []) =>
  run<T>(env("ALERTS_DIRECT_URL"), sql, params);

export interface Stream {
  tenantId: string;
  deviceId: string;
  binId: string;
  version: number;
}

export const newStream = (tenantId = randomUUID()): Stream => ({
  tenantId,
  deviceId: randomUUID(),
  binId: randomUUID(),
  version: 0,
});

type Severity = "normal" | "warning" | "critical" | "insufficient_data";

const severityFor = (score: number | null): Severity => {
  if (score === null) return "insufficient_data";
  if (score >= 70) return "critical";
  return score >= 40 ? "warning" : "normal";
};

// A contract-valid risk.assessed event; each call advances the device stream.
export function riskEvent(
  stream: Stream,
  score: number | null,
  overrides: { version?: number; occurredAt?: string } = {},
) {
  const version = overrides.version ?? ++stream.version;
  const severity = severityFor(score);
  const eventId = randomUUID();
  const causationId = randomUUID();
  return {
    event_id: eventId,
    event_type: "risk.assessed",
    schema_version: 1,
    occurred_at:
      overrides.occurredAt ??
      new Date(Date.UTC(2026, 8, 21, 15, 0, version)).toISOString(),
    tenant_id: stream.tenantId,
    aggregate_type: "device_risk_stream",
    aggregate_id: stream.deviceId,
    aggregate_version: String(version),
    correlation_id: randomUUID(),
    causation_id: causationId,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    payload: {
      assessment_id: randomUUID(),
      assessment_version: String(version),
      device_id: stream.deviceId,
      reading_id: randomUUID(),
      source_event_id: causationId,
      bin_id: stream.binId,
      lot_id: randomUUID(),
      grain_type: "wheat",
      occupancy_version: "1",
      policy_version: "1",
      score,
      severity,
      alert_eligible: severity === "warning" || severity === "critical",
      reasons: score === null ? [] : ["elevated_temperature"],
    },
  };
}

export function uncalibratedRiskEventV2(stream: Stream) {
  const event = riskEvent(stream, null);
  return {
    ...event,
    schema_version: 2,
    aggregate_version: "42",
    payload: {
      ...event.payload,
      assessment_version: "2",
      policy_id: randomUUID(),
      policy_calibrated: false,
      policy_provenance: { source: "synthetic_fixture", status: "draft" },
      score: null,
      severity: "insufficient_data" as const,
      alert_eligible: false,
      reasons: ["policy_not_calibrated"],
    },
  };
}

export function calibratedRiskEventV2(stream: Stream, score = 70) {
  const event = riskEvent(stream, score);
  return {
    ...event,
    schema_version: 2,
    aggregate_version: "42",
    payload: {
      ...event.payload,
      assessment_version: "2",
      policy_id: randomUUID(),
      policy_calibrated: true,
      policy_provenance: { source: "approved_fixture", status: "active" },
    },
  };
}

export function invalidationEvent(
  stream: Stream,
  assessed: ReturnType<typeof riskEvent>,
) {
  const version = ++stream.version;
  return {
    ...assessed,
    event_id: randomUUID(),
    event_type: "risk.assessment_invalidated",
    aggregate_version: String(version),
    payload: {
      assessment_id: assessed.payload.assessment_id,
      assessment_version: String(version),
      device_id: stream.deviceId,
      reading_id: assessed.payload.reading_id,
      source_event_id: assessed.payload.source_event_id,
      bin_id: stream.binId,
      previous_lot_id: assessed.payload.lot_id,
      replacement_lot_id: randomUUID(),
      replacement_occupancy_version: "2",
      observed_at: assessed.occurred_at,
      effective_from: assessed.occurred_at,
      reason: "backdated_lot_placement",
    },
  };
}

export const outboxFor = (tenantId: string) =>
  adminQuery<Record<string, unknown>>(
    `SELECT * FROM outbox_events WHERE tenant_id = $1 ORDER BY aggregate_id, aggregate_version`,
    [tenantId],
  );

// alerts_app over a direct session inside one transaction with a tenant context,
// exactly as the runtime sets it; returns the row count of the statement.
export async function asTenant(
  tenantId: string,
  sql: string,
  params: unknown[],
) {
  const client = new pg.Client({ connectionString: env("ALERTS_DIRECT_URL") });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
