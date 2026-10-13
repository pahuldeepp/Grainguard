import { allowedInternalUrl } from "./internal-url.js";
import { requireRole, type Principal } from "@greenguard/tenant-auth";

export class AlertUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface AlertView {
  alertId: string;
  ruleId: string;
  binId: string;
  state: string;
  severity: string;
  score: number;
  version: string;
  openWindowStart: string;
  openedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  escalationLevel: number;
}

export interface AlertPage {
  items: AlertView[];
  nextCursor: string | null;
}
export interface AlertHistoryPage {
  alertId: string;
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  complete: boolean;
  source: { status: string; reasonCode: string | null };
}

export interface AlertAcknowledgement {
  episodeId: string;
  state: string;
  version: string;
  eventId: string;
}

const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export class AlertClient {
  constructor(
    private readonly baseURL: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!allowedInternalUrl(baseURL)) {
      throw new Error("ALERT_API_URL must use HTTPS or loopback HTTP");
    }
  }

  private async request<T>(
    path: string,
    token: string,
    method = "GET",
    key?: string,
    version?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: token };
    if (key) headers["Idempotency-Key"] = key;
    if (version) headers["If-Match"] = `"${version}"`;
    const response = await this.fetcher(new URL(path, this.baseURL), {
      method,
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      throw new AlertUpstreamError(
        response.status,
        body.code ?? "alert_unavailable",
      );
    }
    return (await response.json()) as T;
  }

  list(
    principal: Principal,
    token: string,
    limit: number,
    after?: string,
    state?: string,
  ): Promise<AlertPage> {
    requireRole(principal, "viewer", "operator", "admin");
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after && !UUID.test(after)) ||
      (state && !["open", "acknowledged", "resolved"].includes(state))
    ) {
      throw new AlertUpstreamError(400, "invalid_alert_page");
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after", after);
    if (state) params.set("state", state);
    return this.request(`/v1/alerts?${params}`, token);
  }

  get(principal: Principal, token: string, id: string): Promise<AlertView> {
    requireRole(principal, "viewer", "operator", "admin");
    if (!UUID.test(id)) throw new AlertUpstreamError(400, "invalid_alert_id");
    return this.request(`/v1/alerts/${id}`, token);
  }

  history(
    principal: Principal,
    token: string,
    id: string,
    limit: number,
    after?: string,
  ): Promise<AlertHistoryPage> {
    requireRole(principal, "viewer", "operator", "admin");
    if (
      !UUID.test(id) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after !== undefined &&
        (after.length > 2048 || !/^[A-Za-z0-9_.-]+$/.test(after)))
    )
      throw new AlertUpstreamError(400, "invalid_alert_history");
    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set("after", after);
    return this.request(`/v1/alerts/${id}/transitions?${params}`, token);
  }

  acknowledge(
    principal: Principal,
    token: string,
    id: string,
    version: string,
    key: string,
  ): Promise<AlertAcknowledgement> {
    requireRole(principal, "operator", "admin");
    if (
      !UUID.test(id) ||
      !/^[1-9]\d{0,18}$/.test(version) ||
      !/^[\x21-\x7e]{1,200}$/.test(key)
    ) {
      throw new AlertUpstreamError(400, "invalid_alert_command");
    }
    return this.request(
      `/v1/alerts/${id}/acknowledge`,
      token,
      "POST",
      key,
      version,
    );
  }
}
