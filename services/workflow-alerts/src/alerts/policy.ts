import { deterministicId } from "./ids.js";

export type EpisodeState = "open" | "acknowledged" | "resolved";
export type AlertSeverity = "warning" | "critical";
export type RiskSeverity =
  "normal" | "warning" | "critical" | "insufficient_data";

export interface AlertRule {
  tenantId: string;
  ruleId: string;
  ruleKey: string;
  openScore: number;
  clearScore: number;
  escalationTimeoutSeconds: number;
}

export interface Episode {
  tenantId: string;
  episodeId: string;
  ruleId: string;
  resourceId: string;
  openWindowStart: Date;
  state: EpisodeState;
  severity: AlertSeverity;
  score: number;
  version: bigint;
  openedAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  escalationLevel: number;
  escalatedAt: Date | null;
  currentAssessmentId: string | null;
}

export interface RiskSignal {
  score: number | null;
  severity: RiskSeverity;
  alertEligible: boolean;
}

// Default policy seeded per tenant on its first risk event. Hysteresis: an episode
// opens at score >= 40 with an alert-eligible severity and resolves only below 25,
// so a score oscillating between 25 and 39 never flaps the alert.
export const DEFAULT_RULE_KEY = "grain-risk-default";
export const defaultRule = (tenantId: string): AlertRule => ({
  tenantId,
  ruleId: deterministicId("alert-rule", tenantId, DEFAULT_RULE_KEY),
  ruleKey: DEFAULT_RULE_KEY,
  openScore: 40,
  clearScore: 25,
  escalationTimeoutSeconds: 900,
});

export type Decision =
  | { kind: "none" }
  | { kind: "open"; severity: AlertSeverity; score: number }
  | { kind: "update"; severity: AlertSeverity; score: number }
  | { kind: "resolve"; score: number };

const alertSeverity = (signal: RiskSignal): AlertSeverity | undefined =>
  signal.alertEligible &&
  (signal.severity === "warning" || signal.severity === "critical")
    ? signal.severity
    : undefined;

// Pure rule evaluation. Insufficient data never opens or resolves an episode.
export function decide(
  rule: AlertRule,
  active: Episode | undefined,
  signal: RiskSignal,
): Decision {
  const { score } = signal;
  if (score === null) return { kind: "none" };
  const severity = alertSeverity(signal);
  if (!active)
    return severity && score >= rule.openScore
      ? { kind: "open", severity, score }
      : { kind: "none" };
  if (score < rule.clearScore) return { kind: "resolve", score };
  const next = severity ?? active.severity;
  return next === active.severity && score === active.score
    ? { kind: "none" }
    : { kind: "update", severity: next, score };
}

export const escalationDue = (rule: AlertRule, episode: Episode, now: Date) =>
  now.getTime() >=
  episode.openedAt.getTime() + rule.escalationTimeoutSeconds * 1000;
