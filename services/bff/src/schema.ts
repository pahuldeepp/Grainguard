import { ApolloServer } from "@apollo/server";
import { GraphQLError } from "graphql";
import { AuthError, type Principal } from "@greenguard/tenant-auth";
import { ProvisioningClient, UpstreamError } from "./provisioning.js";
import { ReadClient, ReadUpstreamError } from "./read-client.js";
import { AlertClient, AlertUpstreamError } from "./alerts.js";
import type DataLoader from "dataloader";

export interface BffContext {
  principal: Principal;
  authorization: string;
  traceparent?: string;
  provisioning: ProvisioningClient;
  read?: ReadClient;
  alerts?: AlertClient;
  deviceLoader?: DataLoader<string, Record<string, unknown> | null>;
}

export const typeDefs = `#graphql
  type ProvisioningAudit { version: Int!, action: String!, actorSub: String, reason: String, recordedAt: String! }
  type ProvisioningSaga { tenantId: ID!, sagaId: ID!, deviceId: ID!, assetId: ID!, state: String!, version: Int!, fencingToken: Int!, deadlineAt: String! }
  type ProvisioningStatus { saga: ProvisioningSaga!, history: [ProvisioningAudit!]! }
  type DeviceView { deviceId: ID!, siteId: ID, binId: ID, name: String, status: String, projectedAt: String }
  type DevicePage { items: [DeviceView!]!, nextCursor: String }
  type ReadingView { readingId: ID!, deviceId: ID!, eventId: ID, observedAt: String!, receivedAt: String!, projectedAt: String, temperatureC: Float, relativeHumidityPercent: Float, streamVersion: String, inventoryEnrichment: String }
  type RollupView { bucketStart: String!, sampleCount: Int!, avgTemperatureC: Float, avgRelativeHumidityPercent: Float }
  type SessionView { subject: ID!, tenantId: ID!, roles: [String!]! }
  type AlertView { alertId: ID!, ruleId: ID!, binId: ID!, state: String!, severity: String!, score: Float!, version: String!, openWindowStart: String!, openedAt: String!, acknowledgedAt: String, acknowledgedBy: String, resolvedAt: String, escalationLevel: Int! }
  type AlertPage { items: [AlertView!]!, nextCursor: String }
  type AlertAcknowledgement { episodeId: ID!, state: String!, version: String!, eventId: ID! }
  type DeviceChange { deviceId: ID!, readingId: ID, projectedAt: String, streamVersion: String }
  type Query {
    session: SessionView!
    provisioningStatus(id: ID!): ProvisioningStatus!
    device(id: ID!): DeviceView
    reading(id: ID!): ReadingView
    siteDevices(siteId: ID!, limit: Int!, after: String): DevicePage!
    latestReading(deviceId: ID!): ReadingView
    readingHistory(deviceId: ID!, from: String!, to: String!, limit: Int!): [ReadingView!]!
    searchDevices(query: String!, limit: Int!): [DeviceView!]!
    readingRollups(deviceId: ID!, from: String!, to: String!, limit: Int!, bucket: String!): [RollupView!]!
    alerts(limit: Int!, after: String, state: String): AlertPage!
    alert(id: ID!): AlertView
  }
  type Mutation {
    startProvisioning(deviceId: ID!, assetId: ID!, idempotencyKey: String!): ProvisioningSaga!
    redriveProvisioning(id: ID!, reason: String!): ProvisioningSaga!
    acknowledgeAlert(id: ID!, version: String!, idempotencyKey: String!): AlertAcknowledgement!
  }
  type Subscription { deviceChanged(deviceId: ID!): DeviceChange! }
`;

function translate(error: unknown): never {
  if (
    error instanceof UpstreamError ||
    error instanceof ReadUpstreamError ||
    error instanceof AlertUpstreamError
  ) {
    throw new GraphQLError(error.code, {
      extensions: { code: error.code, httpStatus: error.status },
    });
  }
  if (error instanceof AuthError)
    throw new GraphQLError(error.code, {
      extensions: { code: error.code, httpStatus: error.status },
    });
  console.error("BFF upstream request failed", error);
  throw new GraphQLError("upstream_unavailable", {
    extensions: { code: "upstream_unavailable", httpStatus: 503 },
  });
}

function boundedLimit(value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new GraphQLError(`limit must be between 1 and ${max}`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
}

const saga = (value: Record<string, unknown>) => ({
  tenantId: value.TenantID,
  sagaId: value.SagaID,
  deviceId: value.DeviceID,
  assetId: value.AssetID,
  state: value.State,
  version: value.Version,
  fencingToken: value.FencingToken,
  deadlineAt: value.DeadlineAt,
});

export const resolvers = {
  Query: {
    async alerts(
      _: unknown,
      args: { limit: number; after?: string; state?: string },
      context: BffContext,
    ) {
      try {
        return await requiredAlerts(context).list(
          context.principal,
          context.authorization,
          args.limit,
          args.after,
          args.state,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async alert(_: unknown, { id }: { id: string }, context: BffContext) {
      try {
        return await requiredAlerts(context).get(
          context.principal,
          context.authorization,
          id,
        );
      } catch (error) {
        return translate(error);
      }
    },
    // Verified identity only (ADR-0014 membership mapping); lets the UI hide
    // actions the caller's role cannot perform. The API still enforces roles.
    session(_: unknown, __: unknown, context: BffContext) {
      return {
        subject: context.principal.subject,
        tenantId: context.principal.tenantId,
        roles: context.principal.roles,
      };
    },
    async device(_: unknown, { id }: { id: string }, context: BffContext) {
      try {
        if (context.deviceLoader) return await context.deviceLoader.load(id);
        return await requiredRead(context).device(context.authorization, id);
      } catch (error) {
        return translate(error);
      }
    },
    async reading(_: unknown, { id }: { id: string }, context: BffContext) {
      try {
        return await requiredRead(context).reading(context.authorization, id);
      } catch (error) {
        return translate(error);
      }
    },
    async siteDevices(
      _: unknown,
      args: { siteId: string; limit: number; after?: string },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      try {
        return await requiredRead(context).siteDevices(
          context.authorization,
          args.siteId,
          args.limit,
          args.after,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async latestReading(
      _: unknown,
      { deviceId }: { deviceId: string },
      context: BffContext,
    ) {
      try {
        return await requiredRead(context).latest(
          context.authorization,
          deviceId,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async readingHistory(
      _: unknown,
      args: { deviceId: string; from: string; to: string; limit: number },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      try {
        return await requiredRead(context).history(context.authorization, args);
      } catch (error) {
        return translate(error);
      }
    },
    async searchDevices(
      _: unknown,
      args: { query: string; limit: number },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 50);
      try {
        return await requiredRead(context).search(
          context.authorization,
          args.query,
          args.limit,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async readingRollups(
      _: unknown,
      args: {
        deviceId: string;
        from: string;
        to: string;
        limit: number;
        bucket: string;
      },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      if (args.bucket !== "hour" && args.bucket !== "day")
        throw new GraphQLError("invalid bucket", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      try {
        return await requiredRead(context).rollups(context.authorization, {
          ...args,
          bucket: args.bucket,
        });
      } catch (error) {
        return translate(error);
      }
    },
    async provisioningStatus(
      _: unknown,
      { id }: { id: string },
      context: BffContext,
    ) {
      try {
        const status = await context.provisioning.status(
          context.principal,
          context.authorization,
          id,
          context.traceparent,
        );
        return {
          saga: saga(status.saga as unknown as Record<string, unknown>),
          history: status.history.map((entry) => ({
            version: entry.version,
            action: entry.action,
            actorSub: entry.actor_sub,
            reason: entry.reason,
            recordedAt: entry.recorded_at,
          })),
        };
      } catch (error) {
        return translate(error);
      }
    },
  },
  Mutation: {
    async acknowledgeAlert(
      _: unknown,
      args: { id: string; version: string; idempotencyKey: string },
      context: BffContext,
    ) {
      try {
        return await requiredAlerts(context).acknowledge(
          context.principal,
          context.authorization,
          args.id,
          args.version,
          args.idempotencyKey,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async startProvisioning(
      _: unknown,
      args: { deviceId: string; assetId: string; idempotencyKey: string },
      context: BffContext,
    ) {
      try {
        return saga(
          (await context.provisioning.start(
            context.principal,
            context.authorization,
            args.deviceId,
            args.assetId,
            args.idempotencyKey,
            context.traceparent,
          )) as unknown as Record<string, unknown>,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async redriveProvisioning(
      _: unknown,
      { id, reason }: { id: string; reason: string },
      context: BffContext,
    ) {
      try {
        return saga(
          (await context.provisioning.redrive(
            context.principal,
            context.authorization,
            id,
            reason,
            context.traceparent,
          )) as unknown as Record<string, unknown>,
        );
      } catch (error) {
        return translate(error);
      }
    },
  },
};

function requiredRead(context: BffContext): ReadClient {
  if (!context.read) throw new ReadUpstreamError(503, "read_api_unavailable");
  return context.read;
}

function requiredAlerts(context: BffContext): AlertClient {
  if (!context.alerts)
    throw new AlertUpstreamError(503, "alerts_api_unavailable");
  return context.alerts;
}

export function createApolloServer(): ApolloServer<BffContext> {
  return new ApolloServer<BffContext>({
    typeDefs,
    resolvers,
    introspection: false,
    includeStacktraceInErrorResponses: false,
  });
}
