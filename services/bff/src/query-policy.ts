import { createHash } from "node:crypto";
import { parse, visit, Kind, type DocumentNode } from "graphql";

export const operations = {
  session: `query Session { session { subject tenantId roles } }`,
  provisioningStatus: `query ProvisioningStatus($id: ID!) { provisioningStatus(id: $id) { saga { tenantId sagaId deviceId assetId state version fencingToken deadlineAt } history { version action actorSub reason recordedAt } } }`,
  startProvisioning: `mutation StartProvisioning($deviceId: ID!, $assetId: ID!, $idempotencyKey: String!) { startProvisioning(deviceId: $deviceId, assetId: $assetId, idempotencyKey: $idempotencyKey) { tenantId sagaId deviceId assetId state version fencingToken deadlineAt } }`,
  redriveProvisioning: `mutation RedriveProvisioning($id: ID!, $reason: String!) { redriveProvisioning(id: $id, reason: $reason) { tenantId sagaId deviceId assetId state version fencingToken deadlineAt } }`,
  deviceCurrent: `query DeviceCurrent($id: ID!, $minimumConsistency: String) { device(id: $id, minimumConsistency: $minimumConsistency) { consistencyToken deviceId siteId binId name status projectedAt } latestReading(deviceId: $id, minimumConsistency: $minimumConsistency) { consistencyToken readingId deviceId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  readingById: `query ReadingById($id: ID!, $minimumConsistency: String) { reading(id: $id, minimumConsistency: $minimumConsistency) { consistencyToken readingId deviceId eventId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  deviceHistory: `query DeviceHistory($id: ID!, $from: String!, $to: String!, $limit: Int!, $minimumConsistency: String) { readingHistory(deviceId: $id, from: $from, to: $to, limit: $limit, minimumConsistency: $minimumConsistency) { consistencyToken readingId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  deviceSearch: `query DeviceSearch($query: String!, $limit: Int!, $minimumConsistency: String) { searchDevices(query: $query, limit: $limit, minimumConsistency: $minimumConsistency) { consistencyToken deviceId siteId binId name status projectedAt } }`,
  siteDevices: `query SiteDevices($siteId: ID!, $limit: Int!, $after: String, $minimumConsistency: String) { siteDevices(siteId: $siteId, limit: $limit, after: $after, minimumConsistency: $minimumConsistency) { consistencyToken items { consistencyToken deviceId siteId binId name status projectedAt } nextCursor } }`,
  readingRollups: `query ReadingRollups($deviceId: ID!, $from: String!, $to: String!, $limit: Int!, $bucket: String!, $minimumConsistency: String) { readingRollups(deviceId: $deviceId, from: $from, to: $to, limit: $limit, bucket: $bucket, minimumConsistency: $minimumConsistency) { consistencyToken bucketStart sampleCount avgTemperatureC avgRelativeHumidityPercent } }`,
  alertListV2: `query AlertListV2($limit: Int!, $after: String, $state: String) { alertListV2(limit: $limit, after: $after, state: $state) { items { alertId ruleId binId state severity score version openWindowStart openedAt acknowledgedAt acknowledgedBy escalatedAt resolvedAt escalationLevel actor { kind isYou handle } } nextCursor } }`,
  alertDetailV2: `query AlertDetailV2($id: ID!) { alertDetailV2(id: $id) { alertId ruleId binId state severity score version openWindowStart openedAt acknowledgedAt acknowledgedBy escalatedAt resolvedAt escalationLevel actor { kind isYou handle } } }`,
  alertHistory: `query AlertHistory($id: ID!, $limit: Int!, $after: String) { alertHistory(id: $id, limit: $limit, after: $after) { alertId items { transitionId version type fromState toState occurredAt actor { kind isYou handle } cause { kind } } nextCursor complete source { status reasonCode } } }`,
  alertNotifications: `query AlertNotifications($id: ID!, $limit: Int!, $after: String) { alertNotifications(id: $id, limit: $limit, after: $after) { items { intentId transitionVersion transition severity channel deliveryGeneration redriveCount state reasonCode queuedAt resolvedAt dispatchAttempts providerAttempts events { kind outcome recordedAt } attemptsTruncated } nextCursor complete sources { intents { status reasonCode } warning { status reasonCode } critical { status reasonCode } transitions { status reasonCode } } } }`,
  binReadingsLatest: `query BinReadingsLatest($binId: ID!, $minimumConsistency: String) { binReadingsLatest(binId: $binId, minimumConsistency: $minimumConsistency) { consistencyToken bin { binId name siteName } devices { deviceId status } devicesTruncated readings { metric value observedAt ageSeconds } layout { sensorId position depthM label } sensorReadings { sensorId metric value observedAt position depthM label } policies { policyId policyVersion grainType calibrated status measurementThresholds riskThresholds } freshness } }`,
  binReadingsTrend: `query BinReadingsTrend($binId: ID!, $window: String!, $resolution: String = "AUTO", $minimumConsistency: String) { binReadingsTrend(binId: $binId, window: $window, resolution: $resolution, minimumConsistency: $minimumConsistency) { consistencyToken bin { binId name siteName } window resolution bucketSeconds from to buckets { bucketAt metric unit minValue averageValue maxValue sampleCount deviceCount } source } }`,
  alertList: `query AlertList($limit: Int!, $after: String, $state: String) { alerts(limit: $limit, after: $after, state: $state) { items { alertId ruleId binId state severity score version openedAt acknowledgedAt escalationLevel } nextCursor } }`,
  alertDetail: `query AlertDetail($id: ID!) { alert(id: $id) { alertId ruleId binId state severity score version openedAt acknowledgedAt acknowledgedBy escalationLevel } }`,
  acknowledgeAlert: `mutation AcknowledgeAlert($id: ID!, $version: String!, $idempotencyKey: String!) { acknowledgeAlert(id: $id, version: $version, idempotencyKey: $idempotencyKey) { episodeId state version eventId } }`,
  deviceChanged: `subscription DeviceChanged($deviceId: ID!) { deviceChanged(deviceId: $deviceId) { consistencyToken deviceId readingId projectedAt streamVersion } }`,
  mlOperations: `query MlOperations { mlOperations { capturedAt scorerReady predictionsTotal inferenceP95Ms canaryPercentage model { name version mode dataOrigin productionEligible status } drift { feature psi sampleCount status } retraining { status runId completedAt } } }`,
  promoteMlModel: `mutation PromoteMlModel($version: String!) { promoteMlModel(version: $version) { action accepted message runId } }`,
  rollbackMlModel: `mutation RollbackMlModel($version: String) { rollbackMlModel(version: $version) { action accepted message runId } }`,
  startMlRetraining: `mutation StartMlRetraining { startMlRetraining { action accepted message runId } }`,
} as const;

export function operationHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

export const persistedOperations = new Map(
  Object.values(operations).map((query) => [operationHash(query), query]),
);

export class QueryPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// Charge every selected field, including aliases and fields inside fragments.
// Fragments are rejected here until expansion can be costed safely.
export function assertQueryBudget(document: DocumentNode): void {
  let depth = 0;
  let fields = 0;
  let operationsCount = 0;
  visit(document, {
    OperationDefinition: {
      enter() {
        operationsCount++;
      },
    },
    FragmentDefinition() {
      throw new QueryPolicyError("fragments_not_allowed");
    },
    FragmentSpread() {
      throw new QueryPolicyError("fragments_not_allowed");
    },
    InlineFragment() {
      throw new QueryPolicyError("fragments_not_allowed");
    },
    Field: {
      enter() {
        depth++;
        fields++;
        if (depth > 6 || fields > 40)
          throw new QueryPolicyError("query_budget_exceeded");
      },
      leave() {
        depth--;
      },
    },
  });
  if (
    operationsCount !== 1 ||
    document.definitions.some((item) => item.kind !== Kind.OPERATION_DEFINITION)
  ) {
    throw new QueryPolicyError("single_operation_required");
  }
}

export function resolvePersistedOperation(
  body: unknown,
  allowlist: ReadonlyMap<string, string> = persistedOperations,
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new QueryPolicyError("invalid_request");
  const input = body as Record<string, unknown>;
  const extensions = input.extensions;
  const persisted =
    extensions && typeof extensions === "object" && !Array.isArray(extensions)
      ? (extensions as Record<string, unknown>).persistedQuery
      : undefined;
  const hash =
    persisted && typeof persisted === "object" && !Array.isArray(persisted)
      ? (persisted as Record<string, unknown>).sha256Hash
      : undefined;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    throw new QueryPolicyError("persisted_operation_required");
  const query = allowlist.get(hash);
  if (!query || operationHash(query) !== hash)
    throw new QueryPolicyError("operation_not_allowed");
  if (input.query !== undefined && input.query !== query)
    throw new QueryPolicyError("operation_hash_mismatch");
  assertQueryBudget(parse(query));
  if (
    input.operationName !== undefined &&
    typeof input.operationName !== "string"
  )
    throw new QueryPolicyError("invalid_request");
  if (
    input.variables !== undefined &&
    (typeof input.variables !== "object" ||
      input.variables === null ||
      Array.isArray(input.variables))
  )
    throw new QueryPolicyError("invalid_request");
  const safeInput = { ...input };
  delete safeInput.extensions;
  return { ...safeInput, query };
}
