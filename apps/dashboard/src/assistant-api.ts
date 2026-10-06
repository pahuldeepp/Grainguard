import type { AccessTokenProvider } from "./provisioning";

export interface AssistantCitation {
  document_id?: string;
  document_version?: number;
  page_start?: number;
  page_end?: number;
  chunk_id?: string;
}

export interface AssistantDocumentScope {
  mode: "question" | "document_summary";
  document_id: string;
  document_version: number;
}

export interface AssistantMessage {
  mode?: "document_summary";
  document_id?: string;
  document_version?: number;
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  citations: AssistantCitation[];
}

export interface AssistantSummaryJob {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  completed_batches: number;
  total_batches: number;
  result?: { answer: string; citations: AssistantCitation[] };
}

function parseSummaryJob(value: unknown): AssistantSummaryJob {
  const data = object(value);
  if (
    typeof data.job_id !== "string" ||
    !UUID_PATTERN.test(data.job_id) ||
    !["queued", "running", "completed", "failed", "cancelled"].includes(
      String(data.status),
    ) ||
    !Number.isSafeInteger(data.completed_batches) ||
    Number(data.completed_batches) < 0 ||
    !Number.isSafeInteger(data.total_batches) ||
    Number(data.total_batches) < 0
  )
    throw new Error("invalid_summary_job");
  const result = data.result ? object(data.result) : undefined;
  if (
    result &&
    (typeof result.answer !== "string" || result.answer.length > 1_500_000)
  )
    throw new Error("invalid_summary_job");
  return {
    job_id: data.job_id,
    status: data.status as AssistantSummaryJob["status"],
    completed_batches: Number(data.completed_batches),
    total_batches: Number(data.total_batches),
    ...(result
      ? {
          result: {
            answer: result.answer as string,
            citations: parseCitations(result.citations),
          },
        }
      : {}),
  };
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  updated_at?: string;
  last_message_at?: string;
}

export interface AssistantConversation extends AssistantConversationSummary {
  messages: AssistantMessage[];
}

export interface AssistantSuggestion {
  id: string;
  label: string;
}

export interface AssistantDocumentUpload {
  document_id: string;
  document_version: number;
  status: string;
  event_id?: string;
  idempotent?: boolean;
}

export interface AssistantDocumentStatus {
  document_id: string;
  document_version: number;
  status: string;
  chunk_count?: number;
}

export type AssistantErrorCode =
  | "document_scope_unavailable"
  | "document_summary_source_changed"
  | "document_summary_too_large"
  | "document_summary_unsafe"
  | "document_summary_incomplete"
  | "sign_in_required"
  | "access_denied"
  | "insufficient_role"
  | "pdf_too_large"
  | "invalid_pdf"
  | "rate_limited"
  | "rate_limit_unavailable"
  | "provider_rate_limited"
  | "gateway_rate_limited"
  | "assistant_not_configured"
  | "service_unavailable"
  | "assistant_unavailable"
  | "assistant_history_unavailable"
  | "assistant_suggestions_unavailable"
  | "assistant_upload_unavailable"
  | "knowledge_unavailable"
  | "knowledge_ops_unavailable"
  | "not_found"
  | "invalid_question"
  | "invalid_conversation_request"
  | "invalid_document_id"
  | "pdf_required"
  | "invalid_suggestion_usage"
  | "invalid_idempotency_key";

const BACKEND_ERROR_CODES = new Set<AssistantErrorCode>([
  "document_scope_unavailable",
  "document_summary_source_changed",
  "document_summary_too_large",
  "document_summary_unsafe",
  "document_summary_incomplete",
  "sign_in_required",
  "access_denied",
  "insufficient_role",
  "pdf_too_large",
  "invalid_pdf",
  "rate_limited",
  "rate_limit_unavailable",
  "provider_rate_limited",
  "gateway_rate_limited",
  "assistant_not_configured",
  "service_unavailable",
  "assistant_unavailable",
  "assistant_history_unavailable",
  "assistant_suggestions_unavailable",
  "assistant_upload_unavailable",
  "knowledge_unavailable",
  "knowledge_ops_unavailable",
  "not_found",
  "invalid_question",
  "invalid_conversation_request",
  "invalid_document_id",
  "pdf_required",
  "invalid_suggestion_usage",
  "invalid_idempotency_key",
]);

export class AssistantApiError extends Error {
  constructor(
    readonly code: AssistantErrorCode,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "AssistantApiError";
  }
}

/** Upload bytes may have reached the server even when its response was lost. */
export class AssistantUploadOutcomeUnknownError extends Error {
  readonly documentVersion = 1;

  constructor(
    readonly documentId: string,
    options?: ErrorOptions,
  ) {
    super("assistant_upload_outcome_unknown", options);
    this.name = "AssistantUploadOutcomeUnknownError";
  }
}

function retryDelay(response: Response): number | undefined {
  const value = Number(response.headers.get("Retry-After"));
  return Number.isFinite(value) && value > 0
    ? Math.min(3600, Math.ceil(value))
    : undefined;
}

async function safeBackendCode(
  response: Response,
): Promise<AssistantErrorCode | undefined> {
  try {
    const value: unknown = await response.clone().json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const code = (value as Record<string, unknown>).code;
    return typeof code === "string" &&
      BACKEND_ERROR_CODES.has(code as AssistantErrorCode)
      ? (code as AssistantErrorCode)
      : undefined;
  } catch {
    return undefined;
  }
}

function statusFallback(status: number): AssistantErrorCode {
  if (status === 401) return "sign_in_required";
  if (status === 403) return "access_denied";
  if (status === 413) return "pdf_too_large";
  if (status === 415) return "invalid_pdf";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 501) return "assistant_not_configured";
  if (status === 502 || status === 503 || status === 504)
    return "service_unavailable";
  return "assistant_unavailable";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_SUGGESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_assistant_response");
  return value as Record<string, unknown>;
}

function parseCitations(value: unknown): AssistantCitation[] {
  if (!Array.isArray(value)) throw new Error("invalid_assistant_response");
  return value.filter((item): item is AssistantCitation => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const citation = item as Record<string, unknown>;
    return (
      (citation.document_id === undefined ||
        typeof citation.document_id === "string") &&
      (citation.document_version === undefined ||
        typeof citation.document_version === "number") &&
      (citation.chunk_id === undefined ||
        typeof citation.chunk_id === "string") &&
      (citation.page_start === undefined ||
        typeof citation.page_start === "number") &&
      (citation.page_end === undefined || typeof citation.page_end === "number")
    );
  });
}

function parseMessage(value: unknown): AssistantMessage {
  const message = object(value);
  if (
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant") ||
    typeof message.content !== "string"
  )
    throw new Error("invalid_assistant_response");
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ...(typeof message.created_at === "string"
      ? { created_at: message.created_at }
      : {}),
    citations:
      message.citations === undefined ? [] : parseCitations(message.citations),
    ...(message.mode === "document_summary" &&
    typeof message.document_id === "string" &&
    Number.isInteger(message.document_version) &&
    Number(message.document_version) > 0
      ? {
          mode: "document_summary" as const,
          document_id: message.document_id,
          document_version: Number(message.document_version),
        }
      : {}),
  };
}

function parseSummary(value: unknown): AssistantConversationSummary {
  const summary = object(value);
  if (
    typeof summary.id !== "string" ||
    !summary.id ||
    typeof summary.title !== "string"
  )
    throw new Error("invalid_assistant_response");
  return {
    id: summary.id,
    title: summary.title,
    ...(typeof summary.updated_at === "string"
      ? { updated_at: summary.updated_at }
      : {}),
    ...(typeof summary.last_message_at === "string"
      ? { last_message_at: summary.last_message_at }
      : {}),
  };
}

function parseSuggestions(value: unknown): AssistantSuggestion[] {
  const items = object(value).suggestions;
  if (!Array.isArray(items)) throw new Error("invalid_assistant_suggestions");
  return items.flatMap((item): AssistantSuggestion[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !SAFE_SUGGESTION_ID.test(candidate.id) ||
      typeof candidate.label !== "string" ||
      !candidate.label.trim() ||
      candidate.label.length > 240
    )
      return [];
    return [{ id: candidate.id, label: candidate.label.trim() }];
  });
}

export class AssistantApi {
  constructor(
    private readonly getAccessToken: AccessTokenProvider,
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = 15_000,
  ): Promise<Response> {
    const token = await this.getAccessToken();
    if (!token) throw new Error("sign_in_required");
    init.signal?.throwIfAborted();
    const response = await this.fetcher(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const code =
        (await safeBackendCode(response)) ?? statusFallback(response.status);
      const retryAfterSeconds =
        code === "rate_limited" ||
        code === "provider_rate_limited" ||
        code === "gateway_rate_limited"
          ? (retryDelay(response) ?? 1)
          : undefined;
      throw new AssistantApiError(code, response.status, retryAfterSeconds);
    }
    return response;
  }

  async listConversations(): Promise<AssistantConversationSummary[]> {
    const value = object(
      await (
        await this.request("/v1/assistant/conversations", { method: "GET" })
      ).json(),
    );
    if (!Array.isArray(value.items))
      throw new Error("invalid_assistant_response");
    return value.items.map(parseSummary);
  }

  async createConversation(
    initialMessage?: string,
  ): Promise<AssistantConversationSummary> {
    const body = initialMessage
      ? JSON.stringify({ title: initialMessage })
      : "{}";
    const value = object(
      await (
        await this.request("/v1/assistant/conversations", {
          method: "POST",
          body,
        })
      ).json(),
    );
    if (typeof value.id !== "string" || !value.id)
      throw new Error("invalid_assistant_response");
    return {
      id: value.id,
      title: typeof value.title === "string" ? value.title : "New chat",
      ...(typeof value.updated_at === "string"
        ? { updated_at: value.updated_at }
        : {}),
      ...(typeof value.last_message_at === "string"
        ? { last_message_at: value.last_message_at }
        : {}),
    };
  }

  async getConversation(id: string): Promise<AssistantConversation> {
    const path = `/v1/assistant/conversations/${encodeURIComponent(id)}`;
    const value = object(
      await (await this.request(path, { method: "GET" })).json(),
    );
    const conversation = parseSummary(value.conversation);
    if (!Array.isArray(value.messages))
      throw new Error("invalid_assistant_response");
    return { ...conversation, messages: value.messages.map(parseMessage) };
  }

  async deleteConversation(id: string): Promise<void> {
    await this.request(
      `/v1/assistant/conversations/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async sendMessage(
    id: string,
    question: string,
    scope?: AssistantDocumentScope,
  ): Promise<{
    user_message: AssistantMessage;
    assistant_message: AssistantMessage;
  }> {
    const path = `/v1/assistant/conversations/${encodeURIComponent(id)}/messages`;
    const value = object(
      await (
        await this.request(
          path,
          { method: "POST", body: JSON.stringify({ question, ...scope }) },
          scope?.mode === "document_summary" ? 320_000 : 30_000,
        )
      ).json(),
    );
    return {
      user_message: parseMessage(value.user_message),
      assistant_message: parseMessage(value.assistant_message),
    };
  }

  async startSummaryJob(
    documentId: string,
    version: number,
    question: string,
    idempotencyKey: string,
  ): Promise<AssistantSummaryJob> {
    return parseSummaryJob(
      await (
        await this.request("/v1/assistant/summary-jobs", {
          method: "POST",
          body: JSON.stringify({
            document_id: documentId,
            document_version: version,
            question,
            idempotency_key: idempotencyKey,
          }),
        })
      ).json(),
    );
  }

  async getSummaryJob(id: string): Promise<AssistantSummaryJob> {
    return parseSummaryJob(
      await (
        await this.request(
          `/v1/assistant/summary-jobs/${encodeURIComponent(id)}`,
        )
      ).json(),
    );
  }

  async cancelSummaryJob(id: string): Promise<AssistantSummaryJob> {
    return parseSummaryJob(
      await (
        await this.request(
          `/v1/assistant/summary-jobs/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        )
      ).json(),
    );
  }

  async getDocumentSourceInfo(
    id: string,
    version: number,
  ): Promise<{ filename: string }> {
    const value = object(
      await (
        await this.request(
          `/v1/assistant/documents/${encodeURIComponent(id)}/versions/${version}/source-info`,
        )
      ).json(),
    );
    if (
      typeof value.filename !== "string" ||
      !value.filename ||
      value.filename.length > 240
    )
      throw new Error("invalid_source_metadata");
    return { filename: value.filename };
  }

  async getDocumentSource(
    id: string,
    version: number,
  ): Promise<{ blob: Blob; filename: string }> {
    const response = await this.request(
      `/v1/assistant/documents/${encodeURIComponent(id)}/versions/${version}/source`,
      { headers: { Accept: "application/pdf" } },
      30_000,
    );
    if (
      response.headers.get("Content-Type")?.split(";", 1)[0] !==
      "application/pdf"
    )
      throw new Error("invalid_source_pdf");
    const blob = await response.blob();
    if (!blob.size || blob.size > 25 * 1024 * 1024)
      throw new Error("invalid_source_pdf");
    const encoded = response.headers
      .get("Content-Disposition")
      ?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
    return {
      blob,
      filename: encoded ? decodeURIComponent(encoded) : `document-${id}.pdf`,
    };
  }

  async listDocuments(): Promise<AssistantManagedDocument[]> {
    const payload = await (
      await this.request("/v1/assistant/documents", { method: "GET" })
    ).json();
    if (!payload || !Array.isArray(payload.documents))
      throw new Error("invalid_documents");
    return payload.documents.map((item: AssistantManagedDocument) => {
      if (
        !UUID_PATTERN.test(item.document_id) ||
        !Number.isInteger(item.document_version) ||
        item.document_version < 1 ||
        typeof item.filename !== "string" ||
        typeof item.status !== "string"
      )
        throw new Error("invalid_documents");
      return item;
    });
  }

  async deleteDocument(id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) throw new Error("invalid_document_id");
    await this.request(`/v1/assistant/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async getSuggestions(): Promise<AssistantSuggestion[]> {
    return parseSuggestions(
      await (
        await this.request("/v1/assistant/suggestions", { method: "GET" })
      ).json(),
    );
  }

  async recordSuggestionUsed(id: string): Promise<void> {
    if (!SAFE_SUGGESTION_ID.test(id)) throw new Error("invalid_suggestion_id");
    await this.request(
      `/v1/assistant/suggestions/${encodeURIComponent(id)}/used`,
      { method: "POST" },
    );
  }

  async uploadPdf(
    file: File,
    signal?: AbortSignal,
  ): Promise<AssistantDocumentUpload> {
    if (
      !/\.pdf$/i.test(file.name) ||
      file.size === 0 ||
      file.size > 25 * 1024 * 1024
    )
      throw new Error("invalid_pdf");
    const documentId = globalThis.crypto.randomUUID();
    let response: Response;
    try {
      response = await this.request(
        `/v1/assistant/documents/${documentId}`,
        {
          method: "POST",
          signal,
          body: file,
          headers: {
            "Content-Type": "application/pdf",
            "X-Document-Version": "1",
            "X-PDF-Filename": encodeURIComponent(file.name),
          },
        },
        60_000,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && error.message === "access_denied")
        throw new Error("insufficient_role", { cause: error });
      // A failed response does not prove the upload transaction failed. Never
      // repost the bytes: check the same identity for a durable accepted record.
      const ambiguous =
        error instanceof AssistantApiError
          ? [502, 503, 504].includes(error.status)
          : error instanceof TypeError ||
            (error instanceof DOMException &&
              ["TimeoutError", "AbortError"].includes(error.name));
      if (ambiguous) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt > 0)
            await new Promise((resolve) => setTimeout(resolve, 500));
          try {
            return await this.getDocumentStatus(documentId, 1, 5_000, signal);
          } catch (statusError) {
            if (
              statusError instanceof AssistantApiError &&
              [401, 403].includes(statusError.status)
            )
              throw statusError;
          }
        }
        throw new AssistantUploadOutcomeUnknownError(documentId, {
          cause: error,
        });
      }
      throw error;
    }
    const value = object(await response.json());
    if (
      value.document_id !== documentId ||
      value.document_version !== 1 ||
      value.status !== "queued" ||
      typeof value.event_id !== "string" ||
      typeof value.idempotent !== "boolean"
    )
      throw new Error("invalid_assistant_response");
    return value as unknown as AssistantDocumentUpload;
  }

  async getDocumentStatus(
    documentId: string,
    version: number,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<AssistantDocumentStatus> {
    if (
      !/^[0-9a-f-]{36}$/i.test(documentId) ||
      !Number.isInteger(version) ||
      version < 1
    )
      throw new Error("invalid_document_id");
    const value = object(
      await (
        await this.request(
          `/v1/assistant/documents/${documentId}/versions/${version}`,
          { method: "GET", signal },
          timeoutMs,
        )
      ).json(),
    );
    if (
      value.document_id !== documentId ||
      value.document_version !== version ||
      typeof value.status !== "string"
    )
      throw new Error("invalid_assistant_response");
    return value as unknown as AssistantDocumentStatus;
  }
}

export interface AssistantManagedDocument {
  document_id: string;
  document_version: number;
  filename: string;
  status: string;
  created_at?: string;
}
