import type { AccessTokenProvider } from "./provisioning";
import { executeOperation } from "./graphql-client";

export interface AlertView {
  alertId: string;
  ruleId: string;
  binId: string;
  /** Projected facility labels are optional while the read model catches up. */
  binName?: string | null;
  siteName?: string | null;
  state: string;
  severity: string;
  score: number;
  version: string;
  openedAt: string;
  acknowledgedAt: string | null;
  escalationLevel: number;
}

export interface AlertPage {
  items: AlertView[];
  nextCursor: string | null;
}

export interface AlertAcknowledgement {
  episodeId: string;
  state: string;
  version: string;
  eventId: string;
}

export interface AlertHistoryPage {
  alertId: string;
  items: {
    transitionId: string;
    version: string;
    type: string;
    fromState: string | null;
    toState: string;
    occurredAt: string;
    actor: { kind: string; isYou: boolean; handle: string | null };
    cause: { kind: string };
  }[];
  nextCursor: string | null;
  complete: boolean;
  source: { status: string; reasonCode: string | null };
}

export interface AlertNotificationsPage {
  items: {
    intentId: string;
    transitionVersion: string;
    transition: string;
    severity: string | null;
    channel: string;
    deliveryGeneration: number;
    redriveCount: number;
    state: string;
    reasonCode: string | null;
    queuedAt: string | null;
    resolvedAt: string | null;
    dispatchAttempts: number | null;
    providerAttempts: number | null;
    events: { kind: string; outcome: string; recordedAt: string | null }[];
    attemptsTruncated: boolean;
  }[];
  nextCursor: string | null;
  complete: boolean;
  sources: {
    intents: { status: string; reasonCode: string | null };
    warning: { status: string; reasonCode: string | null };
    critical: { status: string; reasonCode: string | null };
    transitions: { status: string; reasonCode: string | null };
  };
}

const operations = {
  list: `query AlertList($limit: Int!, $after: String, $state: String) { alerts(limit: $limit, after: $after, state: $state) { items { alertId ruleId binId state severity score version openedAt acknowledgedAt escalationLevel } nextCursor } }`,
  acknowledge: `mutation AcknowledgeAlert($id: ID!, $version: String!, $idempotencyKey: String!) { acknowledgeAlert(id: $id, version: $version, idempotencyKey: $idempotencyKey) { episodeId state version eventId } }`,
  history: `query AlertHistory($id: ID!, $limit: Int!, $after: String) { alertHistory(id: $id, limit: $limit, after: $after) { alertId items { transitionId version type fromState toState occurredAt actor { kind isYou handle } cause { kind } } nextCursor complete source { status reasonCode } } }`,
  notifications: `query AlertNotifications($id: ID!, $limit: Int!, $after: String) { alertNotifications(id: $id, limit: $limit, after: $after) { items { intentId transitionVersion transition severity channel deliveryGeneration redriveCount state reasonCode queuedAt resolvedAt dispatchAttempts providerAttempts events { kind outcome recordedAt } attemptsTruncated } nextCursor complete sources { intents { status reasonCode } warning { status reasonCode } critical { status reasonCode } transitions { status reasonCode } } } }`,
} as const;

export class AlertsApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  async list(after?: string, state?: string): Promise<AlertPage> {
    const data = await executeOperation<{ alerts: AlertPage }>(
      this.getAccessToken,
      operations.list,
      { limit: 25, ...(after ? { after } : {}), ...(state ? { state } : {}) },
      {
        signIn: "Sign in to view alerts.",
        request: "Alert request failed",
        empty: "Alerts are temporarily unavailable.",
      },
    );
    return data.alerts;
  }

  async acknowledge(id: string, version: string, idempotencyKey: string) {
    const data = await executeOperation<{
      acknowledgeAlert: AlertAcknowledgement;
    }>(
      this.getAccessToken,
      operations.acknowledge,
      { id, version, idempotencyKey },
      {
        signIn: "Sign in to acknowledge alerts.",
        request: "Alert acknowledgement failed",
        empty: "Alert acknowledgement is temporarily unavailable.",
      },
    );
    return data.acknowledgeAlert;
  }

  async history(id: string, after?: string): Promise<AlertHistoryPage> {
    const data = await executeOperation<{ alertHistory: AlertHistoryPage }>(
      this.getAccessToken,
      operations.history,
      { id, limit: 50, ...(after ? { after } : {}) },
      {
        signIn: "Sign in to view alert history.",
        request: "Alert history request failed",
        empty: "Alert history is temporarily unavailable.",
      },
    );
    return data.alertHistory;
  }

  async notifications(
    id: string,
    after?: string,
  ): Promise<AlertNotificationsPage> {
    const data = await executeOperation<{
      alertNotifications: AlertNotificationsPage;
    }>(
      this.getAccessToken,
      operations.notifications,
      { id, limit: 50, ...(after ? { after } : {}) },
      {
        signIn: "Sign in to view notification history.",
        request: "Notification history request failed",
        empty: "Notification history is temporarily unavailable.",
      },
    );
    return data.alertNotifications;
  }
}
