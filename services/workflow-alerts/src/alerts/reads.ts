import type { TransitionType } from "./store.js";
import type { Tx } from "../db/client.js";
import type { Include, Position } from "../api/history.js";

export interface RuleDto {
  ruleId: string;
  ruleKey: string;
  resourceKind: string;
  openScore: number;
  clearScore: number;
  escalationTimeoutSeconds: number;
}
export async function readRules(
  tx: Tx,
  tenantId: string,
  ids: string[],
): Promise<RuleDto[]> {
  const rows = await tx.$queryRaw<
    {
      rule_id: string;
      rule_key: string;
      resource_kind: string;
      open_score: number;
      clear_score: number;
      escalation_timeout_seconds: number;
    }[]
  >`
    SELECT rule_id, rule_key, resource_kind, open_score, clear_score, escalation_timeout_seconds
    FROM alert_rules WHERE tenant_id = ${tenantId}::uuid AND rule_id = ANY(${ids}::uuid[]) ORDER BY rule_id`;
  return rows.map((r) => ({
    ruleId: r.rule_id,
    ruleKey: r.rule_key,
    resourceKind: r.resource_kind,
    openScore: r.open_score,
    clearScore: r.clear_score,
    escalationTimeoutSeconds: r.escalation_timeout_seconds,
  }));
}

export interface TransitionRow {
  transition_id: string;
  episode_version: bigint;
  transition_type: TransitionType | "escalation_suppressed";
  from_state: string | null;
  to_state: string;
  actor_type: "system" | "user";
  actor_id: string;
  actor_issuer: string | null;
  occurred_at_text: string;
}

export async function readTransitions(
  tx: Tx,
  tenantId: string,
  alertId: string,
  limit: number,
  include: Include,
  after?: Position,
) {
  // Keep microseconds as text: JS Date would lose the ordering position on time ties.
  return tx.$queryRaw<TransitionRow[]>`
    SELECT transition_id, episode_version, transition_type, from_state, to_state, actor_type, actor_id, actor_issuer,
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_text
    FROM alert_transitions WHERE tenant_id = ${tenantId}::uuid AND episode_id = ${alertId}::uuid
      AND (${include} = 'all' OR transition_type <> 'escalation_suppressed')
      AND (${after?.version ?? null}::bigint IS NULL OR
        (episode_version, occurred_at, transition_id) > (${after?.version ?? null}::bigint, ${after?.occurredAt ?? null}::timestamptz, ${after?.transitionId ?? null}::uuid))
    ORDER BY episode_version, occurred_at, transition_id LIMIT ${limit + 1}`;
}

export async function lifecycleComplete(
  tx: Tx,
  tenantId: string,
  alertId: string,
  version: bigint,
): Promise<boolean> {
  const [coverage] = await tx.$queryRaw<{ complete: boolean }[]>`
    SELECT COALESCE(bool_or(transition_type = 'opened' AND episode_version = 1), false)
      AND count(DISTINCT episode_version) = ${version}::bigint
      AND min(episode_version) = 1 AND max(episode_version) = ${version}::bigint AS complete
    FROM alert_transitions WHERE tenant_id = ${tenantId}::uuid AND episode_id = ${alertId}::uuid
      AND transition_type <> 'escalation_suppressed'`;
  return coverage.complete === true;
}
