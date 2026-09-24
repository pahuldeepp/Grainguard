import { isDeepStrictEqual } from "node:util";
import { validateEvent, type DomainEvent } from "@greenguard/contracts";
import type { Db, Tx } from "../db/client.js";
import { lockKey, withTenant } from "../db/tenant.js";
import {
  applyRisk,
  invalidateRisk,
  type RiskEffect,
} from "../alerts/lifecycle.js";
import type { RiskSeverity } from "../alerts/policy.js";

export const CONSUMER_NAME = "workflow-alerts.risk-assessed";

export type HandleResult =
  | { status: "applied"; effect: RiskEffect }
  | { status: "duplicate"; effect: RiskEffect }
  | { status: "invalid"; errors: string[] }
  | { status: "conflict"; errors: string[] };

export interface HandleOptions {
  now?: () => Date;
  // Test seam: runs inside the transaction after every write, before COMMIT.
  beforeCommit?: () => Promise<void> | void;
}

function riskInput(event: DomainEvent) {
  const p = event.payload;
  return {
    eventId: event.event_id,
    tenantId: event.tenant_id,
    deviceId: p["device_id"] as string,
    binId: p["bin_id"] as string,
    assessmentVersion: BigInt(p["assessment_version"] as string),
    assessmentId: p["assessment_id"] as string,
    occurredAt: new Date(event.occurred_at),
    correlationId: event.correlation_id,
    traceparent: event.traceparent,
    signal: {
      score: p["score"] as number | null,
      severity: p["severity"] as RiskSeverity,
      alertEligible: p["alert_eligible"] as boolean,
    },
  };
}

async function inboxEntry(tx: Tx, event: DomainEvent) {
  await lockKey(tx, `${CONSUMER_NAME}:${event.tenant_id}:${event.event_id}`);
  const [row] = await tx.$queryRaw<{ event: unknown; effect: RiskEffect }[]>`
    SELECT event, effect FROM consumer_inbox
     WHERE consumer_name = ${CONSUMER_NAME} AND tenant_id = ${event.tenant_id}::uuid
       AND event_id = ${event.event_id}::uuid`;
  return row;
}

// Inbox receipt, rule evaluation, episode change, audit transition and lifecycle
// outbox commit together in one tenant transaction. A duplicate delivery returns the
// original effect; the same event ID with different content is a conflict for
// quarantine and never overwrites the stored effect.
export async function handleRiskEvent(
  db: Db,
  input: unknown,
  options: HandleOptions = {},
): Promise<HandleResult> {
  const validated = validateEvent(input);
  if (!validated.ok) return { status: "invalid", errors: validated.errors };
  const { event } = validated;
  if (
    event.event_type !== "risk.assessed" &&
    event.event_type !== "risk.assessment_invalidated"
  )
    return {
      status: "invalid",
      errors: [`unexpected event_type ${event.event_type}`],
    };
  const now = (options.now ?? (() => new Date()))();
  return withTenant(db, event.tenant_id, async (tx) => {
    const existing = await inboxEntry(tx, event);
    if (existing)
      return isDeepStrictEqual(existing.event, event)
        ? { status: "duplicate", effect: existing.effect }
        : {
            status: "conflict",
            errors: ["event_id was already processed with different content"],
          };
    const risk = riskInput(event);
    const effect =
      event.event_type === "risk.assessed"
        ? await applyRisk(tx, risk, now)
        : await invalidateRisk(tx, risk, now);
    await tx.$executeRaw`
      INSERT INTO consumer_inbox (consumer_name, tenant_id, event_id, event, effect, processed_at)
      VALUES (${CONSUMER_NAME}, ${event.tenant_id}::uuid, ${event.event_id}::uuid,
        ${JSON.stringify(event)}::jsonb, ${JSON.stringify(effect)}::jsonb, ${now})`;
    await options.beforeCommit?.();
    return { status: "applied", effect };
  });
}
