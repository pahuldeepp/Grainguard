export class ReadUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type WireRow = Record<string, unknown>;

function exactVersion(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "bigint")
    return String(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  throw new ReadUpstreamError(502, "invalid_stream_version");
}

function device(row: WireRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    deviceId: row.device_id ?? row.resource_id,
    siteId: row.site_id ?? null,
    binId: row.bin_id ?? null,
    name: row.name ?? row.serial_number ?? null,
    status: row.status ?? null,
    projectedAt: row.projected_at ?? row.updated_at ?? null,
  };
}

function reading(row: WireRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    readingId: row.reading_id,
    deviceId: row.device_id,
    eventId: row.event_id ?? null,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
    projectedAt: row.projected_at ?? null,
    temperatureC: row.temperature_c ?? null,
    relativeHumidityPercent: row.relative_humidity_percent ?? null,
    streamVersion: exactVersion(row.stream_version),
    inventoryEnrichment: row.inventory_enrichment ?? null,
  };
}

export class ReadClient {
  constructor(
    private readonly baseURL: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(baseURL);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )
    ) {
      throw new Error("READ_API_URL must use HTTPS or loopback HTTP");
    }
  }

  private async response<T>(
    path: string,
    authorization: string,
    requestBody?: unknown,
  ): Promise<{ data: T; nextCursor?: string | null }> {
    const response = await this.fetcher(new URL(path, this.baseURL), {
      method: requestBody === undefined ? "GET" : "POST",
      headers: {
        Authorization: authorization,
        ...(requestBody === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(requestBody === undefined
        ? {}
        : { body: JSON.stringify(requestBody) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      throw new ReadUpstreamError(
        response.status,
        body.code ?? "read_unavailable",
      );
    }
    const body = (await response.json()) as {
      data?: T;
      nextCursor?: string | null;
    };
    if (!("data" in body))
      throw new ReadUpstreamError(502, "invalid_read_response");
    return { data: body.data as T, nextCursor: body.nextCursor };
  }

  private async request<T>(path: string, authorization: string): Promise<T> {
    return (await this.response<T>(path, authorization)).data;
  }

  async device(authorization: string, id: string) {
    const row = await this.request<WireRow | null>(
      `/api/v1/read/devices/${encodeURIComponent(id)}`,
      authorization,
    );
    return device(row);
  }

  async devices(authorization: string, ids: readonly string[]) {
    const rows = (
      await this.response<WireRow[]>(
        "/api/v1/read/devices/batch",
        authorization,
        { deviceIds: ids },
      )
    ).data;
    return rows.map((row) => device(row)).filter((row) => row !== null);
  }

  async reading(authorization: string, id: string) {
    const row = await this.request<WireRow | null>(
      `/api/v1/read/readings/${encodeURIComponent(id)}`,
      authorization,
    );
    return reading(row);
  }

  async siteDevices(
    authorization: string,
    siteId: string,
    limit: number,
    after?: string,
  ) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after", after);
    const { data: rows, nextCursor } = await this.response<WireRow[]>(
      `/api/v1/read/sites/${encodeURIComponent(siteId)}/devices?${params}`,
      authorization,
    );
    return {
      items: rows.map((row) => device(row)),
      nextCursor: nextCursor ?? null,
    };
  }

  async rollups(
    authorization: string,
    args: {
      deviceId: string;
      from: string;
      to: string;
      limit: number;
      bucket: "hour" | "day";
    },
  ) {
    const params = new URLSearchParams({
      from: args.from,
      to: args.to,
      limit: String(args.limit),
      bucket: args.bucket,
    });
    const rows = await this.request<WireRow[]>(
      `/api/v1/read/devices/${encodeURIComponent(args.deviceId)}/rollups?${params}`,
      authorization,
    );
    return rows.map((row) => ({
      bucketStart: row.bucket_start,
      sampleCount: row.sample_count,
      avgTemperatureC: row.avg_temperature_c,
      avgRelativeHumidityPercent: row.avg_relative_humidity_percent,
    }));
  }

  async latest(authorization: string, id: string) {
    const row = await this.request<WireRow | null>(
      `/api/v1/read/devices/${encodeURIComponent(id)}/latest`,
      authorization,
    );
    return reading(row);
  }

  async history(
    authorization: string,
    args: { deviceId: string; from: string; to: string; limit: number },
  ) {
    const params = new URLSearchParams({
      from: args.from,
      to: args.to,
      limit: String(args.limit),
    });
    const rows = await this.request<WireRow[]>(
      `/api/v1/read/devices/${encodeURIComponent(args.deviceId)}/readings?${params}`,
      authorization,
    );
    return rows.map((row) => reading(row));
  }

  async search(authorization: string, query: string, limit: number) {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const rows = await this.request<WireRow[]>(
      `/api/v1/read/search?${params}`,
      authorization,
    );
    return rows
      .filter((row) => row.resource_type === "device")
      .map((row) => device(row));
  }
}
