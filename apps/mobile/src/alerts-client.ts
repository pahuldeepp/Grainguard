import { GraphqlClient } from "./graphql.js";
import type { AccessSource, GraphqlDeps } from "./graphql.js";
import { IdentityChangedError } from "./session.js";
import type { Identity } from "./session.js";

// Must stay byte-identical to services/bff/src/query-policy.ts; a test
// compares them, because the BFF only accepts persisted operations.
export const operations = {
  alertList: `query AlertList($limit: Int!, $after: String, $state: String) { alerts(limit: $limit, after: $after, state: $state) { items { alertId ruleId binId state severity score version openedAt acknowledgedAt escalationLevel } nextCursor } }`,
  alertDetail: `query AlertDetail($id: ID!) { alert(id: $id) { alertId ruleId binId state severity score version openedAt acknowledgedAt acknowledgedBy escalationLevel } }`,
  acknowledgeAlert: `mutation AcknowledgeAlert($id: ID!, $version: String!, $idempotencyKey: String!) { acknowledgeAlert(id: $id, version: $version, idempotencyKey: $idempotencyKey) { episodeId state version eventId } }`,
} as const;

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
  acknowledgedBy?: string | null;
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

const PAGE_SIZE = 25;

export class AlertsClient {
  private readonly graphql: GraphqlClient;
  private cache = new Map<string, AlertPage>();

  constructor(
    endpoint: string,
    private readonly session: AccessSource,
    deps: GraphqlDeps,
  ) {
    this.graphql = new GraphqlClient(endpoint, session, deps);
  }

  // Called when the session is cleared (sign-out, tenant switch).
  clearCache(): void {
    this.cache = new Map();
  }

  async list(after?: string, state?: string): Promise<AlertPage> {
    // The tenant comes from the verified session, never from a payload.
    const { tenantId } = await this.session.getAccessToken();
    const key = JSON.stringify([tenantId, after ?? null, state ?? null]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const data = await this.graphql.execute<{ alerts: AlertPage }>(
      operations.alertList,
      {
        limit: PAGE_SIZE,
        ...(after ? { after } : {}),
        ...(state ? { state } : {}),
      },
    );
    this.cache.set(key, data.alerts);
    return data.alerts;
  }

  async detail(id: string): Promise<AlertView | null> {
    const data = await this.graphql.execute<{ alert: AlertView | null }>(
      operations.alertDetail,
      { id },
    );
    return data.alert;
  }

  // `expected` pins the identity the command was authored under: a queued
  // acknowledgement is never sent with a different tenant's or user's token.
  async acknowledge(
    id: string,
    version: string,
    idempotencyKey: string,
    expected: Identity,
  ): Promise<AlertAcknowledgement> {
    const grant = await this.session.getAccessToken();
    if (
      grant.tenantId !== expected.tenantId ||
      grant.subject !== expected.subject
    )
      throw new IdentityChangedError();
    const data = await this.graphql.execute<{
      acknowledgeAlert: AlertAcknowledgement;
    }>(operations.acknowledgeAlert, { id, version, idempotencyKey });
    this.cache = new Map();
    return data.acknowledgeAlert;
  }
}
