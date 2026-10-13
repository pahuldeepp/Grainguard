import { afterEach, expect, test, vi } from "vitest";
import {
  AssistantApi,
  AssistantUploadOutcomeUnknownError,
} from "./assistant-api";

afterEach(() => vi.unstubAllGlobals());

test("lists authenticated conversations without sending client tenant or user IDs", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "c1",
              title: "Storage",
              updated_at: "today",
              last_message_at: "today",
            },
          ],
        }),
      ),
  );
  const api = new AssistantApi(async () => "session-token", fetcher);
  await expect(api.listConversations()).resolves.toEqual([
    {
      id: "c1",
      title: "Storage",
      updated_at: "today",
      last_message_at: "today",
    },
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/assistant/conversations",
    expect.objectContaining({
      method: "GET",
      cache: "no-store",
      headers: {
        Authorization: "Bearer session-token",
        Accept: "application/json",
      },
    }),
  );
});

test("creates a titled conversation, loads detail, and posts only the question to the message endpoint", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "c1", title: "New chat" })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          conversation: { id: "c1", title: "Storage" },
          messages: [
            {
              id: "u1",
              role: "user",
              content: "How to store grain?",
              citations: [],
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user_message: {
            id: "u2",
            role: "user",
            content: "How about moisture?",
            citations: [],
          },
          assistant_message: {
            id: "a2",
            role: "assistant",
            content: "Keep below target.",
            citations: [
              {
                document_id: "d1",
                document_version: 3,
                chunk_id: "k1",
                page_start: 2,
              },
            ],
          },
        }),
      ),
    );
  const api = new AssistantApi(async () => "session-token", fetcher);
  await expect(api.createConversation("How to store grain?")).resolves.toEqual({
    id: "c1",
    title: "New chat",
  });
  await expect(api.getConversation("c1")).resolves.toMatchObject({
    id: "c1",
    messages: [{ id: "u1", content: "How to store grain?" }],
  });
  await expect(
    api.sendMessage("c1", "How about moisture?"),
  ).resolves.toMatchObject({
    user_message: { id: "u2", role: "user" },
    assistant_message: {
      id: "a2",
      role: "assistant",
      citations: [
        {
          document_id: "d1",
          document_version: 3,
          chunk_id: "k1",
          page_start: 2,
        },
      ],
    },
  });
  expect(fetcher.mock.calls[0][0]).toBe("/v1/assistant/conversations");
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ title: "How to store grain?" }),
  });
  expect(fetcher.mock.calls[1][0]).toBe("/v1/assistant/conversations/c1");
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "GET" });
  expect(fetcher.mock.calls[2][0]).toBe(
    "/v1/assistant/conversations/c1/messages",
  );
  expect(fetcher.mock.calls[2][1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ question: "How about moisture?" }),
  });
  expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/tenant|user_id/);
});

test("soft-deletes an authenticated conversation by server ID", async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  const api = new AssistantApi(async () => "session-token", fetcher);
  await expect(api.deleteConversation("saved-123")).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/assistant/conversations/saved-123",
    expect.objectContaining({
      method: "DELETE",
      cache: "no-store",
      headers: {
        Authorization: "Bearer session-token",
        Accept: "application/json",
      },
    }),
  );
});

test("maps authorization, rate-limit, and not-yet-wired backend responses", async () => {
  const denied = new AssistantApi(
    async () => "token",
    async () => new Response("", { status: 403 }),
  );
  await expect(denied.listConversations()).rejects.toThrow("access_denied");
  const limited = new AssistantApi(
    async () => "token",
    async () =>
      new Response("", {
        status: 429,
        headers: { "Retry-After": "7" },
      }),
  );
  await expect(limited.createConversation()).rejects.toMatchObject({
    message: "rate_limited",
    retryAfterSeconds: 7,
  });
  const missing = new AssistantApi(
    async () => "token",
    async () => new Response("", { status: 404 }),
  );
  await expect(missing.listConversations()).rejects.toThrow(
    "assistant_not_configured",
  );
});

test("parses only allowlisted backend error codes and preserves safe status and retry metadata", async () => {
  for (const code of ["provider_rate_limited", "gateway_rate_limited"]) {
    const providerLimited = new AssistantApi(
      async () => "token",
      async () =>
        new Response(
          JSON.stringify({
            code,
            message: "private provider response",
          }),
          { status: 429, headers: { "Retry-After": "9" } },
        ),
    );
    await expect(
      providerLimited.sendMessage("conversation-1", "question"),
    ).rejects.toMatchObject({
      name: "AssistantApiError",
      message: code,
      code,
      status: 429,
      retryAfterSeconds: 9,
    });
  }

  const limiterUnavailable = new AssistantApi(
    async () => "token",
    async () =>
      new Response(
        JSON.stringify({
          code: "rate_limit_unavailable",
          detail: "redis host/password",
        }),
        { status: 503 },
      ),
  );
  await expect(limiterUnavailable.listConversations()).rejects.toMatchObject({
    message: "rate_limit_unavailable",
    code: "rate_limit_unavailable",
    status: 503,
  });

  const staleConversation = new AssistantApi(
    async () => "token",
    async () =>
      new Response(
        JSON.stringify({
          code: "not_found",
          detail: "internal lookup diagnostics",
        }),
        { status: 404 },
      ),
  );
  await expect(
    staleConversation.getConversation("deleted-chat"),
  ).rejects.toMatchObject({
    message: "not_found",
    code: "not_found",
    status: 404,
  });

  const forged = new AssistantApi(
    async () => "token",
    async () =>
      new Response(
        JSON.stringify({
          code: "provider says secret-key-is-here",
          detail: "do not show",
        }),
        { status: 503 },
      ),
  );
  await expect(forged.listConversations()).rejects.toMatchObject({
    message: "service_unavailable",
    code: "service_unavailable",
    status: 503,
  });
});

test("loads safe ranked suggestion IDs and records only the ID as usage", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          suggestions: [
            { id: "grain_moisture-1", label: "Ask about grain moisture" },
            { id: "bad/id", label: "Ignore unsafe ID" },
            { id: "empty_label", label: "  " },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const api = new AssistantApi(async () => "session-token", fetcher);
  await expect(api.getSuggestions()).resolves.toEqual([
    { id: "grain_moisture-1", label: "Ask about grain moisture" },
  ]);
  await api.recordSuggestionUsed("grain_moisture-1");
  expect(fetcher.mock.calls[0][0]).toBe("/v1/assistant/suggestions");
  expect(fetcher.mock.calls[1][0]).toBe(
    "/v1/assistant/suggestions/grain_moisture-1/used",
  );
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain(
    "Ask about grain moisture",
  );
});

test("rejects unsafe suggestion IDs before requesting the usage endpoint", async () => {
  const fetcher = vi.fn();
  const api = new AssistantApi(async () => "token", fetcher);
  await expect(api.recordSuggestionUsed("../private")).rejects.toThrow(
    "invalid_suggestion_id",
  );
  expect(fetcher).not.toHaveBeenCalled();
});

test("uploads a raw PDF with a server-generated document ID and reads its indexing status", async () => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "12345678-abcd-4abc-8abc-123456789abc",
  );
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          document_id: "12345678-abcd-4abc-8abc-123456789abc",
          document_version: 1,
          status: "queued",
          event_id: "event-1",
          idempotent: false,
        }),
        { status: 202 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          document_id: "12345678-abcd-4abc-8abc-123456789abc",
          document_version: 1,
          status: "ready",
        }),
      ),
    );
  const api = new AssistantApi(async () => "session-token", fetcher);
  const file = new File(["%PDF-test"], "manual.pdf", {
    type: "application/pdf",
  });
  await expect(api.uploadPdf(file)).resolves.toMatchObject({
    status: "queued",
    document_version: 1,
  });
  await expect(
    api.getDocumentStatus("12345678-abcd-4abc-8abc-123456789abc", 1),
  ).resolves.toMatchObject({ status: "ready" });
  expect(fetcher.mock.calls[0][0]).toMatch(
    /^\/v1\/assistant\/documents\/[0-9a-f-]{36}$/i,
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: "POST",
    body: file,
    headers: expect.objectContaining({
      "Content-Type": "application/pdf",
      "X-Document-Version": "1",
    }),
  });
  expect(fetcher.mock.calls[1][0]).toContain("/versions/1");
});

test("rejects non-PDF and oversized files before upload", async () => {
  const fetcher = vi.fn();
  const api = new AssistantApi(async () => "token", fetcher);
  await expect(
    api.uploadPdf(new File(["not pdf"], "notes.txt")),
  ).rejects.toThrow("invalid_pdf");
  await expect(
    api.uploadPdf(
      new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.pdf"),
    ),
  ).rejects.toThrow("invalid_pdf");
  expect(fetcher).not.toHaveBeenCalled();
});

test("recovers an accepted upload after a gateway timeout without reposting PDF bytes", async () => {
  const id = "12345678-abcd-4abc-8abc-123456789abc";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(id);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 504 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          document_id: id,
          document_version: 1,
          status: "processing",
        }),
      ),
    );
  const api = new AssistantApi(async () => "token", fetcher);
  await expect(
    api.uploadPdf(new File(["%PDF-test"], "manual.pdf")),
  ).resolves.toEqual({
    document_id: id,
    document_version: 1,
    status: "processing",
  });
  expect(fetcher.mock.calls.map((call) => call[1].method)).toEqual([
    "POST",
    "GET",
  ]);
  expect(fetcher.mock.calls[1][0]).toBe(
    `/v1/assistant/documents/${id}/versions/1`,
  );
});

test("recovers a lost network response using the same document identity", async () => {
  const id = "12345678-abcd-4abc-8abc-123456789abc";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(id);
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          document_id: id,
          document_version: 1,
          status: "ready",
          chunk_count: 2,
        }),
      ),
    );
  await expect(
    new AssistantApi(async () => "token", fetcher).uploadPdf(
      new File(["%PDF-test"], "manual.pdf"),
    ),
  ).resolves.toMatchObject({ status: "ready", chunk_count: 2 });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("preserves the generated identity when upload acceptance cannot be confirmed", async () => {
  const id = "12345678-abcd-4abc-8abc-123456789abc";
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(id);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: "not_found" }), { status: 404 }),
    );
  const api = new AssistantApi(async () => "token", fetcher);
  await expect(
    api.uploadPdf(new File(["%PDF-test"], "manual.pdf")),
  ).rejects.toMatchObject({
    name: "AssistantUploadOutcomeUnknownError",
    documentId: id,
    documentVersion: 1,
  });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(
    fetcher.mock.calls.filter((call) => call[1].method === "POST"),
  ).toHaveLength(1);
});

test("upload outcome error preserves its typed identity", () => {
  const error = new AssistantUploadOutcomeUnknownError(
    "12345678-abcd-4abc-8abc-123456789abc",
  );
  expect(error).toMatchObject({
    name: "AssistantUploadOutcomeUnknownError",
    documentId: "12345678-abcd-4abc-8abc-123456789abc",
    documentVersion: 1,
  });
});

test("does not attempt recovery for denied or invalid PDF uploads", async () => {
  for (const status of [403, 415, 429]) {
    const fetcher = vi.fn(async () => new Response("", { status }));
    const api = new AssistantApi(async () => "token", fetcher);
    await expect(
      api.uploadPdf(new File(["%PDF-test"], "manual.pdf")),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

test("complete summaries send only explicit document/version scope and allow a longer bounded request", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          user_message: {
            id: "u-summary",
            role: "user",
            content: "Summarize every section",
            citations: [],
          },
          assistant_message: {
            id: "a-summary",
            role: "assistant",
            content: "Page 1 summary",
            citations: [],
          },
        }),
      ),
  );
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const api = new AssistantApi(async () => "token", fetcher);
  await api.sendMessage("conversation-1", "Summarize every section", {
    mode: "document_summary",
    document_id: "12345678-abcd-4000-8000-000000000001",
    document_version: 4,
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/assistant/conversations/conversation-1/messages",
    expect.objectContaining({
      body: JSON.stringify({
        question: "Summarize every section",
        mode: "document_summary",
        document_id: "12345678-abcd-4000-8000-000000000001",
        document_version: 4,
      }),
    }),
  );
  expect(timeout).toHaveBeenCalledWith(320_000);
  timeout.mockRestore();
});

test("background summaries send scoped request and never client identity", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        job_id: id,
        status: "queued",
        completed_batches: 0,
        total_batches: 0,
      }),
    ),
  );
  const api = new AssistantApi(async () => "token", fetcher);
  await expect(
    api.startSummaryJob(id, 1, "Summarize the manual", id),
  ).resolves.toMatchObject({ job_id: id });
  const request = fetcher.mock.calls[0][1];
  expect(JSON.parse(request.body)).toEqual({
    document_id: id,
    document_version: 1,
    question: "Summarize the manual",
    idempotency_key: id,
  });
  expect(request.headers.Authorization).toBe("Bearer token");
});

test("PDF library requests derive identity from token and reject malformed response", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          documents: [
            {
              document_id: id,
              document_version: 1,
              filename: "Manual.pdf",
              status: "ready",
            },
          ],
        }),
      ),
  );
  const api = new AssistantApi(async () => "token", fetcher);
  await expect(api.listDocuments()).resolves.toMatchObject([
    { document_id: id },
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/assistant/documents",
    expect.objectContaining({
      method: "GET",
      cache: "no-store",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
  const invalid = new AssistantApi(
    async () => "token",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            documents: [
              {
                document_id: "foreign-invalid",
                document_version: 1,
                filename: "Manual.pdf",
                status: "ready",
              },
            ],
          }),
        ),
    ),
  );
  await expect(invalid.listDocuments()).rejects.toThrow("invalid_documents");
});

test("PDF deletion uses only validated document ID and authenticated principal", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ deleted: true })),
  );
  const api = new AssistantApi(async () => "token", fetcher);
  await api.deleteDocument(id);
  expect(fetcher).toHaveBeenCalledWith(
    `/v1/assistant/documents/${id}`,
    expect.objectContaining({
      method: "DELETE",
      headers: expect.objectContaining({ Authorization: "Bearer token" }),
    }),
  );
  await expect(api.deleteDocument("../../other-tenant")).rejects.toThrow(
    "invalid_document_id",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
