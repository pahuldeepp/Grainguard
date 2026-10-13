import type { Principal } from "@greenguard/tenant-auth";
import { randomUUID } from "node:crypto";
import { allowedInternalUrl } from "./internal-url.js";

export type RagOpsSection =
  "overview" | "retrieval" | "documents" | "evaluations" | "cache" | "traces";

const SAFE_UPSTREAM_CODES = new Set([
  "assistant_not_configured",
  "service_unavailable",
  "provider_rate_limited",
  "gateway_rate_limited",
  "not_found",
  "access_denied",
  "sign_in_required",
  "invalid_pdf",
  "pdf_too_large",
  "document_scope_unavailable",
  "document_summary_source_changed",
  "document_summary_too_large",
  "document_summary_unsafe",
  "document_summary_incomplete",
]);

function combinedSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
}

export type DocumentSummaryScope =
  | {
      mode: "question" | "document_summary" | "structured";
      document_id: string;
      document_version: number;
    }
  | { mode: "structured" };

/** Scope is data selection only; authorization always comes from the verified principal. */
export function parseAssistantQuery(
  body: unknown,
): { question: string; scope?: DocumentSummaryScope } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        !["question", "mode", "document_id", "document_version"].includes(key),
    ) ||
    typeof value.question !== "string" ||
    value.question.trim().length < 4 ||
    value.question.length > 2000
  )
    return null;
  if (
    value.mode === undefined &&
    value.document_id === undefined &&
    value.document_version === undefined
  )
    return { question: value.question };
  if (
    value.mode === "structured" &&
    value.document_id === undefined &&
    value.document_version === undefined
  )
    return { question: value.question, scope: { mode: "structured" } };
  if (
    (value.mode !== "document_summary" &&
      value.mode !== "question" &&
      value.mode !== "structured") ||
    typeof value.document_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value.document_id,
    ) ||
    !Number.isSafeInteger(value.document_version) ||
    (value.document_version as number) < 1 ||
    (value.document_version as number) > 2147483647
  )
    return null;
  return {
    question: value.question,
    scope: {
      mode: value.mode,
      document_id: value.document_id,
      document_version: value.document_version as number,
    },
  };
}

type KnowledgeResult = {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
};

export class KnowledgeClient {
  private readonly baseURL: URL;

  constructor(
    baseURL: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(baseURL);
    if (
      !allowedInternalUrl(baseURL) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("unsafe knowledge service URL");
    this.baseURL = url;
  }

  async ask(
    principal: Principal,
    authorization: string,
    question: string,
    scope?: DocumentSummaryScope,
    callerSignal?: AbortSignal,
  ) {
    if (principal.principalType === "service")
      throw new Error("human principal required");
    return this.request(
      new URL("/v1/query", this.baseURL),
      {
        method: "POST",
        redirect: "error",
        signal: combinedSignal(
          scope?.mode === "document_summary" ? 300_000 : 25_000,
          callerSignal,
        ),
        headers: {
          Authorization: authorization,
          "X-Tenant-ID": principal.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ question, ...scope }),
      },
      [400, 401, 403, 404, 409, 422, 429, 503],
      scope?.mode === "document_summary" ? 256 * 1024 : 65_536,
    );
  }

  async authorizeStructured(
    principal: Principal,
    authorization: string,
    evidence: {
      operation: string;
      status: string | null;
      answer_sha256: string;
    },
    scope?: { document_id: string; document_version: number },
    callerSignal?: AbortSignal,
  ) {
    if (principal.principalType === "service")
      throw new Error("human principal required");
    return this.request(
      new URL("/v1/structured/authorize", this.baseURL),
      {
        method: "POST",
        redirect: "error",
        signal: combinedSignal(5000, callerSignal),
        headers: {
          Authorization: authorization,
          "X-Tenant-ID": principal.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ evidence, ...scope }),
      },
      [400, 401, 403, 404, 503],
    );
  }

  async operations(
    principal: Principal,
    authorization: string,
    section: RagOpsSection,
  ) {
    if (
      principal.principalType === "service" ||
      !principal.roles.some((role) => role === "operator" || role === "admin")
    )
      throw new Error("operator principal required");
    return this.request(
      new URL(`/v1/ops/${section}`, this.baseURL),
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: authorization,
          "X-Tenant-ID": principal.tenantId,
          Accept: "application/json",
        },
      },
      [401, 403, 404, 503],
    );
  }

  async recordSuggestionUsage(
    principal: Principal,
    authorization: string,
    suggestionId: string,
    eventId: string = randomUUID(),
  ) {
    if (principal.principalType === "service")
      throw new Error("human principal required");
    return this.request(
      new URL(
        `/v1/assistant/suggestions/${encodeURIComponent(suggestionId)}/used`,
        this.baseURL,
      ),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: authorization,
          "X-Tenant-ID": principal.tenantId,
          "Idempotency-Key": eventId,
          Accept: "application/json",
        },
      },
      [400, 401, 403, 404, 503],
    );
  }

  async listConversations(principal: Principal, authorization: string) {
    return this.conversationRequest(
      principal,
      authorization,
      "/v1/assistant/conversations",
      "GET",
    );
  }

  async createConversation(
    principal: Principal,
    authorization: string,
    title?: string,
  ) {
    return this.conversationRequest(
      principal,
      authorization,
      "/v1/assistant/conversations",
      "POST",
      title ? { title } : {},
    );
  }

  async getConversation(
    principal: Principal,
    authorization: string,
    id: string,
  ) {
    return this.conversationRequest(
      principal,
      authorization,
      `/v1/assistant/conversations/${encodeURIComponent(id)}`,
      "GET",
    );
  }

  async appendConversationMessage(
    principal: Principal,
    authorization: string,
    id: string,
    question: string,
    scope?: DocumentSummaryScope,
    callerSignal?: AbortSignal,
  ) {
    return this.conversationRequest(
      principal,
      authorization,
      `/v1/assistant/conversations/${encodeURIComponent(id)}/messages`,
      "POST",
      { question, ...scope },
      callerSignal,
    );
  }

  async deleteConversation(
    principal: Principal,
    authorization: string,
    id: string,
  ) {
    return this.conversationRequest(
      principal,
      authorization,
      `/v1/assistant/conversations/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }

  async listAssistantDocuments(principal: Principal, authorization: string) {
    return this.conversationRequest(
      principal,
      authorization,
      "/v1/documents",
      "GET",
    );
  }

  async deleteAssistantDocument(
    principal: Principal,
    authorization: string,
    id: string,
  ) {
    if (
      !principal.roles.some((role) => role === "operator" || role === "admin")
    )
      throw new Error("operator principal required");
    return this.conversationRequest(
      principal,
      authorization,
      `/v1/documents/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }

  async uploadAssistantPdf(
    principal: Principal,
    authorization: string,
    documentId: string,
    pdf: Buffer,
    filename?: string,
  ) {
    if (
      principal.principalType === "service" ||
      !principal.roles.some((role) => role === "operator" || role === "admin")
    )
      throw new Error("operator principal required");
    return this.request(
      new URL(`/v1/documents/${encodeURIComponent(documentId)}`, this.baseURL),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: authorization,
          "X-Tenant-ID": principal.tenantId,
          "X-Document-Version": "1",
          ...(filename ? { "X-PDF-Filename": filename } : {}),
          "Content-Type": "application/pdf",
          Accept: "application/json",
        },
        body: pdf as Uint8Array<ArrayBuffer>,
      },
      [400, 401, 403, 404, 409, 413, 415, 429, 503],
    );
  }

  async documentSource(
    principal: Principal,
    authorization: string,
    id: string,
    version: number,
    metadataOnly: boolean,
    signal?: AbortSignal,
  ) {
    if (principal.principalType === "service")
      throw new Error("human principal required");
    const url = new URL(
      `/v1/documents/${encodeURIComponent(id)}/versions/${version}/${metadataOnly ? "source-info" : "source"}`,
      this.baseURL,
    );
    const init: RequestInit = {
      method: "GET",
      redirect: "error",
      signal: combinedSignal(30_000, signal),
      headers: {
        Authorization: authorization,
        "X-Tenant-ID": principal.tenantId,
        Accept: metadataOnly ? "application/json" : "application/pdf",
      },
    };
    if (metadataOnly)
      return this.request(url, init, [400, 401, 403, 404, 429, 503]);
    try {
      const upstream = await this.fetcher(url, init);
      if (!upstream.ok)
        return this.readResponse(
          upstream,
          [400, 401, 403, 404, 429, 503],
          65_536,
        );
      if (
        upstream.status !== 200 ||
        upstream.headers.get("Content-Type")?.split(";", 1)[0] !==
          "application/pdf" ||
        !upstream.body
      )
        throw new Error("invalid source PDF");
      const reader = upstream.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 25 * 1024 * 1024) throw new Error("oversized source PDF");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const pdf = Buffer.concat(chunks);
      if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-")
        throw new Error("invalid source PDF");
      const disposition = upstream.headers.get("Content-Disposition");
      return {
        status: 200,
        body: {},
        pdf,
        disposition:
          disposition &&
          /^inline; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/.test(disposition)
            ? disposition
            : "inline",
      };
    } catch {
      return { status: 503, body: { code: "service_unavailable" } };
    }
  }

  async assistantDocumentStatus(
    principal: Principal,
    authorization: string,
    documentId: string,
  ) {
    if (principal.principalType === "service")
      throw new Error("human principal required");
    return this.request(
      new URL(
        `/v1/documents/${encodeURIComponent(documentId)}/versions/1`,
        this.baseURL,
      ),
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: authorization,
          "X-Tenant-ID": principal.tenantId,
          Accept: "application/json",
        },
      },
      [401, 403, 404, 503],
    );
  }

  async summaryJob(
    principal: Principal,
    authorization: string,
    method: "GET" | "POST" | "DELETE",
    id?: string,
    body?: Record<string, unknown>,
  ) {
    return this.conversationRequest(
      principal,
      authorization,
      `/v1/assistant/summary-jobs${id ? `/${encodeURIComponent(id)}` : ""}`,
      method,
      body,
    );
  }

  private async conversationRequest(
    principal: Principal,
    authorization: string,
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ) {
    if (principal.principalType === "service")
      throw new Error("human principal required");
    return this.request(
      new URL(path, this.baseURL),
      {
        method,
        redirect: "error",
        signal: combinedSignal(
          method === "POST" && path.endsWith("/messages")
            ? body?.mode === "document_summary"
              ? 300_000
              : 30_000
            : 5000,
          callerSignal,
        ),
        headers: {
          Authorization: authorization,
          "X-Tenant-ID": principal.tenantId,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      [400, 401, 403, 404, 409, 422, 429, 503],
      method === "GET" &&
        /^\/v1\/assistant\/conversations\/[0-9a-f-]{36}$/i.test(path)
        ? 9 * 1_048_576
        : path.startsWith("/v1/assistant/summary-jobs")
          ? 2 * 1_048_576
          : body?.mode === "document_summary"
            ? 256 * 1024
            : 65_536,
    );
  }

  private async request(
    url: URL,
    init: RequestInit,
    forwardedStatuses: number[],
    maxBytes = 65_536,
  ): Promise<KnowledgeResult> {
    try {
      return await this.readResponse(
        await this.fetcher(url, init),
        forwardedStatuses,
        maxBytes,
      );
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      const badBody =
        error instanceof SyntaxError ||
        (error instanceof Error &&
          [
            "missing upstream body",
            "oversized upstream body",
            "invalid upstream body",
          ].includes(error.message));
      return {
        status: timedOut ? 504 : badBody ? 502 : 503,
        body: { code: "service_unavailable" },
      };
    }
  }

  private async readResponse(
    response: Response,
    forwardedStatuses: number[],
    maxBytes = 65_536,
  ): Promise<KnowledgeResult> {
    if (!response.ok) {
      const retry = Number(response.headers.get("Retry-After"));
      const upstreamCode = await this.readSafeErrorCode(response);
      const code =
        response.status === 429
          ? upstreamCode === "provider_rate_limited" ||
            upstreamCode === "gateway_rate_limited"
            ? upstreamCode
            : "rate_limited"
          : (upstreamCode ??
            (response.status === 401
              ? "sign_in_required"
              : response.status === 403
                ? "access_denied"
                : response.status === 404
                  ? "not_found"
                  : response.status === 413
                    ? "pdf_too_large"
                    : response.status === 415
                      ? "invalid_pdf"
                      : "service_unavailable"));
      return {
        status: forwardedStatuses.includes(response.status)
          ? response.status
          : 502,
        body: { code },
        ...(response.status === 429 ||
        response.status === 503 ||
        response.status === 504
          ? {
              retryAfter:
                Number.isFinite(retry) && retry > 0
                  ? Math.min(3600, Math.ceil(retry))
                  : 1,
            }
          : {}),
      };
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing upstream body");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) throw new Error("oversized upstream body");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("invalid upstream body");
    return { status: response.status, body: body as Record<string, unknown> };
  }

  private async readSafeErrorCode(
    response: Response,
  ): Promise<string | undefined> {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 4096) return undefined;
        chunks.push(value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body))
        return undefined;
      const errorBody = body as Record<string, unknown>;
      const code =
        typeof errorBody.code === "string"
          ? errorBody.code
          : typeof errorBody.error === "string"
            ? errorBody.error
            : errorBody.detail;
      return typeof code === "string" && SAFE_UPSTREAM_CODES.has(code)
        ? code
        : undefined;
    } catch {
      return undefined;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
