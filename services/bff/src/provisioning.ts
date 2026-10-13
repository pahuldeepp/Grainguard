import { allowedInternalUrl } from "./internal-url.js";
import { requireRole, type Principal } from "@greenguard/tenant-auth";

export interface SagaSnapshot {
  TenantID: string;
  SagaID: string;
  DeviceID: string;
  AssetID: string;
  State: string;
  Version: number;
  FencingToken: number;
  DeadlineAt: string;
}

export interface SagaAudit {
  version: number;
  action: string;
  actor_sub?: string;
  reason?: string;
  recorded_at: string;
}

export interface SagaStatus {
  saga: SagaSnapshot;
  history: SagaAudit[];
}

// A W3C version-00 traceparent with non-zero IDs (ADR-0004); the saga API
// re-validates it and keeps only the sampled bit.
const TRACEPARENT =
  /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function sagaIdSegment(id: string): string {
  if (id === "." || id === "..")
    throw new UpstreamError(400, "invalid_saga_id");
  return encodeURIComponent(id);
}

export class ProvisioningClient {
  constructor(
    private readonly baseURL: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!allowedInternalUrl(baseURL)) {
      throw new Error("SAGA_API_URL must use HTTPS or loopback HTTP");
    }
  }

  private async request<T>(
    path: string,
    token: string,
    method = "GET",
    body?: object,
    key?: string,
    traceparent?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: token };
    if (body) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    if (traceparent && TRACEPARENT.test(traceparent))
      headers.traceparent = traceparent;
    const response = await this.fetcher(new URL(path, this.baseURL), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      throw new UpstreamError(
        response.status,
        problem.code ?? "upstream_unavailable",
      );
    }
    return (await response.json()) as T;
  }

  status(
    principal: Principal,
    token: string,
    id: string,
    traceparent?: string,
  ): Promise<SagaStatus> {
    requireRole(principal, "viewer", "operator", "admin");
    return this.request(
      `/v1/provisioning/${sagaIdSegment(id)}`,
      token,
      "GET",
      undefined,
      undefined,
      traceparent,
    );
  }

  start(
    principal: Principal,
    token: string,
    deviceId: string,
    assetId: string,
    key: string,
    traceparent?: string,
  ): Promise<SagaSnapshot> {
    requireRole(principal, "operator", "admin");
    if (!/^[\x21-\x7e]{1,200}$/.test(key))
      throw new UpstreamError(400, "invalid_idempotency_key");
    return this.request(
      "/v1/provisioning",
      token,
      "POST",
      { device_id: deviceId, asset_id: assetId },
      key,
      traceparent,
    );
  }

  redrive(
    principal: Principal,
    token: string,
    id: string,
    reason: string,
    traceparent?: string,
  ): Promise<SagaSnapshot> {
    requireRole(principal, "admin");
    return this.request(
      `/v1/provisioning/${sagaIdSegment(id)}/redrive`,
      token,
      "POST",
      { reason },
      undefined,
      traceparent,
    );
  }
}
