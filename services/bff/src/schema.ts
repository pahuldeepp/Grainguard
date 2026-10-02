import {
  parseWatermark,
  serializeWatermark,
} from "@greenguard/membership-client";
import { ApolloServer } from "@apollo/server";
import { GraphQLError, type GraphQLResolveInfo } from "graphql";
import {
  AuthError,
  requireRole,
  type Principal,
} from "@greenguard/tenant-auth";
import { ProvisioningClient, UpstreamError } from "./provisioning.js";
import { ReadClient, ReadUpstreamError } from "./read-client.js";
import { AlertClient, AlertUpstreamError } from "./alerts.js";
import {
  NotificationClient,
  NotificationUpstreamError,
} from "./notifications.js";
import {
  MlOperationsUpstreamError,
  type MlOperationsClient,
  type MlAction,
} from "./ml-operations.js";
import type DataLoader from "dataloader";

export interface BffContext {
  principal: Principal;
  authorization: string;
  traceparent?: string;
  provisioning: ProvisioningClient;
  read?: ReadClient;
  alerts?: AlertClient;
  notifications?: NotificationClient;
  mlOperations?: MlOperationsClient;
  consistencyToken?: string;
  readDeadline?: number;
  readSignal?: AbortSignal;
  currentReads?: Map<string, ReturnType<ReadClient["deviceCurrent"]>>;
  deviceLoader?: DataLoader<string, Record<string, unknown> | null>;
}

export const typeDefs = `#graphql
  type ProvisioningAudit { version: Int!, action: String!, actorSub: String, reason: String, recordedAt: String! }
  type ProvisioningSaga { tenantId: ID!, sagaId: ID!, deviceId: ID!, assetId: ID!, state: String!, version: Int!, fencingToken: Int!, deadlineAt: String! }
  type ProvisioningStatus { saga: ProvisioningSaga!, history: [ProvisioningAudit!]! }
  type DeviceView { consistencyToken: String, deviceId: ID!, siteId: ID, binId: ID, name: String, status: String, projectedAt: String }
  type DevicePage { consistencyToken: String, items: [DeviceView!]!, nextCursor: String }
  type ReadingView { consistencyToken: String, readingId: ID!, deviceId: ID!, eventId: ID, observedAt: String!, receivedAt: String!, projectedAt: String, temperatureC: Float, relativeHumidityPercent: Float, streamVersion: String, inventoryEnrichment: String }
  type RollupView { consistencyToken: String, bucketStart: String!, sampleCount: Int!, avgTemperatureC: Float, avgRelativeHumidityPercent: Float }
  type BinView { binId: ID!, siteId: ID!, name: String!, siteName: String, projectedAt: String }
  type BinDevice { deviceId: ID!, status: String!, serialNumber: String }
  type BinMetricReading { deviceId: ID!, metric: String!, unit: String!, value: Float!, observedAt: String!, receivedAt: String!, projectedAt: String, readingId: ID!, ageSeconds: Float, stale: Boolean }
  type SensorPlacement { deviceId: ID!, cableId: ID!, cableVersion: String!, sensorId: ID!, position: Int!, depthM: Float, label: String! }
  type SensorReading { deviceId: ID!, sensorId: ID!, cableId: ID!, layoutVersion: String!, position: Int!, depthM: Float, label: String, metric: String!, unit: String!, value: Float!, observedAt: String!, receivedAt: String!, readingId: ID!, ageSeconds: Float, stale: Boolean }
  type BinPolicy { policyId: ID!, policyVersion: String!, grainType: String!, effectiveFrom: String!, effectiveTo: String, measurementThresholds: String!, riskThresholds: String!, calibrated: Boolean!, status: String!, provenance: String!, calibrationEvidence: String }
  type BinReadings { consistencyToken: String, bin: BinView!, devices: [BinDevice!]!, devicesTruncated: Boolean!, readings: [BinMetricReading!]!, layout: [SensorPlacement!]!, sensorReadings: [SensorReading!]!, policies: [BinPolicy!]!, freshness: String! }
  type BinTrendBucket { bucketAt: String!, metric: String!, unit: String!, minValue: Float, averageValue: Float, maxValue: Float, sampleCount: Int!, deviceCount: Int! }
  type BinTrend { consistencyToken: String, bin: BinView, window: String!, resolution: String!, bucketSeconds: Int!, from: String!, to: String!, buckets: [BinTrendBucket!]!, source: String! }
  type SessionView { subject: ID!, tenantId: ID!, roles: [String!]! }
  type AlertView { alertId: ID!, ruleId: ID!, binId: ID!, state: String!, severity: String!, score: Float!, version: String!, openWindowStart: String!, openedAt: String!, acknowledgedAt: String, acknowledgedBy: String, resolvedAt: String, escalationLevel: Int! }
  type AlertActor { kind: String!, isYou: Boolean!, handle: String }
  type AlertV2 { alertId: ID!, ruleId: ID!, binId: ID!, state: String!, severity: String!, score: Float!, version: String!, openWindowStart: String!, openedAt: String!, acknowledgedAt: String, acknowledgedBy: String, escalatedAt: String, resolvedAt: String, escalationLevel: Int!, actor: AlertActor }
  type AlertTransition { transitionId: ID!, version: String!, type: String!, fromState: String, toState: String!, occurredAt: String!, actor: AlertActor!, cause: AlertTransitionCause! }
  type AlertTransitionCause { kind: String! }
  type AlertSourceState { status: String!, reasonCode: String }
  type AlertHistoryPage { alertId: ID!, items: [AlertTransition!]!, nextCursor: String, complete: Boolean!, source: AlertSourceState! }
  type NotificationSourceState { status: String!, reasonCode: String }
  type NotificationSources { intents: NotificationSourceState!, warning: NotificationSourceState!, critical: NotificationSourceState!, transitions: NotificationSourceState! }
  type NotificationEvent { kind: String!, outcome: String!, recordedAt: String }
  type NotificationAttempt { intentId: ID!, transitionVersion: String!, transition: String!, severity: String, channel: String!, deliveryGeneration: Int!, redriveCount: Int!, state: String!, reasonCode: String, queuedAt: String, firstAttemptAt: String, lastAttemptAt: String, resolvedAt: String, dispatchAttempts: Int, providerAttempts: Int, contactVersion: String, events: [NotificationEvent!]!, attemptsTruncated: Boolean! }
  type NotificationAttemptPage { items: [NotificationAttempt!]!, nextCursor: String, sources: NotificationSources!, complete: Boolean! }
  type MlModelStatus { name: String!, version: String!, mode: String!, dataOrigin: String!, productionEligible: Boolean!, status: String! }
  type MlDriftMetric { feature: String!, psi: Float, sampleCount: Int!, status: String! }
  type MlPerformance { status: String!, brierScore: Float, sampleCount: Int!, evaluatedAt: String }
  type MlModelVersion { name: String!, version: String!, mode: String!, dataOrigin: String!, productionEligible: Boolean!, status: String!, createdAt: String! }
  type MlRetrainingStatus { status: String!, runId: String, completedAt: String }
  type MlOperationsSnapshot { capturedAt: String!, scorerReady: Boolean!, predictionsTotal: Int!, inferenceP95Ms: Float, canaryPercentage: Float!, model: MlModelStatus!, models: [MlModelVersion!]!, drift: [MlDriftMetric!]!, performance: MlPerformance!, retraining: MlRetrainingStatus! }
  type MlActionResult { action: String!, accepted: Boolean!, message: String!, runId: String }
  type AlertPage { items: [AlertView!]!, nextCursor: String }
  type AlertPageV2 { items: [AlertV2!]!, nextCursor: String }
  type AlertAcknowledgement { episodeId: ID!, state: String!, version: String!, eventId: ID! }
  type DeviceChange { consistencyToken: String, deviceId: ID!, readingId: ID, projectedAt: String, streamVersion: String }
  type Query {
    session: SessionView!
    provisioningStatus(id: ID!): ProvisioningStatus!
    device(id: ID!, minimumConsistency: String): DeviceView
    reading(id: ID!, minimumConsistency: String): ReadingView
    siteDevices(siteId: ID!, limit: Int!, after: String, minimumConsistency: String): DevicePage!
    latestReading(deviceId: ID!, minimumConsistency: String): ReadingView
    readingHistory(deviceId: ID!, from: String!, to: String!, limit: Int!, minimumConsistency: String): [ReadingView!]!
    searchDevices(query: String!, limit: Int!, minimumConsistency: String): [DeviceView!]!
    readingRollups(deviceId: ID!, from: String!, to: String!, limit: Int!, bucket: String!, minimumConsistency: String): [RollupView!]!
    binReadingsLatest(binId: ID!, minimumConsistency: String): BinReadings
    binReadingsTrend(binId: ID!, window: String!, resolution: String = "AUTO", minimumConsistency: String): BinTrend!
    alerts(limit: Int!, after: String, state: String): AlertPage!
    alert(id: ID!): AlertView
    alertListV2(limit: Int!, after: String, state: String): AlertPageV2!
    alertDetailV2(id: ID!): AlertV2
    alertHistory(id: ID!, limit: Int!, after: String): AlertHistoryPage!
    alertNotifications(id: ID!, limit: Int!, after: String): NotificationAttemptPage!
    mlOperations: MlOperationsSnapshot!
  }
  type Mutation {
    startProvisioning(deviceId: ID!, assetId: ID!, idempotencyKey: String!): ProvisioningSaga!
    redriveProvisioning(id: ID!, reason: String!): ProvisioningSaga!
    acknowledgeAlert(id: ID!, version: String!, idempotencyKey: String!): AlertAcknowledgement!
    promoteMlModel(version: String!): MlActionResult!
    rollbackMlModel(version: String): MlActionResult!
    startMlRetraining: MlActionResult!
  }
  type Subscription { deviceChanged(deviceId: ID!): DeviceChange! }
`;

function translate(error: unknown): never {
  if (
    error instanceof UpstreamError ||
    error instanceof ReadUpstreamError ||
    error instanceof AlertUpstreamError ||
    error instanceof NotificationUpstreamError ||
    error instanceof MlOperationsUpstreamError
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
    async alertListV2(
      _: unknown,
      args: { limit: number; after?: string; state?: string },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
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
    async alertDetailV2(
      _: unknown,
      { id }: { id: string },
      context: BffContext,
    ) {
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
    async alertHistory(
      _: unknown,
      args: { id: string; limit: number; after?: string },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      try {
        return await requiredAlerts(context).history(
          context.principal,
          context.authorization,
          args.id,
          args.limit,
          args.after,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async alertNotifications(
      _: unknown,
      args: { id: string; limit: number; after?: string },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      try {
        requireRole(context.principal, "operator", "admin");
        const alerts = requiredAlerts(context);
        await alerts.get(context.principal, context.authorization, args.id);
        if (!context.notifications)
          throw new NotificationUpstreamError(
            503,
            "notification_history_unavailable",
          );
        return await context.notifications.history(
          context.principal,
          context.authorization,
          args.id,
          args.limit,
          args.after,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async mlOperations(_: unknown, _args: unknown, context: BffContext) {
      try {
        requireRole(context.principal, "operator", "admin");
        if (!context.mlOperations)
          throw new MlOperationsUpstreamError(503, "ml_operations_unavailable");
        return await context.mlOperations.snapshot(
          context.principal,
          context.authorization,
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
    async device(
      _: unknown,
      { id, minimumConsistency }: { id: string; minimumConsistency?: string },
      context: BffContext,
      info: GraphQLResolveInfo,
    ) {
      try {
        if (info.operation.name?.value === "DeviceCurrent")
          return (await currentSnapshot(context, id, minimumConsistency))
            .device;
        const consistency = readConsistency(context, minimumConsistency);
        if (context.deviceLoader && !minimumConsistency)
          return await context.deviceLoader.load(id);
        return await requiredRead(context).device(
          context.authorization,
          id,
          consistency,
        );
      } catch (error) {
        return translate(error);
      }
    },
    async reading(
      _: unknown,
      { id, minimumConsistency }: { id: string; minimumConsistency?: string },
      context: BffContext,
    ) {
      try {
        return await requiredRead(context).reading(
          context.authorization,
          id,
          readConsistency(context, minimumConsistency),
        );
      } catch (error) {
        return translate(error);
      }
    },
    async siteDevices(
      _: unknown,
      args: {
        siteId: string;
        limit: number;
        after?: string;
        minimumConsistency?: string;
      },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      try {
        return await requiredRead(context).siteDevices(
          context.authorization,
          args.siteId,
          args.limit,
          args.after,
          readConsistency(context, args.minimumConsistency),
        );
      } catch (error) {
        return translate(error);
      }
    },
    async latestReading(
      _: unknown,
      {
        deviceId,
        minimumConsistency,
      }: { deviceId: string; minimumConsistency?: string },
      context: BffContext,
      info: GraphQLResolveInfo,
    ) {
      try {
        if (info.operation.name?.value === "DeviceCurrent")
          return (await currentSnapshot(context, deviceId, minimumConsistency))
            .latestReading;
        return await requiredRead(context).latest(
          context.authorization,
          deviceId,
          readConsistency(context, minimumConsistency),
        );
      } catch (error) {
        return translate(error);
      }
    },
    async binReadingsLatest(
      _: unknown,
      {
        binId,
        minimumConsistency,
      }: { binId: string; minimumConsistency?: string },
      context: BffContext,
    ) {
      try {
        return await requiredRead(context).binReadingsLatest(
          context.authorization,
          binId,
          readConsistency(context, minimumConsistency),
        );
      } catch (error) {
        return translate(error);
      }
    },
    async binReadingsTrend(
      _: unknown,
      args: {
        binId: string;
        window: string;
        resolution?: string;
        minimumConsistency?: string;
      },
      context: BffContext,
    ) {
      if (
        !["H1", "H6", "H24"].includes(args.window) ||
        ![undefined, "AUTO", "M1", "M5", "M15", "H1"].includes(args.resolution)
      )
        throw new GraphQLError("invalid bin trend range", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      try {
        return await requiredRead(context).binReadingsTrend(
          context.authorization,
          args.binId,
          args.window,
          args.resolution ?? "AUTO",
          readConsistency(context, args.minimumConsistency),
        );
      } catch (error) {
        return translate(error);
      }
    },
    async readingHistory(
      _: unknown,
      args: {
        deviceId: string;
        from: string;
        to: string;
        limit: number;
        minimumConsistency?: string;
      },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      try {
        return await requiredRead(context).history(
          context.authorization,
          args,
          readConsistency(context, args.minimumConsistency),
        );
      } catch (error) {
        return translate(error);
      }
    },
    async searchDevices(
      _: unknown,
      args: { query: string; limit: number; minimumConsistency?: string },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 50);
      try {
        return await requiredRead(context).search(
          context.authorization,
          args.query,
          args.limit,
          readConsistency(context, args.minimumConsistency),
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
        minimumConsistency?: string;
      },
      context: BffContext,
    ) {
      boundedLimit(args.limit, 100);
      if (args.bucket !== "hour" && args.bucket !== "day")
        throw new GraphQLError("invalid bucket", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      try {
        return await requiredRead(context).rollups(
          context.authorization,
          {
            ...args,
            bucket: args.bucket,
          },
          readConsistency(context, args.minimumConsistency),
        );
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
    async promoteMlModel(_: unknown, args: { version: string }, context: BffContext) {
      return mlAction(context, "promote", args.version);
    },
    async rollbackMlModel(_: unknown, args: { version?: string }, context: BffContext) {
      return mlAction(context, "rollback", args.version);
    },
    async startMlRetraining(_: unknown, _args: unknown, context: BffContext) {
      return mlAction(context, "retrain");
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

function currentSnapshot(
  context: BffContext,
  deviceId: string,
  minimumConsistency?: string,
) {
  const consistency = readConsistency(context, minimumConsistency);
  const key = JSON.stringify([
    deviceId,
    consistency.minimumConsistency ?? null,
  ]);
  const reads = (context.currentReads ??= new Map());
  let snapshot = reads.get(key);
  if (!snapshot) {
    snapshot = requiredRead(context).deviceCurrent(
      context.authorization,
      deviceId,
      consistency,
    );
    reads.set(key, snapshot);
  }
  return snapshot;
}

export function observeResponseWatermark(
  context: BffContext,
  token: string,
): void {
  const incoming = parseWatermark(token, context.principal.tenantId);
  if (context.consistencyToken) {
    const current = parseWatermark(
      context.consistencyToken,
      context.principal.tenantId,
    );
    if (
      current.shardIncarnation !== incoming.shardIncarnation ||
      current.placementEpoch !== incoming.placementEpoch
    )
      throw new ReadUpstreamError(409, "consistency_identity_mismatch");
    // An operation can issue multiple reads; its certificate covers the oldest snapshot.
    if (BigInt(current.sequence) <= BigInt(incoming.sequence)) return;
  }
  context.consistencyToken = serializeWatermark(incoming);
}

function readConsistency(context: BffContext, minimumConsistency?: string) {
  try {
    return {
      tenantId: context.principal.tenantId,
      deadline: (context.readDeadline ??= Date.now() + 8000),
      signal: context.readSignal,
      onWatermark: (token: string) => observeResponseWatermark(context, token),
      ...(minimumConsistency != null
        ? {
            minimumConsistency: serializeWatermark(
              parseWatermark(minimumConsistency, context.principal.tenantId),
            ),
          }
        : {}),
    };
  } catch {
    throw new ReadUpstreamError(400, "invalid_consistency_token");
  }
}

function requiredRead(context: BffContext): ReadClient {
  if (!context.read) throw new ReadUpstreamError(503, "read_api_unavailable");
  return context.read;
}

function requiredAlerts(context: BffContext): AlertClient {
  if (!context.alerts)
    throw new AlertUpstreamError(503, "alerts_api_unavailable");
  return context.alerts;
}

async function mlAction(
  context: BffContext,
  action: MlAction,
  version?: string,
) {
  try {
    requireRole(context.principal, "operator", "admin");
    if (!context.mlOperations)
      throw new MlOperationsUpstreamError(503, "ml_operations_unavailable");
    return await context.mlOperations.action(
      context.principal,
      context.authorization,
      action,
      version,
    );
  } catch (error) {
    return translate(error);
  }
}

export function createApolloServer(): ApolloServer<BffContext> {
  return new ApolloServer<BffContext>({
    typeDefs,
    resolvers,
    plugins: [
      {
        async requestDidStart() {
          return {
            async willSendResponse({ contextValue, response }) {
              if (
                response.body.kind === "single" &&
                !response.body.singleResult.errors?.length &&
                contextValue.consistencyToken
              )
                response.body.singleResult.extensions = {
                  ...response.body.singleResult.extensions,
                  consistencyToken: contextValue.consistencyToken,
                };
            },
          };
        },
      },
    ],
    introspection: false,
    includeStacktraceInErrorResponses: false,
  });
}
