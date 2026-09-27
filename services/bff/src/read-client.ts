export class ReadUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

type WireRow = Record<string, unknown>;

type ReadPolicy = {
  overallTimeoutMs: number;
  perAttemptTimeoutMs: number;
  backoffMs: number;
  failureThreshold: number;
  cooldownMs: number;
  now: () => number;
};

type CircuitCall = { epoch: number; probe: boolean };

// One call has at most 8 seconds; safe GETs get three 2-second attempts with
// 50/100 ms gaps. Three exhausted calls open the circuit for five seconds.
const defaultPolicy: ReadPolicy = {
  overallTimeoutMs: 8_000,
  perAttemptTimeoutMs: 2_000,
  backoffMs: 50,
  failureThreshold: 3,
  cooldownMs: 5_000,
  now: Date.now,
};

function transientStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new ReadUpstreamError(504, "read_timeout"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ReadUpstreamError(504, "read_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ReadUpstreamError(504, "read_timeout"));
      return;
    }
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new ReadUpstreamError(504, "read_timeout"));
    };
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

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

function pathSegment(id: string): string {
  if (id === "." || id === "..")
    throw new ReadUpstreamError(400, "invalid_resource_id");
  return encodeURIComponent(id);
}

export class ReadClient {
  private readonly policy: ReadPolicy;
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  private epoch = 0;

  constructor(
    private readonly baseURL: string,
    private readonly fetcher: typeof fetch = fetch,
    policy: Partial<ReadPolicy> = {},
  ) {
    this.policy = { ...defaultPolicy, ...policy };
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
    for (const value of [
      this.policy.overallTimeoutMs,
      this.policy.perAttemptTimeoutMs,
      this.policy.backoffMs,
      this.policy.failureThreshold,
      this.policy.cooldownMs,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("invalid read policy");
    }
  }

  private startCall(): CircuitCall {
    if (this.openUntil > this.policy.now() || this.probing)
      throw new ReadUpstreamError(503, "read_circuit_open");
    if (this.openUntil !== 0) {
      this.probing = true;
      return { epoch: this.epoch, probe: true };
    }
    return { epoch: this.epoch, probe: false };
  }

  private succeeded(call: CircuitCall): void {
    if (call.epoch !== this.epoch) return;
    this.failures = 0;
    this.openUntil = 0;
    if (call.probe) {
      this.probing = false;
      this.epoch++;
    }
  }

  private failed(call: CircuitCall): void {
    if (call.epoch !== this.epoch) return;
    this.failures++;
    if (call.probe || this.failures >= this.policy.failureThreshold) {
      this.probing = false;
      this.openUntil = this.policy.now() + this.policy.cooldownMs;
      this.epoch++;
    }
  }

  private async response<T>(
    path: string,
    authorization: string,
    requestBody?: unknown,
  ): Promise<{ data: T; nextCursor?: string | null }> {
    const call = this.startCall();
    const overall = AbortSignal.timeout(this.policy.overallTimeoutMs);
    const safeRead = requestBody === undefined;
    const attempts = safeRead && !call.probe ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let classified = false;
      const signal = AbortSignal.any([
        overall,
        AbortSignal.timeout(this.policy.perAttemptTimeoutMs),
      ]);
      try {
        const response = await abortable(
          this.fetcher(new URL(path, this.baseURL), {
            method: safeRead ? "GET" : "POST",
            headers: {
              Authorization: authorization,
              ...(safeRead ? {} : { "Content-Type": "application/json" }),
            },
            ...(safeRead ? {} : { body: JSON.stringify(requestBody) }),
            signal,
          }),
          signal,
        );
        if (!response.ok) {
          const retryable = transientStatus(response.status);
          if (retryable && attempt + 1 < attempts && !overall.aborted) {
            // The response is intentionally discarded; release its connection
            // before another attempt instead of leaving unread bytes behind.
            if (response.body)
              await abortable(
                response.body.cancel().catch(() => undefined),
                signal,
              );
            await pause(this.policy.backoffMs * (attempt + 1), overall);
            continue;
          }
          if (retryable) this.failed(call);
          else this.succeeded(call);
          classified = true;
          const body = (await abortable(
            response.json().catch(() => ({})),
            signal,
          )) as {
            code?: string;
          };
          throw new ReadUpstreamError(
            response.status,
            body.code ?? "read_unavailable",
          );
        }
        const body = (await abortable(response.json(), signal)) as {
          data?: T;
          nextCursor?: string | null;
        };
        this.succeeded(call);
        if (!("data" in body))
          throw new ReadUpstreamError(502, "invalid_read_response");
        return { data: body.data as T, nextCursor: body.nextCursor };
      } catch (error) {
        if (classified) throw error;
        if (error instanceof ReadUpstreamError && error.code !== "read_timeout")
          throw error;
        const failure =
          error instanceof ReadUpstreamError
            ? error
            : new ReadUpstreamError(503, "read_unavailable");
        if (attempt + 1 < attempts && !overall.aborted) {
          try {
            await pause(this.policy.backoffMs * (attempt + 1), overall);
          } catch (deadline) {
            this.failed(call);
            throw deadline;
          }
          continue;
        }
        this.failed(call);
        throw failure;
      }
    }
    throw new ReadUpstreamError(503, "read_unavailable");
  }

  private async request<T>(path: string, authorization: string): Promise<T> {
    return (await this.response<T>(path, authorization)).data;
  }

  async device(authorization: string, id: string) {
    const row = await this.request<WireRow | null>(
      `/api/v1/read/devices/${pathSegment(id)}`,
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
      `/api/v1/read/readings/${pathSegment(id)}`,
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
      `/api/v1/read/sites/${pathSegment(siteId)}/devices?${params}`,
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
      `/api/v1/read/devices/${pathSegment(args.deviceId)}/rollups?${params}`,
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
      `/api/v1/read/devices/${pathSegment(id)}/latest`,
      authorization,
    );
    return reading(row);
  }

  async binReadingsLatest(authorization: string, binId: string) {
    const value = await this.request<WireRow | null>(
      `/api/v1/read/bins/${pathSegment(binId)}/readings/latest`,
      authorization,
    );
    if (!value) return null;
    const bin = value.bin as WireRow | undefined;
    const mapRow = (row: WireRow) => ({
      deviceId: row.device_id,
      metric: row.metric,
      unit: row.unit,
      value: row.value,
      observedAt: row.observed_at,
      receivedAt: row.received_at,
      projectedAt: row.projected_at ?? null,
      readingId: row.reading_id,
      ageSeconds: row.age_seconds ?? null,
      stale: row.stale ?? null,
    });
    return {
      bin: bin
        ? {
            binId: bin.bin_id,
            siteId: bin.site_id,
            name: bin.name,
            siteName: bin.site_name ?? null,
            projectedAt: bin.projected_at,
          }
        : null,
      devices: ((value.devices as WireRow[] | undefined) ?? []).map((row) => ({
        deviceId: row.device_id,
        status: row.status,
        serialNumber: row.serial_number,
      })),
      devicesTruncated: value.devicesTruncated ?? false,
      readings: ((value.readings as WireRow[] | undefined) ?? []).map(mapRow),
      layout: ((value.layout as WireRow[] | undefined) ?? []).map((row) => ({
        deviceId: row.device_id,
        cableId: row.cable_id,
        cableVersion: exactVersion(row.cable_version),
        sensorId: row.sensor_id,
        position: row.position,
        depthM: row.depth_m ?? null,
        label: row.label,
      })),
      sensorReadings: (
        (value.sensorReadings as WireRow[] | undefined) ?? []
      ).map((row) => ({
        ...mapRow(row),
        sensorId: row.sensor_id,
        cableId: row.cable_id,
        layoutVersion: exactVersion(row.layout_version),
        position: row.position,
        depthM: row.depth_m ?? null,
        label: row.label,
      })),
      policies: ((value.policies as WireRow[] | undefined) ?? []).map(
        (row) => ({
          policyId: row.policy_id,
          policyVersion: exactVersion(row.policy_version),
          grainType: row.grain_type,
          effectiveFrom: row.effective_from,
          effectiveTo: row.effective_to ?? null,
          measurementThresholds: JSON.stringify(row.measurement_thresholds),
          riskThresholds: JSON.stringify(row.risk_thresholds),
          calibrated: row.calibrated,
          status: row.status,
          provenance: JSON.stringify(row.provenance),
          calibrationEvidence: row.calibration_evidence ?? null,
        }),
      ),
      freshness: value.freshness ?? "not_configured",
    };
  }

  async binReadingsTrend(
    authorization: string,
    binId: string,
    window: string,
    resolution = "AUTO",
  ) {
    const params = new URLSearchParams({ window, resolution });
    const result = await this.request<WireRow>(
      `/api/v1/read/bins/${pathSegment(binId)}/readings/trend?${params}`,
      authorization,
    );
    const data = result;
    return {
      bin: data.bins
        ? {
            binId: (data.bins as WireRow).bin_id,
            siteId: (data.bins as WireRow).site_id,
            name: (data.bins as WireRow).name,
            siteName: (data.bins as WireRow).site_name ?? null,
          }
        : null,
      window: result.window,
      resolution: result.resolution,
      bucketSeconds: result.bucketSeconds,
      from: result.from,
      to: result.to,
      buckets: ((data?.buckets as WireRow[] | undefined) ?? []).map((row) => ({
        bucketAt: row.bucket_at,
        metric: row.metric,
        unit: row.unit,
        minValue: row.min_value ?? null,
        averageValue: row.average_value ?? null,
        maxValue: row.max_value ?? null,
        sampleCount: row.sample_count,
        deviceCount: row.device_count,
      })),
      source: result.source,
    };
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
      `/api/v1/read/devices/${pathSegment(args.deviceId)}/readings?${params}`,
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
