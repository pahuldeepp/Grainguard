import type { AlertView } from '@greenguard/mobile-core';
import { isOpenState } from './format';
import { severityRank } from './theme';

export type AlertFilter = 'open' | 'acknowledged' | 'all';

// Open (or acknowledgement-unsent) alerts: most severe first, then newest.
export function needsAttention(
  alerts: AlertView[],
  pendingIds: ReadonlySet<string>,
): AlertView[] {
  return alerts
    .filter(a => isOpenState(a.state) || pendingIds.has(a.alertId))
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        Date.parse(b.openedAt) - Date.parse(a.openedAt),
    );
}

export function acknowledgedAlerts(
  alerts: AlertView[],
  pendingIds: ReadonlySet<string>,
): AlertView[] {
  return alerts
    .filter(a => !isOpenState(a.state) && !pendingIds.has(a.alertId))
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
}

// The next alert that still needs an acknowledgement, skipping the current one
// and any whose acknowledgement is already queued.
export function nextOpenAlert(
  alerts: AlertView[],
  pendingIds: ReadonlySet<string>,
  currentId: string,
): AlertView | undefined {
  return needsAttention(alerts, pendingIds).find(
    a => a.alertId !== currentId && !pendingIds.has(a.alertId),
  );
}

export interface TimelineEntry {
  label: string;
  when?: string;
  detail?: string;
  // Shown when the backend does not return this fact (never invented).
  note?: string;
}

// Only what the alert queries return: openedAt, escalationLevel, state,
// acknowledgedAt and acknowledgedBy (detail query only).
// The acknowledger is an opaque IdP subject, never shown raw.
export function actorPhrase(
  actor: string | null | undefined,
  you?: string,
): string | undefined {
  if (!actor) return undefined;
  return actor === you ? 'by you' : 'by another operator';
}

export function buildTimeline(alert: AlertView, you?: string): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ label: 'Opened', when: alert.openedAt }];
  if (alert.escalationLevel > 0)
    entries.push({
      label: `Escalated to level ${alert.escalationLevel}`,
      note: 'Time not available yet',
    });
  if (alert.acknowledgedAt)
    entries.push({
      label: 'Acknowledged',
      when: alert.acknowledgedAt,
      detail: actorPhrase(alert.acknowledgedBy, you),
    });
  if (alert.state === 'resolved')
    entries.push({ label: 'Resolved', note: 'Time not available yet' });
  return entries;
}
