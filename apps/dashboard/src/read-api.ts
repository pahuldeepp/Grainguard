import type { AccessTokenProvider } from "./provisioning";
import { executeOperation, operationHash } from "./graphql-client";

export interface DeviceView {
  deviceId: string;
  siteId: string | null;
  binId: string | null;
  name: string | null;
  status: string | null;
  projectedAt: string | null;
}

export interface ReadingView {
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

export interface RollupView {
  bucketStart: string;
  sampleCount: number;
  avgTemperatureC: number | null;
  avgRelativeHumidityPercent: number | null;
}

export const readOperations = {
  readingById: `query ReadingById($id: ID!) { reading(id: $id) { readingId deviceId eventId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  deviceCurrent: `query DeviceCurrent($id: ID!) { device(id: $id) { deviceId siteId binId name status projectedAt } latestReading(deviceId: $id) { readingId deviceId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  deviceHistory: `query DeviceHistory($id: ID!, $from: String!, $to: String!, $limit: Int!) { readingHistory(deviceId: $id, from: $from, to: $to, limit: $limit) { readingId observedAt receivedAt projectedAt temperatureC relativeHumidityPercent streamVersion inventoryEnrichment } }`,
  deviceSearch: `query DeviceSearch($query: String!, $limit: Int!) { searchDevices(query: $query, limit: $limit) { deviceId siteId binId name status projectedAt } }`,
  readingRollups: `query ReadingRollups($deviceId: ID!, $from: String!, $to: String!, $limit: Int!, $bucket: String!) { readingRollups(deviceId: $deviceId, from: $from, to: $to, limit: $limit, bucket: $bucket) { bucketStart sampleCount avgTemperatureC avgRelativeHumidityPercent } }`,
  deviceChanged: `subscription DeviceChanged($deviceId: ID!) { deviceChanged(deviceId: $deviceId) { deviceId readingId projectedAt streamVersion } }`,
} as const;

export class ReadApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  private async execute<T>(
    query: string,
    variables: Record<string, string | number>,
  ): Promise<T> {
    return executeOperation<T>(this.getAccessToken, query, variables, {
      signIn: "Sign in to view device data.",
      request: "Device data request failed",
      empty: "Device data is temporarily unavailable.",
    });
  }

  current(id: string) {
    return this.execute<{
      device: DeviceView | null;
      latestReading: ReadingView | null;
    }>(readOperations.deviceCurrent, { id });
  }

  async reading(id: string) {
    const data = await this.execute<{ reading: ReadingView | null }>(
      readOperations.readingById,
      { id },
    );
    return data.reading;
  }

  async history(id: string, from: string, to: string, limit: number) {
    const data = await this.execute<{ readingHistory: ReadingView[] }>(
      readOperations.deviceHistory,
      { id, from, to, limit },
    );
    return data.readingHistory;
  }

  async search(query: string, limit = 25) {
    const data = await this.execute<{ searchDevices: DeviceView[] }>(
      readOperations.deviceSearch,
      { query, limit },
    );
    return data.searchDevices;
  }

  async rollups(
    deviceId: string,
    from: string,
    to: string,
    bucket: "hour" | "day",
  ) {
    const data = await this.execute<{ readingRollups: RollupView[] }>(
      readOperations.readingRollups,
      { deviceId, from, to, limit: 100, bucket },
    );
    return data.readingRollups;
  }

  subscribeDevice(deviceId: string, refresh: () => void): () => void {
    let closed = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const retry = () => {
      if (!closed) reconnect = setTimeout(() => void connect(), 2000);
    };
    const connect = async () => {
      if (closed || typeof WebSocket === "undefined") return;
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
        if (closed) return;
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
          let message: { type?: string };
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
          if (message.type === "next") refresh();
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
