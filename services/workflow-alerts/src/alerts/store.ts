import { outboxRowToEvent, type DomainEvent } from "@greenguard/contracts";
import type { Tx } from "../db/client.js";
import { deterministicId } from "./ids.js";
import type { AlertRule, Episode, EpisodeState } from "./policy.js";

export const LIFECYCLE_TOPIC = "greenguard.alerts.lifecycle.v1";

export type TransitionType =
  "opened" | "updated" | "acknowledged" | "escalated" | "resolved";

export interface Actor {
  type: "system" | "user";
  id: string;
}

// Envelope context carried from the cause (risk event or HTTP command).
export interface Cause {
  causeId: string;
  correlationId: string;
  traceparent: string;
  actor: Actor;
}

interface EpisodeRow {
  tenant_id: string;
  episode_id: string;
  rule_id: string;
  monitored_resource_id: string;
  open_window_start: Date;
  state: EpisodeState;
  severity: Episode["severity"];
  score: number;
  version: bigint;
  opened_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  resolved_at: Date | null;
  escalation_level: number;
  escalated_at: Date | null;
  current_assessment_id: string | null;
}

const toEpisode = (r: EpisodeRow): Episode => ({
  tenantId: r.tenant_id,
  episodeId: r.episode_id,
  ruleId: r.rule_id,
  resourceId: r.monitored_resource_id,
  openWindowStart: r.open_window_start,
  state: r.state,
  severity: r.severity,
  score: r.score,
  version: BigInt(r.version),
  openedAt: r.opened_at,
  acknowledgedAt: r.acknowledged_at,
  acknowledgedBy: r.acknowledged_by,
  resolvedAt: r.resolved_at,
  escalationLevel: r.escalation_level,
  escalatedAt: r.escalated_at,
  currentAssessmentId: r.current_assessment_id,
});

export async function ensureRule(tx: Tx, rule: AlertRule): Promise<AlertRule> {
  await tx.$executeRaw`
    INSERT INTO alert_rules (tenant_id, rule_id, rule_key, resource_kind, open_score, clear_score, escalation_timeout_seconds)
    VALUES (${rule.tenantId}::uuid, ${rule.ruleId}::uuid, ${rule.ruleKey}, 'bin', ${rule.openScore}, ${rule.clearScore}, ${rule.escalationTimeoutSeconds})
    ON CONFLICT (tenant_id, rule_key) DO NOTHING`;
  return findRule(tx, rule.tenantId, rule.ruleId) as Promise<AlertRule>;
}

export async function findRule(
  tx: Tx,
  tenantId: string,
  ruleId: string,
): Promise<AlertRule | undefined> {
  const rows = await tx.$queryRaw<
    {
      rule_key: string;
      open_score: number;
      clear_score: number;
      escalation_timeout_seconds: number;
    }[]
  >`SELECT rule_key, open_score, clear_score, escalation_timeout_seconds
      FROM alert_rules WHERE tenant_id = ${tenantId}::uuid AND rule_id = ${ruleId}::uuid`;
  const [row] = rows;
  return (
    row && {
      tenantId,
      ruleId,
      ruleKey: row.rule_key,
      openScore: row.open_score,
      clearScore: row.clear_score,
      escalationTimeoutSeconds: row.escalation_timeout_seconds,
    }
  );
}

// Advances the per-device watermark; returns false for a stale or repeated version.
export async function advanceStream(
  tx: Tx,
  tenantId: string,
  deviceId: string,
  version: bigint,
  now: Date,
): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`
    INSERT INTO risk_stream_positions (tenant_id, device_id, assessment_version, updated_at)
    VALUES (${tenantId}::uuid, ${deviceId}::uuid, ${version}, ${now})
    ON CONFLICT (tenant_id, device_id) DO UPDATE
      SET assessment_version = EXCLUDED.assessment_version, updated_at = EXCLUDED.updated_at
      WHERE risk_stream_positions.assessment_version < EXCLUDED.assessment_version
    RETURNING device_id`;
  return rows.length === 1;
}

export async function lockActiveEpisode(
  tx: Tx,
  tenantId: string,
  ruleId: string,
  resourceId: string,
): Promise<Episode | undefined> {
  const rows = await tx.$queryRaw<EpisodeRow[]>`
    SELECT * FROM alert_episodes
     WHERE tenant_id = ${tenantId}::uuid AND rule_id = ${ruleId}::uuid
       AND monitored_resource_id = ${resourceId}::uuid AND state <> 'resolved'
     FOR UPDATE`;
  return rows.map(toEpisode)[0];
}

export async function lockEpisode(
  tx: Tx,
  tenantId: string,
  episodeId: string,
): Promise<Episode | undefined> {
  const rows = await tx.$queryRaw<EpisodeRow[]>`
    SELECT * FROM alert_episodes
     WHERE tenant_id = ${tenantId}::uuid AND episode_id = ${episodeId}::uuid
     FOR UPDATE`;
  return rows.map(toEpisode)[0];
}

export async function lockEpisodeForAssessment(
  tx: Tx,
  tenantId: string,
  assessmentId: string,
): Promise<Episode | undefined> {
  const rows = await tx.$queryRaw<EpisodeRow[]>`
    SELECT * FROM alert_episodes
     WHERE tenant_id = ${tenantId}::uuid
       AND current_assessment_id = ${assessmentId}::uuid
       AND state <> 'resolved'
     FOR UPDATE`;
  return rows.map(toEpisode)[0];
}

export async function readEpisode(
  tx: Tx,
  tenantId: string,
  episodeId: string,
): Promise<Episode | undefined> {
  const rows = await tx.$queryRaw<EpisodeRow[]>`
    SELECT * FROM alert_episodes
     WHERE tenant_id = ${tenantId}::uuid AND episode_id = ${episodeId}::uuid`;
  return rows.map(toEpisode)[0];
}

export interface Page {
  limit: number;
  after?: string;
  state?: EpisodeState;
}

// Keyset pagination on episode_id; the tenant filter is explicit on top of RLS.
export async function listEpisodes(
  tx: Tx,
  tenantId: string,
  page: Page,
): Promise<Episode[]> {
  const after = page.after ?? "00000000-0000-0000-0000-000000000000";
  const rows = await tx.$queryRaw<EpisodeRow[]>`
    SELECT * FROM alert_episodes
     WHERE tenant_id = ${tenantId}::uuid AND episode_id > ${after}::uuid
       AND (${page.state ?? null}::text IS NULL OR state = ${page.state ?? null}::text)
     ORDER BY episode_id LIMIT ${page.limit}`;
  return rows.map(toEpisode);
}

export async function insertEpisode(tx: Tx, e: Episode): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO alert_episodes (tenant_id, episode_id, rule_id, monitored_resource_id, open_window_start,
      state, severity, score, version, opened_at, updated_at, current_assessment_id)
    VALUES (${e.tenantId}::uuid, ${e.episodeId}::uuid, ${e.ruleId}::uuid, ${e.resourceId}::uuid,
      ${e.openWindowStart}, ${e.state}, ${e.severity}, ${e.score}, ${e.version}, ${e.openedAt}, ${e.openedAt}, ${e.currentAssessmentId}::uuid)`;
}

// The only episode write path: bumps nothing itself; callers pass the next version.
export async function saveEpisode(
  tx: Tx,
  e: Episode,
  now: Date,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE alert_episodes SET state = ${e.state}, severity = ${e.severity}, score = ${e.score},
      version = ${e.version}, acknowledged_at = ${e.acknowledgedAt}, acknowledged_by = ${e.acknowledgedBy},
      resolved_at = ${e.resolvedAt}, escalation_level = ${e.escalationLevel},
      escalated_at = ${e.escalatedAt}, current_assessment_id = ${e.currentAssessmentId}::uuid, updated_at = ${now}
    WHERE tenant_id = ${e.tenantId}::uuid AND episode_id = ${e.episodeId}::uuid`;
}

const iso = (d: Date | null) => d?.toISOString();

function lifecyclePayload(
  rule: AlertRule,
  e: Episode,
  type: TransitionType,
  cause: Cause,
  at: Date,
) {
  const riskCaused =
    type === "opened" || type === "updated" || type === "resolved";
  return {
    episode_id: e.episodeId,
    episode_version: e.version.toString(),
    rule_id: rule.ruleId,
    rule_key: rule.ruleKey,
    resource_type: "bin",
    resource_id: e.resourceId,
    state: e.state,
    severity: e.severity,
    score: e.score,
    open_window_start: iso(e.openWindowStart),
    opened_at: iso(e.openedAt),
    transition_at: iso(at),
    acknowledged_by: e.acknowledgedBy,
    escalation_level: e.escalationLevel,
    source_event_id: riskCaused ? cause.causeId : null,
  };
}

// Audit transition and lifecycle outbox event share the caller's transaction. The
// event ID is derived from (tenant, episode, version, type), so a replay that
// reaches the same version writes the same ID instead of a new one.
export async function recordTransition(
  tx: Tx,
  rule: AlertRule,
  e: Episode,
  type: TransitionType,
  from: EpisodeState | null,
  cause: Cause,
  at: Date,
): Promise<DomainEvent> {
  const version = e.version.toString();
  const eventId = deterministicId(e.tenantId, e.episodeId, version, type);
  const event = outboxRowToEvent({
    eventId,
    tenantId: e.tenantId,
    aggregateType: "alert_episode",
    aggregateId: e.episodeId,
    aggregateVersion: e.version,
    eventType: `alert.${type}`,
    schemaVersion: 1,
    occurredAt: at,
    correlationId: cause.correlationId,
    causationId: cause.causeId,
    traceparent: cause.traceparent,
    payload: lifecyclePayload(rule, e, type, cause, at),
  });
  await tx.$executeRaw`
    INSERT INTO alert_transitions (tenant_id, transition_id, episode_id, episode_version, transition_type,
      from_state, to_state, actor_type, actor_id, cause_id, event_id, occurred_at)
    VALUES (${e.tenantId}::uuid, ${eventId}::uuid, ${e.episodeId}::uuid, ${e.version}, ${type},
      ${from}, ${e.state}, ${cause.actor.type}, ${cause.actor.id}, ${cause.causeId}::uuid, ${eventId}::uuid, ${at})`;
  await tx.$executeRaw`
    INSERT INTO outbox_events (event_id, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type,
      schema_version, occurred_at, correlation_id, causation_id, traceparent, payload)
    VALUES (${eventId}::uuid, ${e.tenantId}::uuid, 'alert_episode', ${e.episodeId}::uuid, ${e.version},
      ${event.event_type}, 1, ${at}, ${cause.correlationId}::uuid, ${cause.causeId}::uuid,
      ${cause.traceparent}, ${JSON.stringify(event.payload)}::jsonb)`;
  return event;
}

// No-op receipt: a stale escalation leaves an audit row but no event or state change.
// Deterministic per episode version, so repeated sweeps do not multiply receipts.
export async function recordSuppressedEscalation(
  tx: Tx,
  e: Episode,
  cause: Cause,
  at: Date,
): Promise<string> {
  const transitionId = deterministicId(
    e.tenantId,
    e.episodeId,
    e.version.toString(),
    "escalation_suppressed",
  );
  await tx.$executeRaw`
    INSERT INTO alert_transitions (tenant_id, transition_id, episode_id, episode_version, transition_type,
      from_state, to_state, actor_type, actor_id, cause_id, event_id, occurred_at)
    VALUES (${e.tenantId}::uuid, ${transitionId}::uuid, ${e.episodeId}::uuid, ${e.version},
      'escalation_suppressed', ${e.state}, ${e.state}, ${cause.actor.type}, ${cause.actor.id},
      ${cause.causeId}::uuid, NULL, ${at})
    ON CONFLICT (tenant_id, transition_id) DO NOTHING`;
  return transitionId;
}
