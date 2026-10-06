import { tracedFetch } from "./tracing.js";
import { allowedInternalUrl } from "./internal-url.js";
import type { Principal } from "@greenguard/tenant-auth";
import type {
  DelegatedAudience,
  DelegatedScope,
} from "@greenguard/tenant-auth/delegated";

export interface DownstreamDelegation {
  mint(
    principal: Principal,
    audience: DelegatedAudience,
    scope: DelegatedScope,
  ): Promise<string>;
}

export type AdvisorDelegation = DownstreamDelegation;

export class AdvisorClient {
  constructor(
    private readonly baseURL: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.fetcher = tracedFetch(this.fetcher);
    const url = new URL(baseURL);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !allowedInternalUrl(baseURL)
    )
      throw new Error("unsafe advisor URL");
  }
  async request(
    principal: Principal,
    delegated: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    if (
      !/^\/v1\/advisor\/proposals(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:decision|execution))?$/.test(
        path,
      )
    )
      throw new Error("invalid advisor route");
    const target = new URL(path, this.baseURL);
    if (target.origin !== new URL(this.baseURL).origin)
      throw new Error("advisor origin mismatch");
    const response = await this.fetcher(target, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        ...headers,
        Authorization: `Bearer ${delegated}`,
        "X-Tenant-ID": principal.tenantId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: [400, 401, 403, 404, 409, 429, 503].includes(response.status)
          ? response.status
          : 502,
        body: { code: "advisor_request_failed" },
      };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing advisor body");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32768) throw new Error("oversized advisor response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let result: unknown;
    try {
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return { status: 502, body: { code: "advisor_request_failed" } };
    }
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("invalid advisor response");
    return { status: response.status, body: result };
  }

  async list(principal: Principal, delegated: string, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid advisor limit");
    const target = new URL("/v1/advisor/proposals", this.baseURL);
    target.searchParams.set("limit", String(limit));
    const response = await this.fetcher(target, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${delegated}`,
        "X-Tenant-ID": principal.tenantId,
        Accept: "application/json",
      },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing advisor body");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32768) throw new Error("oversized advisor response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!response.ok) {
      return {
        status: [400, 401, 403, 404, 429, 503].includes(response.status)
          ? response.status
          : 502,
        body: { code: "advisor_request_failed" },
      };
    }
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      return { status: 502, body: { code: "advisor_request_failed" } };
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !Array.isArray((result as { items?: unknown }).items)
    )
      return { status: 502, body: { code: "advisor_request_failed" } };
    return { status: response.status, body: result };
  }
  async status(principal: Principal, delegated: string, proposalId: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        proposalId,
      )
    )
      throw new Error("invalid advisor proposal");
    const response = await this.fetcher(
      new URL(`/v1/advisor/proposals/${proposalId}`, this.baseURL),
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${delegated}`,
          "X-Tenant-ID": principal.tenantId,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: [400, 401, 403, 404, 429, 503].includes(response.status)
          ? response.status
          : 502,
        body: { code: "advisor_request_failed" },
        etag: undefined,
      };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing advisor body");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32768) throw new Error("oversized advisor response");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {
        status: 502,
        body: { code: "advisor_request_failed" },
        etag: undefined,
      };
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("invalid advisor response");
    const etag = response.headers.get("ETag");
    return {
      status: response.status,
      body,
      etag: etag && /^"[1-9][0-9]{0,9}"$/.test(etag) ? etag : undefined,
    };
  }
}
