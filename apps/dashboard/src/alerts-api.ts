import type { AccessTokenProvider } from "./provisioning";
import { executeOperation } from "./graphql-client";

export interface AlertView {
  alertId: string;
  ruleId: string;
  binId: string;
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

const operations = {
  list: `query AlertList($limit: Int!, $after: String, $state: String) { alerts(limit: $limit, after: $after, state: $state) { items { alertId ruleId binId state severity score version openedAt acknowledgedAt escalationLevel } nextCursor } }`,
  acknowledge: `mutation AcknowledgeAlert($id: ID!, $version: String!, $idempotencyKey: String!) { acknowledgeAlert(id: $id, version: $version, idempotencyKey: $idempotencyKey) { episodeId state version eventId } }`,
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
}
