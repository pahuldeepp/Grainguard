import type { Pool, PoolClient } from "pg";
import type { Channel, Task } from "./task.js";
import { withTenant } from "./tenant.js";

export const OPTIONAL_HOLD_EXPIRED = "optional notification hold exhausted";

export const TERMINAL = ["sent", "failed", "suppressed"] as const;
export type Terminal = (typeof TERMINAL)[number];
export type Status =
  Terminal | "received" | "in_progress" | "retry" | "unknown" | "dead";

export function isTerminal(status: string): status is Terminal {
  return (TERMINAL as readonly string[]).includes(status);
}

/** What the worker must do next after the begin transaction commits. */
export type Plan =
  | { action: "receipt"; outcome: Terminal; park?: boolean }
  | { action: "stale" }
  | { action: "send"; attempt: number }
  | { action: "reconcile"; attempt: number; reconciles: number };

interface Row {
  status: Status;
  attempts: number;
  reconciles: number;
  delivery_generation: number;
  last_error?: string | null;
}

const SEVERITY_RANK: Record<string, number> = { warning: 1, critical: 2 };

async function lockDelivery(client: PoolClient, task: Task): Promise<Row> {
  await client.query(
    `INSERT INTO deliveries (tenant_id, intent_id, channel, severity, correlation_id, delivery_generation)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [
      task.tenant_id,
      task.intent_id,
      task.channel,
      task.severity,
      task.correlation_id,
      task.delivery_generation,
    ],
  );
  const { rows } = await client.query<Row>(
    `SELECT status, attempts, reconciles, delivery_generation, last_error FROM deliveries
     WHERE tenant_id = $1 AND intent_id = $2 FOR UPDATE`,
    [task.tenant_id, task.intent_id],
  );
  return rows[0];
}

async function allowedByPreference(
  client: PoolClient,
  task: Task,
): Promise<boolean> {
  const { rows } = await client.query<{
    enabled: boolean;
    min_severity: string;
  }>(
    `SELECT enabled, min_severity FROM notification_preferences
     WHERE tenant_id = $1 AND channel = $2`,
    [task.tenant_id, task.channel],
  );
  if (rows.length === 0) return true;
  const rank = SEVERITY_RANK[task.severity] ?? 0;
  return rows[0].enabled && rank >= SEVERITY_RANK[rows[0].min_severity];
}

async function addAttempt(
  client: PoolClient,
  task: Task,
  kind: string,
  outcome: string,
  detail: string | null,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `INSERT INTO delivery_attempts (tenant_id, intent_id, attempt_no, kind, outcome, detail, delivery_generation)
     SELECT $1, $2, coalesce(max(attempt_no), 0) + 1, $3, $4, $5, $6
       FROM delivery_attempts WHERE tenant_id = $1 AND intent_id = $2
     RETURNING attempt_no AS n`,
    [
      task.tenant_id,
      task.intent_id,
      kind,
      outcome,
      detail,
      task.delivery_generation,
    ],
  );
  return rows[0].n;
}

/**
 * Short locked transaction before any provider call: creates the delivery row once, applies
 * tenant preferences, and records an in_progress attempt so a crash during the provider
 * call is later treated as an uncertain outcome to reconcile, never as a silent failure.
 */
export async function beginDelivery(pool: Pool, task: Task): Promise<Plan> {
  return withTenant(pool, task.tenant_id, async (client) => {
    let row = await lockDelivery(client, task);
    if (task.delivery_generation < row.delivery_generation)
      return { action: "stale" };
    if (task.delivery_generation > row.delivery_generation) {
      if (row.status === "sent") return { action: "receipt", outcome: "sent" };
      await client.query(
        `UPDATE deliveries SET delivery_generation = $3, status = 'received', attempts = 0,
           reconciles = 0, provider_ref = NULL, last_error = NULL, terminal_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND intent_id = $2`,
        [task.tenant_id, task.intent_id, task.delivery_generation],
      );
      row = {
        status: "received",
        attempts: 0,
        reconciles: 0,
        delivery_generation: task.delivery_generation,
      };
    }
    if (isTerminal(row.status))
      return {
        action: "receipt",
        outcome: row.status,
        ...(row.status === "failed" && row.last_error === OPTIONAL_HOLD_EXPIRED
          ? { park: true }
          : {}),
      };
    if (row.status === "in_progress" || row.status === "unknown")
      return {
        action: "reconcile",
        attempt: row.attempts,
        reconciles: row.reconciles,
      };
    if (!(await allowedByPreference(client, task))) {
      await setStatus(client, task, "suppressed", null, "tenant preference");
      await addAttempt(client, task, "preference", "suppressed", null);
      return { action: "receipt", outcome: "suppressed" };
    }
    await client.query(
      `UPDATE deliveries SET status = 'in_progress', attempts = attempts + 1, updated_at = now()
       WHERE tenant_id = $1 AND intent_id = $2`,
      [task.tenant_id, task.intent_id],
    );
    await addAttempt(client, task, "send", "started", null);
    return { action: "send", attempt: row.attempts + 1 };
  });
}

export type HoldExpiry =
  | { action: "stale" }
  | { action: "receipt"; outcome: Terminal; park: boolean }
  | { action: "uncertain" }
  | { action: "failed" };

/** Exhaust a disabled optional send in one locked transaction. No provider send
 * has started, so neither attempts nor an in_progress claim are created. */
export async function expireOptionalHold(
  pool: Pool,
  task: Task,
): Promise<HoldExpiry> {
  return withTenant(pool, task.tenant_id, async (client) => {
    const row = await lockDelivery(client, task);
    if (task.delivery_generation < row.delivery_generation)
      return { action: "stale" };
    if (isTerminal(row.status))
      return {
        action: "receipt",
        outcome: row.status,
        park:
          row.status === "failed" && row.last_error === OPTIONAL_HOLD_EXPIRED,
      };
    if (row.status === "in_progress" || row.status === "unknown")
      return { action: "uncertain" };
    if (task.delivery_generation > row.delivery_generation) {
      await client.query(
        `UPDATE deliveries SET delivery_generation = $3, status = 'received', attempts = 0,
           reconciles = 0, provider_ref = NULL, last_error = NULL, terminal_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND intent_id = $2`,
        [task.tenant_id, task.intent_id, task.delivery_generation],
      );
    }
    await setStatus(client, task, "failed", null, OPTIONAL_HOLD_EXPIRED);
    await addAttempt(client, task, "hold", "failed", OPTIONAL_HOLD_EXPIRED);
    return { action: "failed" };
  });
}

async function setStatus(
  client: PoolClient,
  task: Task,
  status: Status,
  providerRef: string | null,
  error: string | null,
  reconciled = 0,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE deliveries SET status = $3, provider_ref = coalesce($4, provider_ref), last_error = $5, reconciles = reconciles + $6,
       updated_at = now(), terminal_at = CASE WHEN $3 IN ('sent', 'failed', 'suppressed') THEN now() END
     WHERE tenant_id = $1 AND intent_id = $2 AND delivery_generation = $7 AND status NOT IN ('sent', 'failed', 'suppressed')`,
    [
      task.tenant_id,
      task.intent_id,
      status,
      providerRef,
      error?.slice(0, 500) ?? null,
      reconciled,
      task.delivery_generation,
    ],
  );
  return result.rowCount === 1;
}

export interface Outcome {
  status: Exclude<Status, "received" | "in_progress">;
  kind: "send" | "reconcile";
  providerRef?: string;
  error?: string;
}

/**
 * Records the provider outcome. Returns the final status: if another delivery already
 * committed a terminal result, that result wins and this outcome is only logged.
 */
export async function finishDelivery(
  pool: Pool,
  task: Task,
  outcome: Outcome,
  admittedClient?: PoolClient,
): Promise<Status | "stale"> {
  const finish = async (client: PoolClient): Promise<Status | "stale"> => {
    const { rows } = await client.query<Row>(
      `SELECT status, delivery_generation FROM deliveries WHERE tenant_id = $1 AND intent_id = $2 FOR UPDATE`,
      [task.tenant_id, task.intent_id],
    );
    if (rows[0].delivery_generation !== task.delivery_generation)
      return "stale";
    if (isTerminal(rows[0].status)) return rows[0].status;
    // One UPDATE: once the row is terminal the guard trigger rejects any further change.
    await setStatus(
      client,
      task,
      outcome.status,
      outcome.providerRef ?? null,
      outcome.error ?? null,
      outcome.kind === "reconcile" ? 1 : 0,
    );
    await addAttempt(
      client,
      task,
      outcome.kind,
      outcome.status,
      outcome.error ?? null,
    );
    return outcome.status;
  };
  return admittedClient
    ? finish(admittedClient)
    : withTenant(pool, task.tenant_id, finish);
}

/** Optimistic preference update: returns false on a stale expectedVersion (HTTP 409). */
export async function setPreference(
  pool: Pool,
  tenantId: string,
  channel: Channel,
  enabled: boolean,
  minSeverity: "warning" | "critical",
  expectedVersion: number | null,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const result =
      expectedVersion === null
        ? await client.query(
            `INSERT INTO notification_preferences (tenant_id, channel, enabled, min_severity)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [tenantId, channel, enabled, minSeverity],
          )
        : await client.query(
            `UPDATE notification_preferences SET enabled = $3, min_severity = $4,
               version = version + 1, updated_at = now()
             WHERE tenant_id = $1 AND channel = $2 AND version = $5`,
            [tenantId, channel, enabled, minSeverity, expectedVersion],
          );
    return result.rowCount === 1;
  });
}
