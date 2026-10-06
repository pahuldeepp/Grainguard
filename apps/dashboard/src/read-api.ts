import {
  parseWatermark,
  serializeWatermark,
} from "@greenguard/membership-client/watermark";
import type { AccessTokenProvider } from "./provisioning";
import {
  executeOperation,
  operationHash,
  GraphqlOperationError,
} from "./graphql-client";

export interface DeviceView {
  consistencyToken?: string | null;
  deviceId: string;
  siteId: string | null;
  binId: string | null;
  name: string | null;
  status: string | null;
  projectedAt: string | null;
}

export interface ReadingView {
  consistencyToken?: string | null;
  readingId: string;
  deviceId: string;
  observedAt: string;
  receivedAt: string;
  projectedAt: string | null;
  temperatureC: number | null;
  relativeHumidityPercent: number | null;
  streamVersion: string | null;
  inventoryEnrichment: string | null;
}

export interface ReadingHistoryPage {
  items: ReadingView[];
  nextCursor: string | null;
  /** Indicates which physical stores were queried for this page. */
  sources: { postgres: boolean; cassandra: boolean };
}

export interface RollupView {
  consistencyToken?: string | null;
  bucketStart: string;
  sampleCount: number;
  avgTemperatureC: number | null;
  avgRelativeHumidityPercent: number | null;
}

export interface BinView {
  binId: string;
  name: string;
  siteName: string | null;
}

export interface BinMetricReading {
  deviceId: string;
  metric: string;
  unit: string;
  value: number;
  observedAt: string;
  ageSeconds: number | null;
  stale: boolean | null;
}

export interface BinSensorPlacement {
  sensorId: string;
  position: number;
  depthM: number | null;
  label: string;
}

export interface BinPolicy {
  policyId: string;
  policyVersion: string;
  grainType: string;
  calibrated: boolean;
  status: string;
  measurementThresholds: string;
  riskThresholds: string;
}

export interface BinLatestView {
  consistencyToken?: string | null;
  bin: BinView;
  devices: { deviceId: string; status: string }[];
  devicesTruncated: boolean;
  readings: BinMetricReading[];
  layout: BinSensorPlacement[];
  sensorReadings: (BinSensorPlacement & BinMetricReading)[];
  policies: BinPolicy[];
  freshness: string;
}

export interface BinTrendView {
  consistencyToken?: string | null;
  bin: BinView | null;
  window: string;
  resolution: string;
  bucketSeconds: number;
  from: string;
  to: string;
  buckets: {
    bucketAt: string;
    metric: string;
    unit: string;
    minValue: number | null;
    averageValue: number | null;
    maxValue: number | null;
    sampleCount: number;
    deviceCount: number;
  }[];
  source: string;
}

export const readOperations = {
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

export class ReadApi {
  private minimumConsistency?: string;
  private generation = 0;

  clearConsistency(): void {
    this.minimumConsistency = undefined;
    this.generation++;
  }

  private observe(value: unknown, hint = false): void | false {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.consistencyToken === "string") {
      let retainCurrent = false;
      const incoming = parseWatermark(row.consistencyToken);
      if (this.minimumConsistency) {
        const current = parseWatermark(this.minimumConsistency);
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
          current.tenantId !== incoming.tenantId ||
          current.shardIncarnation !== incoming.shardIncarnation ||
          current.placementEpoch !== incoming.placementEpoch
        )
          throw new Error("consistency_identity_mismatch");
        retainCurrent = BigInt(current.sequence) > BigInt(incoming.sequence);
      }
      if (!retainCurrent)
        this.minimumConsistency = serializeWatermark(incoming);
    }
    for (const child of Object.values(row)) this.observe(child, hint);
  }
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  private async execute<T>(
    query: string,
    variables: Record<string, string | number>,
    minimumConsistency?: string,
    supportsConsistency = true,
    signal?: AbortSignal,
  ): Promise<T> {
    const generation = this.generation;
    const deadline = Date.now() + 8000;
    const minimum =
      minimumConsistency ??
      (supportsConsistency ? this.minimumConsistency : undefined);
    let responseWatermark: string | undefined;
    const request = (minimum?: string) => {
      responseWatermark = undefined;
      return executeOperation<T>(
        this.getAccessToken,
        query,
        { ...variables, ...(minimum ? { minimumConsistency: minimum } : {}) },
        {
          signIn: "Sign in to view device data.",
          request: "Device data request failed",
          empty: "Device data is temporarily unavailable.",
        },
        (token) => {
          responseWatermark = token;
        },
        deadline,
        () => generation === this.generation,
        signal,
      );
    };
    let data: T;
    try {
      data = await request(minimum);
    } catch (error) {
      if (
        !supportsConsistency ||
        !minimum ||
        !(error instanceof GraphqlOperationError) ||
        error.status !== 409 ||
        error.code !== "consistency_identity_mismatch"
      )
        throw error;
      if (generation !== this.generation)
        throw new Error("session_changed", { cause: error });
      // One fresh snapshot. A lag/outage cannot trigger an eventual fallback.
      data = await request();
      if (generation !== this.generation)
        throw new Error("session_changed", { cause: error });
      const reset = authoritativeResetToken(
        { data, consistencyToken: responseWatermark },
        minimum,
      );
      const current =
        this.minimumConsistency && parseWatermark(this.minimumConsistency);
      const incoming = parseWatermark(reset);
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
    if (generation !== this.generation) throw new Error("session_changed");
    if (supportsConsistency)
      this.observe({ data, consistencyToken: responseWatermark });
    return data;
  }

  current(id: string, minimumConsistency?: string) {
    return this.execute<{
      device: DeviceView | null;
      latestReading: ReadingView | null;
    }>(readOperations.deviceCurrent, { id }, minimumConsistency);
  }

  async reading(id: string, minimumConsistency?: string) {
    const data = await this.execute<{ reading: ReadingView | null }>(
      readOperations.readingById,
      { id },
      minimumConsistency,
    );
    return data.reading;
  }

  async history(
    id: string,
    from: string,
    to: string,
    limit: number,
    after?: string,
    minimumConsistency?: string,
  ) {
    const data = await this.execute<{ readingHistory: ReadingHistoryPage }>(
      readOperations.deviceHistory,
      { id, from, to, limit, ...(after ? { after } : {}) },
      minimumConsistency,
      false,
    );
    return data.readingHistory;
  }

  async search(
    query: string,
    limit = 25,
    minimumConsistency?: string,
    signal?: AbortSignal,
  ) {
    const data = await this.execute<{ searchDevices: DeviceView[] }>(
      readOperations.deviceSearch,
      { query, limit },
      minimumConsistency,
      false,
      signal,
    );
    return data.searchDevices;
  }

  async rollups(
    deviceId: string,
    from: string,
    to: string,
    bucket: "hour" | "day",
    minimumConsistency?: string,
  ) {
    const data = await this.execute<{ readingRollups: RollupView[] }>(
      readOperations.readingRollups,
      { deviceId, from, to, limit: 100, bucket },
      minimumConsistency,
      // Historical averages may include Cassandra, which cannot certify a
      // PostgreSQL watermark. Explicit caller minima remain unchanged.
      false,
    );
    return data.readingRollups;
  }

  async binLatest(binId: string, minimumConsistency?: string) {
    const data = await this.execute<{
      binReadingsLatest: BinLatestView | null;
    }>(readOperations.binReadingsLatest, { binId }, minimumConsistency);
    return data.binReadingsLatest;
  }

  async binTrend(
    binId: string,
    window: "H1" | "H6" | "H24",
    resolution: "AUTO" | "M1" | "M5" | "M15" | "H1" = "AUTO",
    minimumConsistency?: string,
  ) {
    const data = await this.execute<{ binReadingsTrend: BinTrendView }>(
      readOperations.binReadingsTrend,
      { binId, window, resolution },
      minimumConsistency,
    );
    return data.binReadingsTrend;
  }

  subscribeDevice(deviceId: string, refresh: () => void): () => void {
    let closed = false;
    const generation = this.generation;
    const active = () => !closed && generation === this.generation;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const retry = () => {
      if (active()) reconnect = setTimeout(() => void connect(), 2000);
    };
    const connect = async () => {
      if (!active() || typeof WebSocket === "undefined") return;
      controller = new AbortController();
      try {
        const token = await this.getAccessToken();
        if (!token) {
          retry();
          return;
        }
        const ticketResponse = await fetch("/api/v1/subscription-ticket", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!ticketResponse.ok) {
          retry();
          return;
        }
        const body = (await ticketResponse.json()) as { ticket?: string };
        if (!active()) return;
        if (!body.ticket) {
          retry();
          return;
        }
        const url = new URL("/graphql", window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url, [
          "graphql-transport-ws",
          `ticket.${body.ticket}`,
        ]);
        socket.onopen = () =>
          socket?.send(JSON.stringify({ type: "connection_init" }));
        socket.onmessage = (event) => {
          if (!active()) return;
          let message: {
            type?: string;
            payload?: {
              data?: { deviceChanged?: { consistencyToken?: string } };
            };
          };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (message.type === "connection_ack") {
            void operationHash(readOperations.deviceChanged).then((hash) => {
              if (socket?.readyState === WebSocket.OPEN)
                socket.send(
                  JSON.stringify({
                    id: "device-current",
                    type: "subscribe",
                    payload: {
                      variables: { deviceId },
                      extensions: {
                        persistedQuery: { version: 1, sha256Hash: hash },
                      },
                    },
                  }),
                );
            });
            refresh(); // Catch up from the durable Read API on every connect.
          }
          if (message.type === "next") {
            try {
              if (
                this.observe(message.payload?.data?.deviceChanged, true) ===
                false
              )
                return;
            } catch {
              // A malformed or changed-identity hint cannot poison durable reads.
              // Foreground refresh retains the old minimum and performs controlled recovery.
              refresh();
              return;
            }
            refresh();
          }
          if (message.type === "error") refresh();
        };
        socket.onclose = retry;
        socket.onerror = () => socket?.close();
      } catch {
        retry();
      }
    };
    void connect();
    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      controller?.abort();
      socket?.close();
    };
  }
}
