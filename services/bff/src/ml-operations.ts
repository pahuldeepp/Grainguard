import type { Principal } from "@greenguard/tenant-auth";

export interface MlModelStatus {
  name: string;
  version: string;
  mode: "shadow" | "canary" | "champion";
  dataOrigin: string;
  productionEligible: boolean;
  status: "healthy" | "degraded" | "unavailable";
}

export interface MlDriftMetric {
  feature: string;
  psi: number | null;
  sampleCount: number;
  status: "warming" | "healthy" | "elevated";
}

export interface MlOperationsSnapshot {
  capturedAt: string;
  scorerReady: boolean;
  predictionsTotal: number;
  inferenceP95Ms: number | null;
  canaryPercentage: number;
  model: MlModelStatus;
  models: Array<MlModelStatus & { createdAt: string }>;
  drift: MlDriftMetric[];
  performance: {
    status: "unavailable" | "warming" | "available";
    brierScore: number | null;
    sampleCount: number;
    evaluatedAt: string | null;
  };
  retraining: {
    status: "idle" | "running" | "passed" | "rejected";
    runId: string | null;
    completedAt: string | null;
  };
}

export type MlAction = "promote" | "rollback" | "retrain";
export interface MlActionResult { action: MlAction; accepted: boolean; message: string; runId?: string | null; }

export class MlOperationsUpstreamError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "MlOperationsUpstreamError";
  }
}

export interface MlOperationsClient {
  snapshot(principal: Principal, authorization: string): Promise<MlOperationsSnapshot>;
  action(principal: Principal, authorization: string, action: MlAction, version?: string): Promise<MlActionResult>;
}

/**
 * Read-only adapter for the internal ML operations endpoint. Tenant identity is
 * supplied by the verified BFF principal, never accepted from browser input.
 */
export class HttpMlOperationsClient implements MlOperationsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async snapshot(principal: Principal, authorization: string) {
    const url = new URL("/operations", this.baseUrl);
    url.searchParams.set("tenant_id", principal.tenantId);
    const response = await this.fetcher(url, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new MlOperationsUpstreamError(response.status, "ml_operations_unavailable");
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object")
      throw new MlOperationsUpstreamError(502, "invalid_ml_operations_response");
    return body as MlOperationsSnapshot;
  }

  async action(principal: Principal, authorization: string, action: MlAction, version?: string) {
    const url = new URL(`/operations/${action}`, this.baseUrl);
    const response = await this.fetcher(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenant_id: principal.tenantId, version }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string; runId?: string };
    if (!response.ok)
      throw new MlOperationsUpstreamError(response.status, body.message ?? "ml_action_unavailable");
    return { action, accepted: true, message: body.message ?? "accepted", runId: body.runId };
  }
}
