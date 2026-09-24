import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DomainEvent } from "@greenguard/contracts";
import type { Db, Tx } from "../db/client.js";
import { lockKey, withTenant } from "../db/tenant.js";
import {
  AlertNotFoundError,
  IdempotencyConflictError,
  InvalidStateError,
  VersionConflictError,
} from "./errors.js";
import { deterministicId } from "./ids.js";
import { currentTraceparent } from "./trace.js";
import {
  decide,
  defaultRule,
  escalationDue,
  type AlertRule,
  type Decision,
  type Episode,
  type RiskSignal,
} from "./policy.js";
import {
  advanceStream,
  ensureRule,
  findRule,
  lockActiveEpisode,
  lockEpisodeForAssessment,
  lockEpisode,
  recordSuppressedEscalation,
  recordTransition,
  saveEpisode,
  insertEpisode,
  type Cause,
} from "./store.js";

export interface RiskInput {
  eventId: string;
  tenantId: string;
  deviceId: string;
  binId: string;
  assessmentVersion: bigint;
  assessmentId: string;
  occurredAt: Date;
  correlationId: string;
  traceparent: string;
  signal: RiskSignal;
}

export interface RiskEffect {
  outcome: "applied" | "no_change" | "stale";
  episodeId?: string;
  eventIds: string[];
}

const SYSTEM = { type: "system", id: "workflow-alerts" } as const;

function openEpisode(
  rule: AlertRule,
  input: RiskInput,
  d: Extract<Decision, { kind: "open" }>,
  now: Date,
): Episode {
  const windowStart = input.occurredAt;
  return {
    tenantId: input.tenantId,
    episodeId: deterministicId(
      input.tenantId,
      rule.ruleId,
      input.binId,
      windowStart.toISOString(),
    ),
    ruleId: rule.ruleId,
    resourceId: input.binId,
    openWindowStart: windowStart,
    state: "open",
    severity: d.severity,
    score: d.score,
    version: 1n,
    openedAt: now,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    escalationLevel: 0,
    escalatedAt: null,
    currentAssessmentId: input.assessmentId,
  };
}

async function applyDecision(
  tx: Tx,
  rule: AlertRule,
  active: Episode | undefined,
  d: Decision,
  input: RiskInput,
  now: Date,
): Promise<DomainEvent | undefined> {
  const cause: Cause = {
    causeId: input.eventId,
    correlationId: input.correlationId,
    traceparent: input.traceparent,
    actor: SYSTEM,
  };
  if (d.kind === "open") {
    const episode = openEpisode(rule, input, d, now);
    await insertEpisode(tx, episode);
    return recordTransition(tx, rule, episode, "opened", null, cause, now);
  }
  if (d.kind === "none" || !active) {
    if (active)
      await tx.$executeRaw`
      UPDATE alert_episodes SET current_assessment_id = ${input.assessmentId}::uuid, updated_at = ${now}
       WHERE tenant_id = ${input.tenantId}::uuid AND episode_id = ${active.episodeId}::uuid`;
    return undefined;
  }
  const next: Episode = {
    ...active,
    version: active.version + 1n,
    score: d.score,
    currentAssessmentId: input.assessmentId,
    ...(d.kind === "update"
      ? { severity: d.severity }
      : { state: "resolved", resolvedAt: now }),
  };
  await saveEpisode(tx, next, now);
  const type = d.kind === "update" ? "updated" : "resolved";
  return recordTransition(tx, rule, next, type, active.state, cause, now);
}

// One tenant transaction per risk event (the caller owns inbox and commit). A
// per-(rule, bin) advisory lock serializes concurrent scores; the per-device
// watermark drops stale or reordered assessments before they touch an episode.
export async function applyRisk(
  tx: Tx,
  input: RiskInput,
  now: Date,
): Promise<RiskEffect> {
  const rule = await ensureRule(tx, defaultRule(input.tenantId));
  await lockKey(tx, `alerts:${input.tenantId}:${rule.ruleId}:${input.binId}`);
  const fresh = await advanceStream(
    tx,
    input.tenantId,
    input.deviceId,
    input.assessmentVersion,
    now,
  );
  if (!fresh) return { outcome: "stale", eventIds: [] };
  const active = await lockActiveEpisode(
    tx,
    input.tenantId,
    rule.ruleId,
    input.binId,
  );
  const decision = decide(rule, active, input.signal);
  const event = await applyDecision(tx, rule, active, decision, input, now);
  if (!event)
    return { outcome: "no_change", episodeId: active?.episodeId, eventIds: [] };
  return {
    outcome: "applied",
    episodeId: event.aggregate_id,
    eventIds: [event.event_id],
  };
}

// Invalidation is a later version on the same device stream. The watermark
// prevents an old assessment from reopening the alert after this event. An
// intervening newer score may own the episode; only its causal assessment may
// resolve it. Acknowledged episodes are also resolved, cancelling escalation.
export async function invalidateRisk(
  tx: Tx,
  input: Pick<
    RiskInput,
    | "eventId"
    | "tenantId"
    | "deviceId"
    | "binId"
    | "assessmentVersion"
    | "assessmentId"
    | "correlationId"
    | "traceparent"
  >,
  now: Date,
): Promise<RiskEffect> {
  const rule = await ensureRule(tx, defaultRule(input.tenantId));
  await lockKey(tx, `alerts:${input.tenantId}:${rule.ruleId}:${input.binId}`);
  if (
    !(await advanceStream(
      tx,
      input.tenantId,
      input.deviceId,
      input.assessmentVersion,
      now,
    ))
  )
    return { outcome: "stale", eventIds: [] };
  const active = await lockEpisodeForAssessment(
    tx,
    input.tenantId,
    input.assessmentId,
  );
  if (active?.ruleId !== rule.ruleId || active?.resourceId !== input.binId)
    return { outcome: "no_change", eventIds: [] };
  const next: Episode = {
    ...active,
    state: "resolved",
    version: active.version + 1n,
    resolvedAt: now,
  };
  await saveEpisode(tx, next, now);
  const event = await recordTransition(
    tx,
    rule,
    next,
    "resolved",
    active.state,
    {
      causeId: input.eventId,
      correlationId: input.correlationId,
      traceparent: input.traceparent,
      actor: SYSTEM,
    },
    now,
  );
  return {
    outcome: "applied",
    episodeId: next.episodeId,
    eventIds: [event.event_id],
  };
}

export interface CommandContext {
  tenantId: string;
  actorId: string;
  correlationId: string;
  traceparent: string;
  idempotencyKey: string;
}

export interface AcknowledgeResult {
  episodeId: string;
  state: string;
  version: string;
  eventId: string;
}

const ACK_COMMAND = "alert.acknowledge";

async function acknowledgeLocked(
  tx: Tx,
  ctx: CommandContext,
  episodeId: string,
  expectedVersion: bigint,
  now: Date,
): Promise<{ result: AcknowledgeResult; commandId: string }> {
  const episode = await lockEpisode(tx, ctx.tenantId, episodeId);
  if (!episode) throw new AlertNotFoundError();
  if (episode.version !== expectedVersion)
    throw new VersionConflictError(episode.version);
  if (episode.state !== "open") throw new InvalidStateError(episode.state);
  const rule = (await findRule(tx, ctx.tenantId, episode.ruleId)) as AlertRule;
  const next: Episode = {
    ...episode,
    state: "acknowledged",
    version: episode.version + 1n,
    acknowledgedAt: now,
    acknowledgedBy: ctx.actorId,
  };
  await saveEpisode(tx, next, now);
  const commandId = randomUUID();
  const event = await recordTransition(
    tx,
    rule,
    next,
    "acknowledged",
    "open",
    {
      causeId: commandId,
      correlationId: ctx.correlationId,
      traceparent: ctx.traceparent,
      actor: { type: "user", id: ctx.actorId },
    },
    now,
  );
  return {
    commandId,
    result: {
      episodeId,
      state: next.state,
      version: next.version.toString(),
      eventId: event.event_id,
    },
  };
}

// Acknowledge exactly once. The Idempotency-Key receipt makes a retried request
// (for example after a client timeout, which is NOT a rejection: the first attempt
// may have committed) return the original outcome. The episode row lock makes a
// racing escalation observe the acknowledgement; If-Match rejects stale callers.
export function acknowledge(
  db: Db,
  ctx: CommandContext,
  episodeId: string,
  expectedVersion: bigint,
  now = new Date(),
): Promise<AcknowledgeResult> {
  const request = {
    episodeId,
    expectedVersion: expectedVersion.toString(),
    actorId: ctx.actorId,
  };
  const receiptKey = deterministicId(
    ctx.tenantId,
    ACK_COMMAND,
    ctx.actorId,
    ctx.idempotencyKey,
  );
  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockKey(tx, `${ctx.tenantId}:${ACK_COMMAND}:${receiptKey}`);
    const [receipt] = await tx.$queryRaw<
      { normalized_request: unknown; response_body: AcknowledgeResult }[]
    >`SELECT normalized_request, response_body FROM command_receipts
       WHERE tenant_id = ${ctx.tenantId}::uuid AND command_type = ${ACK_COMMAND}
         AND idempotency_key = ${receiptKey}`;
    if (receipt) {
      if (!isDeepStrictEqual(receipt.normalized_request, request))
        throw new IdempotencyConflictError();
      return receipt.response_body;
    }
    const { result, commandId } = await acknowledgeLocked(
      tx,
      ctx,
      episodeId,
      expectedVersion,
      now,
    );
    await tx.$executeRaw`
      INSERT INTO command_receipts (tenant_id, idempotency_key, command_type, command_id,
        normalized_request, response_body, accepted_at)
      VALUES (${ctx.tenantId}::uuid, ${receiptKey}, ${ACK_COMMAND}, ${commandId}::uuid,
        ${JSON.stringify(request)}::jsonb, ${JSON.stringify(result)}::jsonb, ${now})`;
    return result;
  });
}

export type EscalationOutcome =
  | { outcome: "escalated"; eventId: string; version: string }
  | { outcome: "suppressed"; receiptId: string }
  | { outcome: "not_due" };

// Escalation worker step. It contends with acknowledge on the same row lock, and
// re-reads state under that lock: an episode that is no longer open, or that was
// already escalated, gets a no-op receipt instead of a second effect.
export function escalateIfStillUnacknowledged(
  db: Db,
  episode: Pick<Episode, "tenantId" | "episodeId">,
  now = new Date(),
  traceparent = currentTraceparent(),
): Promise<EscalationOutcome> {
  return withTenant(db, episode.tenantId, async (tx) => {
    const current = await lockEpisode(tx, episode.tenantId, episode.episodeId);
    if (!current) throw new AlertNotFoundError();
    const cause: Cause = {
      causeId: deterministicId(
        current.episodeId,
        current.version.toString(),
        "escalation-check",
      ),
      correlationId: current.episodeId,
      traceparent,
      actor: SYSTEM,
    };
    if (current.state !== "open" || current.escalationLevel > 0) {
      const receiptId = await recordSuppressedEscalation(
        tx,
        current,
        cause,
        now,
      );
      return { outcome: "suppressed", receiptId };
    }
    const rule = (await findRule(
      tx,
      current.tenantId,
      current.ruleId,
    )) as AlertRule;
    if (!escalationDue(rule, current, now)) return { outcome: "not_due" };
    const next: Episode = {
      ...current,
      version: current.version + 1n,
      escalationLevel: 1,
      escalatedAt: now,
    };
    await saveEpisode(tx, next, now);
    const event = await recordTransition(
      tx,
      rule,
      next,
      "escalated",
      "open",
      cause,
      now,
    );
    return {
      outcome: "escalated",
      eventId: event.event_id,
      version: next.version.toString(),
    };
  });
}
