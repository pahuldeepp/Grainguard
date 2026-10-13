import {
  parseWatermark,
  serializeWatermark,
} from "@greenguard/membership-client/watermark";
import { GraphqlClient, GraphqlError } from "./graphql.js";
import type { AccessSource, GraphqlDeps } from "./graphql.js";
import type { ClearReason, Identity } from "./session.js";
import { IdentityChangedError } from "./session.js";

export interface MobileReadingView {
  readingId: string;
  deviceId: string;
  observedAt: string;
  receivedAt: string;
  streamVersion: string | null;
  consistencyToken: string | null;
}

type ReadSession = AccessSource & {
  onCleared?: (listener: (reason: ClearReason) => void) => void;
  onReloginRequired?: (listener: () => void) => void;
};

export const mobileReadOperations = {
  readingById: `query ReadingById($id: ID!, $minimumConsistency: String) { reading(id: $id, minimumConsistency: $minimumConsistency) { consistencyToken readingId deviceId eventId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  deviceCurrent: `query DeviceCurrent($id: ID!, $minimumConsistency: String) { device(id: $id, minimumConsistency: $minimumConsistency) { consistencyToken deviceId siteId binId name status projectedAt } latestReading(deviceId: $id, minimumConsistency: $minimumConsistency) { consistencyToken readingId deviceId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  deviceHistory: `query DeviceHistory($id: ID!, $from: String!, $to: String!, $limit: Int!, $after: String, $minimumConsistency: String) { readingHistory(deviceId: $id, from: $from, to: $to, limit: $limit, after: $after, minimumConsistency: $minimumConsistency) { items { consistencyToken readingId deviceId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } nextCursor sources { postgres cassandra } } }`,
  deviceSearch: `query DeviceSearch($query: String!, $limit: Int!, $minimumConsistency: String) { searchDevices(query: $query, limit: $limit, minimumConsistency: $minimumConsistency) { consistencyToken deviceId siteId binId name status projectedAt } }`,
  readingRollups: `query ReadingRollups($deviceId: ID!, $from: String!, $to: String!, $limit: Int!, $bucket: String!, $minimumConsistency: String) { readingRollups(deviceId: $deviceId, from: $from, to: $to, limit: $limit, bucket: $bucket, minimumConsistency: $minimumConsistency) { consistencyToken bucketStart sampleCount avgTemperatureC avgRelativeHumidityPercent } }`,
  binReadingsLatest: `query BinReadingsLatest($binId: ID!, $minimumConsistency: String) { binReadingsLatest(binId: $binId, minimumConsistency: $minimumConsistency) { consistencyToken bin { binId name siteName } devices { deviceId status } devicesTruncated readings { metric value observedAt ageSeconds } layout { sensorId position depthM label } sensorReadings { sensorId metric value observedAt position depthM label } policies { policyId policyVersion grainType calibrated status measurementThresholds riskThresholds } freshness } }`,
  binReadingsTrend: `query BinReadingsTrend($binId: ID!, $window: String!, $resolution: String = "AUTO", $minimumConsistency: String) { binReadingsTrend(binId: $binId, window: $window, resolution: $resolution, minimumConsistency: $minimumConsistency) { consistencyToken bin { binId name siteName } window resolution bucketSeconds from to buckets { bucketAt metric unit minValue averageValue maxValue sampleCount deviceCount } source } }`,
  deviceChanged: `subscription DeviceChanged($deviceId: ID!) { deviceChanged(deviceId: $deviceId) { consistencyToken deviceId readingId projectedAt streamVersion } }`,
} as const;

function authoritativeResetToken(value: unknown, minimum: string): string {
  const old = parseWatermark(minimum);
  let actual: ReturnType<typeof parseWatermark> | undefined;
  const visit = (row: unknown): void => {
    if (!row || typeof row !== "object") return;
    const item = row as Record<string, unknown>;
    if (typeof item.consistencyToken === "string") {
      const token = parseWatermark(item.consistencyToken, old.tenantId);
      if (
        BigInt(token.placementEpoch) < BigInt(old.placementEpoch) ||
        (token.placementEpoch === old.placementEpoch &&
          token.shardIncarnation === old.shardIncarnation) ||
        (actual &&
          (actual.shardIncarnation !== token.shardIncarnation ||
            actual.placementEpoch !== token.placementEpoch))
      )
        throw new Error("consistency_identity_mismatch");
      if (!actual || BigInt(token.sequence) < BigInt(actual.sequence))
        actual = token;
    }
    Object.values(item).forEach(visit);
  };
  visit(value);
  if (!actual) throw new Error("invalid_consistency_response");
  return serializeWatermark(actual);
}

export class MobileReadClient {
  private readonly graphql: GraphqlClient;
  private readonly timeoutMs: number;
  private identity?: Identity;
  private minimumConsistency?: string;
  private generation = 0;
  private lastRead?: {
    query: string;
    variables: Record<string, string | number>;
  };

  constructor(
    endpoint: string,
    private readonly session: ReadSession,
    deps: GraphqlDeps,
  ) {
    this.graphql = new GraphqlClient(endpoint, session, deps);
    this.timeoutMs = deps.timeoutMs ?? 8000;
    session.onCleared?.(() => this.clearConsistency());
    session.onReloginRequired?.(() => this.clearConsistency());
  }

  clearConsistency(): void {
    this.identity = undefined;
    this.lastRead = undefined;
    this.minimumConsistency = undefined;
    this.generation++;
  }

  private observe(
    value: unknown,
    tenantId: string,
    hint = false,
  ): void | false {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.consistencyToken === "string") {
      let retainCurrent = false;
      const incoming = parseWatermark(row.consistencyToken, tenantId);
      if (this.minimumConsistency) {
        const current = parseWatermark(this.minimumConsistency, tenantId);
        if (
          hint &&
          BigInt(incoming.placementEpoch) < BigInt(current.placementEpoch)
        )
          return false;
        if (
          hint &&
          BigInt(incoming.placementEpoch) > BigInt(current.placementEpoch)
        ) {
          if (current.tenantId !== incoming.tenantId)
            throw new Error("consistency_identity_mismatch");
          this.minimumConsistency = serializeWatermark(incoming);
          return;
        }
        if (
          current.shardIncarnation !== incoming.shardIncarnation ||
          current.placementEpoch !== incoming.placementEpoch
        )
          throw new Error("consistency_identity_mismatch");
        retainCurrent = BigInt(current.sequence) > BigInt(incoming.sequence);
      }
      if (!retainCurrent)
        this.minimumConsistency = serializeWatermark(incoming);
    }
    for (const child of Object.values(row)) this.observe(child, tenantId, hint);
  }

  private async execute<T>(
    query: string,
    variables: Record<string, string | number>,
    minimumConsistency?: string,
    supportsConsistency = true,
  ): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    const grant = await this.session.getAccessToken();
    if (
      this.identity &&
      (this.identity.tenantId !== grant.tenantId ||
        this.identity.subject !== grant.subject)
    )
      this.clearConsistency();
    this.identity = { tenantId: grant.tenantId, subject: grant.subject };
    const generation = this.generation;
    const minimum =
      minimumConsistency ??
      (supportsConsistency ? this.minimumConsistency : undefined);
    if (minimum) parseWatermark(minimum, grant.tenantId);
    if (supportsConsistency) this.lastRead = { query, variables };
    let result: T;
    let responseWatermark: string | undefined;
    const onWatermark = (token: string) => {
      responseWatermark = token;
    };
    try {
      result = await this.graphql.execute<T>(
        query,
        { ...variables, ...(minimum ? { minimumConsistency: minimum } : {}) },
        grant,
        onWatermark,
        deadline,
      );
    } catch (error) {
      if (
        !supportsConsistency ||
        !minimum ||
        !(error instanceof GraphqlError) ||
        error.status !== 409 ||
        error.code !== "consistency_identity_mismatch"
      )
        throw error;
      if (generation !== this.generation) throw new IdentityChangedError();
      // One admitted authoritative snapshot, only for the explicit identity error.
      responseWatermark = undefined;
      result = await this.graphql.execute<T>(
        query,
        variables,
        grant,
        onWatermark,
        deadline,
      );
      if (generation !== this.generation) throw new IdentityChangedError();
      const reset = authoritativeResetToken(
        { result, consistencyToken: responseWatermark },
        minimum,
      );
      const current =
        this.minimumConsistency &&
        parseWatermark(this.minimumConsistency, grant.tenantId);
      const incoming = parseWatermark(reset, grant.tenantId);
      const prior = parseWatermark(minimum);
      if (
        current &&
        (BigInt(current.placementEpoch) > BigInt(incoming.placementEpoch) ||
          ((current.shardIncarnation !== prior.shardIncarnation ||
            current.placementEpoch !== prior.placementEpoch) &&
            (current.shardIncarnation !== incoming.shardIncarnation ||
              current.placementEpoch !== incoming.placementEpoch)))
      )
        throw new Error("consistency_identity_mismatch", { cause: error });
      if (
        current &&
        current.shardIncarnation === incoming.shardIncarnation &&
        current.placementEpoch === incoming.placementEpoch &&
        BigInt(current.sequence) > BigInt(incoming.sequence)
      )
        throw new Error("consistency_minimum_unsatisfied", { cause: error });
      this.minimumConsistency = reset;
    }
    if (generation !== this.generation) throw new IdentityChangedError();
    if (supportsConsistency)
      this.observe(
        { result, consistencyToken: responseWatermark },
        grant.tenantId,
      );
    return result;
  }

  async observeDeviceChange(change: {
    consistencyToken?: string | null;
  }): Promise<void> {
    const generation = this.generation;
    const grant = await this.session.getAccessToken();
    if (generation !== this.generation) throw new IdentityChangedError();
    if (
      this.identity &&
      (this.identity.tenantId !== grant.tenantId ||
        this.identity.subject !== grant.subject)
    ) {
      this.clearConsistency();
      throw new IdentityChangedError();
    }
    this.identity = { tenantId: grant.tenantId, subject: grant.subject };
    try {
      this.observe(change, grant.tenantId, true);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "consistency_identity_mismatch" ||
        !this.lastRead
      )
        throw error;
      await this.execute(this.lastRead.query, this.lastRead.variables);
    }
  }

  async rollups(
    deviceId: string,
    from: string,
    to: string,
    bucket: "hour" | "day",
    minimumConsistency?: string,
  ) {
    return (
      await this.execute<{ readingRollups: Record<string, unknown>[] }>(
        mobileReadOperations.readingRollups,
        { deviceId, from, to, bucket, limit: 100 },
        minimumConsistency,
      )
    ).readingRollups;
  }

  current(id: string, minimumConsistency?: string) {
    return this.execute<{
      device: Record<string, unknown> | null;
      latestReading: MobileReadingView | null;
    }>(mobileReadOperations.deviceCurrent, { id }, minimumConsistency);
  }

  async reading(id: string, minimumConsistency?: string) {
    return (
      await this.execute<{ reading: MobileReadingView | null }>(
        mobileReadOperations.readingById,
        { id },
        minimumConsistency,
      )
    ).reading;
  }

  async binLatest(binId: string, minimumConsistency?: string) {
    return (
      await this.execute<{ binReadingsLatest: Record<string, unknown> | null }>(
        mobileReadOperations.binReadingsLatest,
        { binId },
        minimumConsistency,
      )
    ).binReadingsLatest;
  }

  async binTrend(
    binId: string,
    window: "H1" | "H6" | "H24",
    resolution = "AUTO",
    minimumConsistency?: string,
  ) {
    return (
      await this.execute<{ binReadingsTrend: Record<string, unknown> }>(
        mobileReadOperations.binReadingsTrend,
        { binId, window, resolution },
        minimumConsistency,
      )
    ).binReadingsTrend;
  }

  async history(
    id: string,
    from: string,
    to: string,
    limit: number,
    minimumConsistency?: string,
  ) {
    return (await this.historyPage(id, from, to, limit, minimumConsistency))
      .items;
  }

  async historyPage(
    id: string,
    from: string,
    to: string,
    limit: number,
    minimumConsistency?: string,
    after?: string,
  ) {
    return (
      await this.execute<{
        readingHistory: {
          items: MobileReadingView[];
          nextCursor: string | null;
          sources: { postgres: boolean; cassandra: boolean };
        };
      }>(
        mobileReadOperations.deviceHistory,
        { id, from, to, limit, ...(after ? { after } : {}) },
        minimumConsistency,
        false,
      )
    ).readingHistory;
  }

  async search(query: string, limit = 25, minimumConsistency?: string) {
    return (
      await this.execute<{ searchDevices: Record<string, unknown>[] }>(
        mobileReadOperations.deviceSearch,
        { query, limit },
        minimumConsistency,
        false,
      )
    ).searchDevices;
  }
}
