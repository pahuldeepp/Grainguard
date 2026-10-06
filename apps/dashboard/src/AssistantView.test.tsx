// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AssistantView } from "./AssistantView";
import { AssistantUploadOutcomeUnknownError } from "./assistant-api";
import type { AssistantApi } from "./assistant-api";

vi.mock("./SourcePdfPreview", () => ({
  SourcePdfPreview: ({
    filename,
    initialPage,
  }: {
    filename: string;
    initialPage: number;
  }) => (
    <div title={`${filename}, page ${initialPage}`} data-page={initialPage} />
  ),
}));

afterEach(cleanup);

function apiMock(overrides: Record<string, unknown> = {}) {
  return {
    listConversations: vi.fn().mockResolvedValue([]),
    createConversation: vi
      .fn()
      .mockResolvedValue({ id: "conversation-1", title: "New chat" }),
    getConversation: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({
      user_message: {
        id: "message-user-1",
        role: "user",
        content: "How do I reduce mold risk?",
        citations: [],
      },
      assistant_message: {
        id: "message-assistant-1",
        role: "assistant",
        content: "Keep the grain dry and ventilated.",
        citations: [
          {
            document_id: "12345678-abcd-4000-8000-000000000001",
            document_version: 2,
            page_start: 4,
            chunk_id: "chunk-1",
          },
        ],
      },
    }),
    getSuggestions: vi.fn().mockResolvedValue([]),
    recordSuggestionUsed: vi.fn().mockResolvedValue(undefined),
    uploadPdf: vi.fn().mockResolvedValue({
      document_id: "doc-1",
      document_version: 1,
      status: "queued",
      event_id: "event-1",
      idempotent: false,
    }),
    getDocumentStatus: vi.fn().mockResolvedValue({
      document_id: "doc-1",
      document_version: 1,
      status: "ready",
    }),
    ...overrides,
  } as unknown as AssistantApi;
}

test("creates a persisted conversation on first send and shows the cited server response", async () => {
  const api = apiMock();
  render(<AssistantView api={api} sessionId="tenant:user" />);
  expect(
    screen.getByRole("heading", {
      name: "How can I help with your operation?",
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
  expect(api.createConversation).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    {
      target: { value: "How do I reduce mold risk?" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await screen.findByText("Keep the grain dry and ventilated.");
  expect(api.createConversation).toHaveBeenCalledTimes(1);
  expect(api.createConversation).toHaveBeenCalledWith(
    "How do I reduce mold risk?",
  );
  expect(api.sendMessage).toHaveBeenCalledWith(
    "conversation-1",
    "How do I reduce mold risk?",
  );
  expect(screen.getByText("Document 12345678 · v2 · p.4")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "How do I reduce mold risk?" }),
  ).toBeTruthy();
});

test("loads saved conversation history and opens its server messages", async () => {
  const api = apiMock({
    listConversations: vi
      .fn()
      .mockResolvedValue([
        { id: "saved-1", title: "Storage procedure", updated_at: "now" },
      ]),
    getConversation: vi.fn().mockResolvedValue({
      id: "saved-1",
      title: "Storage procedure",
      messages: [
        {
          id: "u-1",
          role: "user",
          content: "How should I store grain?",
          citations: [],
        },
        {
          id: "a-1",
          role: "assistant",
          content: "Keep it dry.",
          citations: [],
        },
      ],
    }),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Storage procedure" }),
  );
  expect(await screen.findByText("Keep it dry.")).toBeTruthy();
  expect(api.getConversation).toHaveBeenCalledWith("saved-1");
});

test("loads ranked suggestions and records usage only after the server confirms both messages", async () => {
  const api = apiMock({
    getSuggestions: vi.fn().mockResolvedValue([
      {
        id: "grain_moisture",
        label: "What do our documents say about grain moisture?",
      },
    ]),
    sendMessage: vi.fn().mockResolvedValue({
      user_message: {
        id: "u2",
        role: "user",
        content: "What do our documents say about grain moisture?",
        citations: [],
      },
      assistant_message: {
        id: "a2",
        role: "assistant",
        content: "Keep it dry.",
        citations: [],
      },
    }),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "What do our documents say about grain moisture?",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Keep it dry.");
  await waitFor(() =>
    expect(api.recordSuggestionUsed).toHaveBeenCalledWith("grain_moisture"),
  );
});

test("does not persist either message or count suggestion usage when the message request fails", async () => {
  const api = apiMock({
    getSuggestions: vi
      .fn()
      .mockResolvedValue([
        { id: "grain_moisture", label: "Ask about grain moisture" },
      ]),
    sendMessage: vi.fn().mockRejectedValue(new Error("assistant_unavailable")),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Ask about grain moisture" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByRole("alert");
  expect(
    screen.queryByText("Ask about grain moisture", {
      selector: ".assistant-message-text",
    }),
  ).toBeNull();
  expect(api.recordSuggestionUsed).not.toHaveBeenCalled();
  expect(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
  ).toHaveProperty("value", "Ask about grain moisture");
});

test("tells the user a stale or deleted conversation is unavailable", async () => {
  const api = apiMock({
    listConversations: vi
      .fn()
      .mockResolvedValue([{ id: "deleted-chat", title: "Old chat" }]),
    getConversation: vi.fn().mockRejectedValue(new Error("not_found")),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.click(await screen.findByRole("button", { name: "Old chat" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(
    /chat was deleted or is no longer available/i,
  );
  expect(alert.textContent).not.toMatch(/temporarily unavailable/i);
});

test("uses ambiguous retry guidance for send failures and operation-specific copy elsewhere", async () => {
  const sendApi = apiMock({
    createConversation: vi
      .fn()
      .mockResolvedValue({ id: "conversation-1", title: "Question" }),
    sendMessage: vi.fn().mockRejectedValue(new Error("assistant_unavailable")),
  });
  render(<AssistantView api={sendApi} sessionId="tenant:user" />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    {
      target: { value: "Question" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /couldn’t confirm whether your message was saved/i,
  );
  cleanup();

  const openApi = apiMock({
    listConversations: vi
      .fn()
      .mockResolvedValue([{ id: "chat-1", title: "Saved chat" }]),
    getConversation: vi
      .fn()
      .mockRejectedValue(new Error("service_unavailable")),
  });
  render(<AssistantView api={openApi} sessionId="tenant:user" />);
  fireEvent.click(await screen.findByRole("button", { name: "Saved chat" }));
  const openAlert = await screen.findByRole("alert");
  expect(openAlert.textContent).toMatch(/couldn’t open this chat/i);
  expect(openAlert.textContent).not.toMatch(/message was saved/i);
});

test("shows a clear error when conversation persistence is not wired", async () => {
  const api = apiMock({
    createConversation: vi
      .fn()
      .mockRejectedValue(new Error("assistant_not_configured")),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    { target: { value: "Question" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /saved assistant conversations are not connected/i,
  );
  expect(api.sendMessage).not.toHaveBeenCalled();
});

test("shows the server retry delay and disables sending during rate-limit cooldown", async () => {
  const limited = Object.assign(new Error("rate_limited"), {
    retryAfterSeconds: 7,
  });
  const api = apiMock({
    createConversation: vi.fn().mockRejectedValue(limited),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    {
      target: { value: "How should I store grain?" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Try again in 7 seconds",
  );
  expect(screen.getByRole("button", { name: "Wait 7s" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("distinguishes upstream provider throttling from a user request limit", async () => {
  const limited = Object.assign(new Error("provider_rate_limited"), {
    retryAfterSeconds: 4,
    status: 429,
  });
  const api = apiMock({
    createConversation: vi.fn().mockRejectedValue(limited),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    {
      target: { value: "How should I store grain?" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "AI service is handling too many requests",
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Try again in 4 seconds",
  );
  expect(screen.getByRole("button", { name: "Wait 4s" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("distinguishes shared Gateway capacity from a user request limit", async () => {
  const limited = Object.assign(new Error("gateway_rate_limited"), {
    retryAfterSeconds: 4,
    status: 429,
  });
  const api = apiMock({
    createConversation: vi.fn().mockRejectedValue(limited),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    {
      target: { value: "How should I store grain?" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "AI service is handling too many requests",
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Try again in 4 seconds",
  );
  expect(screen.getByRole("button", { name: "Wait 4s" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("explains rate limiter outage without leaking backend details", async () => {
  const api = apiMock({
    createConversation: vi
      .fn()
      .mockRejectedValue(new Error("rate_limit_unavailable")),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    {
      target: { value: "Question" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "Couldn’t confirm whether your message was saved",
  );
  expect(alert.textContent).not.toContain("redis host");
});

test("attaches a PDF to the shared farm library and waits for indexing before reporting ready", async () => {
  const api = apiMock();
  render(<AssistantView api={api} sessionId="tenant:user" />);
  const file = new File(["%PDF-test"], "grain-guide.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(
    screen
      .getByRole("button", { name: "Attach PDF" })
      .parentElement?.querySelector('input[type="file"]') as HTMLInputElement,
    {
      target: { files: [file] },
    },
  );
  expect(
    await screen.findByText(
      /grain-guide\.pdf is ready in your farm’s shared knowledge library/i,
    ),
  ).toBeTruthy();
  expect(api.uploadPdf).toHaveBeenCalledWith(file, expect.any(AbortSignal));
  expect(api.getDocumentStatus).toHaveBeenCalledWith(
    "doc-1",
    1,
    15_000,
    expect.any(AbortSignal),
  );
});

test("retries a transient status failure and recognizes the already accepted PDF", async () => {
  const api = apiMock({
    getDocumentStatus: vi
      .fn()
      .mockRejectedValueOnce(new Error("service_unavailable"))
      .mockResolvedValueOnce({
        document_id: "doc-1",
        document_version: 1,
        status: "ready",
      }),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  const file = new File(["%PDF-test"], "grain-guide.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(
    screen
      .getByRole("button", { name: "Attach PDF" })
      .parentElement?.querySelector('input[type="file"]') as HTMLInputElement,
    {
      target: { files: [file] },
    },
  );
  expect(
    await screen.findByText(
      /grain-guide\.pdf is ready in your farm’s shared knowledge library/i,
    ),
  ).toBeTruthy();
  expect(api.uploadPdf).toHaveBeenCalledTimes(1);
  expect(api.getDocumentStatus).toHaveBeenCalledTimes(2);
});

test("keeps an accepted PDF queued through status outages and retries status without uploading again", async () => {
  const api = apiMock({
    getDocumentStatus: vi
      .fn()
      .mockRejectedValueOnce(new Error("service_unavailable"))
      .mockRejectedValueOnce(new Error("rate_limited"))
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce({
        document_id: "doc-1",
        document_version: 1,
        status: "ready",
      }),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    {
      target: { value: "Ask about an existing manual" },
    },
  );
  const file = new File(["%PDF-test"], "grain-guide.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(
    screen
      .getByRole("button", { name: "Attach PDF" })
      .parentElement?.querySelector('input[type="file"]') as HTMLInputElement,
    {
      target: { files: [file] },
    },
  );
  const notice = await screen.findByText(
    /grain-guide\.pdf was accepted\. Its latest indexing status is temporarily unavailable/i,
    {},
    { timeout: 5000 },
  );
  expect(notice.textContent).toMatch(/Do not upload it again/i);
  expect(screen.getByRole("button", { name: "Attach PDF" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(api.uploadPdf).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Retry status check" }));
  expect(
    await screen.findByText(
      /grain-guide\.pdf is ready in your farm’s shared knowledge library/i,
    ),
  ).toBeTruthy();
  expect(api.getDocumentStatus).toHaveBeenCalledTimes(4);
  expect(api.uploadPdf).toHaveBeenCalledTimes(1);
});

test("keeps the same ID when upload acceptance is ambiguous and status later recovers", async () => {
  const api = apiMock({
    uploadPdf: vi
      .fn()
      .mockRejectedValue(new AssistantUploadOutcomeUnknownError("doc-1")),
    getDocumentStatus: vi
      .fn()
      .mockRejectedValueOnce(new Error("not_found"))
      .mockRejectedValueOnce(new Error("service_unavailable"))
      .mockRejectedValueOnce(new Error("service_unavailable"))
      .mockResolvedValueOnce({
        document_id: "doc-1",
        document_version: 1,
        status: "ready",
      }),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  const file = new File(["%PDF-test"], "grain-guide.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(
    screen
      .getByRole("button", { name: "Attach PDF" })
      .parentElement?.querySelector('input[type="file"]') as HTMLInputElement,
    {
      target: { files: [file] },
    },
  );
  const notice = await screen.findByText(
    /couldn’t confirm whether grain-guide\.pdf was accepted\. Retry the status check below/i,
    {},
    { timeout: 5000 },
  );
  expect(notice.textContent).toMatch(/do not upload it again/i);
  expect(api.getDocumentStatus).toHaveBeenCalledWith(
    "doc-1",
    1,
    15_000,
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry status check" }));
  expect(
    await screen.findByText(
      /grain-guide\.pdf is ready in your farm’s shared knowledge library/i,
    ),
  ).toBeTruthy();
  expect(api.uploadPdf).toHaveBeenCalledTimes(1);
});

test("explains that PDF upload requires an operator or admin role", async () => {
  const api = apiMock({
    uploadPdf: vi.fn().mockRejectedValue(new Error("insufficient_role")),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  const file = new File(["%PDF-test"], "grain-guide.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(
    screen
      .getByRole("button", { name: "Attach PDF" })
      .parentElement?.querySelector('input[type="file"]') as HTMLInputElement,
    {
      target: { files: [file] },
    },
  );
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /farm operators and admins/i,
  );
});

test("requires inline confirmation, then removes the deleted active chat", async () => {
  const api = apiMock({
    listConversations: vi
      .fn()
      .mockResolvedValue([{ id: "saved-1", title: "Storage procedure" }]),
    getConversation: vi.fn().mockResolvedValue({
      id: "saved-1",
      title: "Storage procedure",
      messages: [
        { id: "a1", role: "assistant", content: "Keep it dry.", citations: [] },
      ],
    }),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Storage procedure" }),
  );
  expect(await screen.findByText("Keep it dry.")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete Storage procedure" }),
  );
  expect(screen.getByText("Delete this chat?")).toBeTruthy();
  expect(api.deleteConversation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await waitFor(() =>
    expect(api.deleteConversation).toHaveBeenCalledWith("saved-1"),
  );
  expect(
    await screen.findByRole("heading", {
      name: "How can I help with your operation?",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Storage procedure" }),
  ).toBeNull();
});

test("canceling a delete leaves the saved conversation intact", async () => {
  const api = apiMock({
    listConversations: vi
      .fn()
      .mockResolvedValue([{ id: "saved-2", title: "Drying notes" }]),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Delete Drying notes" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Drying notes" })).toBeTruthy();
  expect(api.deleteConversation).not.toHaveBeenCalled();
});

test("keeps the composer disabled for a signed-out user", () => {
  const api = apiMock();
  render(<AssistantView api={api} />);
  expect(screen.getByText("Sign in to ask GreenGuard Assistant.")).toBeTruthy();
  expect(
    screen
      .getByRole("textbox", { name: "Message GreenGuard Assistant" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(api.listConversations).not.toHaveBeenCalled();
});

test("blocks sending only while PDF bytes are submitting, then allows questions during indexing", async () => {
  let finishUpload!: (value: unknown) => void;
  let finishStatus!: (value: unknown) => void;
  const api = apiMock({
    uploadPdf: vi.fn(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        }),
    ),
    getDocumentStatus: vi.fn(
      () =>
        new Promise((resolve) => {
          finishStatus = resolve;
        }),
    ),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  const composer = screen.getByRole("textbox", {
    name: "Message GreenGuard Assistant",
  });
  fireEvent.change(composer, {
    target: { value: "Summarize my attached PDF" },
  });
  const file = new File(["%PDF-test"], "course.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(screen.getByLabelText("Choose a PDF to upload"), {
    target: { files: [file] },
  });
  expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.keyDown(composer, { key: "Enter" });
  fireEvent.submit(composer.closest("form")!);
  expect(api.createConversation).not.toHaveBeenCalled();
  expect(api.sendMessage).not.toHaveBeenCalled();
  finishUpload({ document_id: "doc-1", document_version: 1, status: "queued" });
  await waitFor(() => expect(api.getDocumentStatus).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(composer).toHaveProperty("value", "Summarize my attached PDF");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.sendMessage).toHaveBeenCalledWith(
      "conversation-1",
      "Summarize my attached PDF",
    ),
  );
  finishStatus({ document_id: "doc-1", document_version: 1, status: "ready" });
  await screen.findByText(/course\.pdf is ready/);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("complete summary requires explicit selection and scopes the request to one cited PDF", async () => {
  const api = apiMock({
    listConversations: vi
      .fn()
      .mockResolvedValue([{ id: "saved-summary", title: "Two sources" }]),
    getConversation: vi.fn().mockResolvedValue({
      id: "saved-summary",
      title: "Two sources",
      messages: [
        {
          id: "a-summary",
          role: "assistant",
          content: "Existing answer",
          citations: [
            {
              document_id: "12345678-abcd-4000-8000-000000000001",
              document_version: 2,
              page_start: 1,
            },
            {
              document_id: "87654321-abcd-4000-8000-000000000002",
              document_version: 3,
              page_start: 1,
            },
          ],
        },
      ],
    }),
  });
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.click(await screen.findByRole("button", { name: "Two sources" }));
  await screen.findByText("Existing answer");
  expect(
    screen.getByRole("button", { name: "Summarize selected PDF" }),
  ).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("PDF for this question"), {
    target: { value: "87654321-abcd-4000-8000-000000000002:3" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Summarize selected PDF" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.sendMessage).toHaveBeenCalledWith(
      "saved-summary",
      "Summarize this PDF completely, section by section, and cite the page numbers.",
      {
        mode: "document_summary",
        document_id: "87654321-abcd-4000-8000-000000000002",
        document_version: 3,
      },
    ),
  );
  await screen.findByText("Keep the grain dry and ventilated.");
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    { target: { value: "What is moisture?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      "saved-summary",
      "What is moisture?",
      {
        mode: "question",
        document_id: "87654321-abcd-4000-8000-000000000002",
        document_version: 3,
      },
    ),
  );
});

test("a ready uploaded PDF offers complete summary and scopes ordinary questions to that PDF", async () => {
  const api = apiMock();
  render(<AssistantView api={api} sessionId="tenant:user" />);
  fireEvent.change(screen.getByLabelText("Choose a PDF to upload"), {
    target: {
      files: [
        new File(["%PDF-1.7"], "Operating manual.pdf", {
          type: "application/pdf",
        }),
      ],
    },
  });
  await screen.findByRole("button", { name: "Summarize selected PDF" });
  expect(screen.getByLabelText("PDF for this question")).toHaveProperty(
    "value",
    "doc-1:1",
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
    { target: { value: "What is moisture?" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.sendMessage).toHaveBeenCalledWith(
      "conversation-1",
      "What is moisture?",
      { mode: "question", document_id: "doc-1", document_version: 1 },
    ),
  );
});

test("named citation opens an authenticated PDF at its cited page and closes its blob", async () => {
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = () => "blob:source-fixture";
      static revokeObjectURL = revoke;
    },
  );
  try {
    const api = apiMock({
      getDocumentSourceInfo: vi
        .fn()
        .mockResolvedValue({ filename: "Storage manual.pdf" }),
      getDocumentSource: vi.fn().mockResolvedValue({
        blob: new Blob(["%PDF-1.7"], { type: "application/pdf" }),
        filename: "Storage manual.pdf",
      }),
    });
    render(<AssistantView api={api} sessionId="tenant:user" />);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
      { target: { value: "What is the target?" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Storage manual.pdf · v2 · p.4",
      }),
    );
    const frame = await screen.findByTitle("Storage manual.pdf, page 4");
    expect(frame.getAttribute("data-page")).toBe("4");
    expect(
      screen
        .getByRole("link", { name: "Open PDF in a new tab", hidden: true })
        .getAttribute("href"),
    ).toBe("blob:source-fixture#page=4");
    expect(api.getDocumentSource).toHaveBeenCalledWith(
      "12345678-abcd-4000-8000-000000000001",
      2,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close PDF" }));
    expect(revoke).toHaveBeenCalledWith("blob:source-fixture");
    expect(screen.queryByTitle("Storage manual.pdf, page 4")).toBeNull();
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

test("late PDF upload response does not restore document state after identity changes", async () => {
  let finish: (result: unknown) => void = () => {};
  const api = apiMock({
    uploadPdf: vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    getDocumentStatus: vi.fn(),
  });
  const view = render(
    <AssistantView api={api} sessionId="tenant:first-user" />,
  );
  fireEvent.change(screen.getByLabelText("Choose a PDF to upload"), {
    target: {
      files: [
        new File(["%PDF-test"], "private-first-user.pdf", {
          type: "application/pdf",
        }),
      ],
    },
  });
  expect(api.uploadPdf).toHaveBeenCalled();
  view.rerender(<AssistantView api={api} sessionId="tenant:second-user" />);
  finish({ document_id: "doc-1", document_version: 1, status: "queued" });
  await waitFor(() =>
    expect(screen.queryByText(/private-first-user/)).toBeNull(),
  );
  expect(api.getDocumentStatus).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Attach PDF" })).toHaveProperty(
    "disabled",
    false,
  );
});

test("keeps exactly one Agent panel after PDF selection and session changes", async () => {
  const api = apiMock({
    listDocuments: vi.fn().mockResolvedValue([
      {
        document_id: "12345678-abcd-4000-8000-000000000001",
        document_version: 1,
        filename: "Manual.pdf",
        status: "ready",
      },
    ]),
  });
  const getAccessToken = async () => null;
  const view = render(
    <AssistantView
      api={api}
      sessionId="tenant:user"
      getAccessToken={getAccessToken}
    />,
  );
  await screen.findByLabelText("PDF for this question");
  for (let i = 0; i < 3; i++) {
    fireEvent.change(screen.getByLabelText("PDF for this question"), {
      target: { value: i % 2 ? "" : "12345678-abcd-4000-8000-000000000001:1" },
    });
    expect(
      screen.getAllByText("Agent tools and approvals", { exact: true }),
    ).toHaveLength(1);
  }
  view.rerender(
    <AssistantView
      api={api}
      sessionId="tenant:other-user"
      getAccessToken={getAccessToken}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getAllByText("Agent tools and approvals", { exact: true }),
    ).toHaveLength(1),
  );
});

test("changing PDF selection preserves an ambiguous approval outcome", async () => {
  const proposal = {
    proposal_id: "12345678-abcd-4000-8000-000000000001",
    action_hash: "a".repeat(64),
    version: 2,
    status: "approved",
    expires_at: "2026-01-01T00:00:00Z",
    execution_status: "retryable",
    execution_attempts: 1,
    action: {
      action: "acknowledge",
      target: "alert-1",
      params: {},
      preconditions: {},
    },
  };
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("?limit=")) return Response.json({ items: [proposal] });
      if (init?.method === "POST") throw new Error("lost response");
      if (++reads === 1) return Response.json(proposal);
      throw new Error("status unavailable");
    }),
  );
  try {
    const api = apiMock({
      listDocuments: vi.fn().mockResolvedValue([
        {
          document_id: proposal.proposal_id,
          document_version: 1,
          filename: "Manual.pdf",
          status: "ready",
        },
      ]),
    });
    render(
      <AssistantView
        api={api}
        sessionId="tenant:user"
        getAccessToken={async () => "token"}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry approved action" }),
    );
    await screen.findByText(
      "Current status unavailable. Refresh before another action.",
    );
    fireEvent.change(screen.getByLabelText("PDF for this question"), {
      target: { value: `${proposal.proposal_id}:1` },
    });
    expect(
      screen.getByText(
        "Current status unavailable. Refresh before another action.",
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Retry approved action",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each([true, false])(
  "a selected PDF disappearing before send does not create empty history (summary=%s)",
  async (summary) => {
    vi.useFakeTimers();
    const id = "12345678-abcd-4000-8000-000000000001";
    const api = apiMock({
      listDocuments: vi
        .fn()
        .mockResolvedValueOnce([
          {
            document_id: id,
            document_version: 1,
            filename: "Manual.pdf",
            status: "ready",
          },
        ])
        .mockResolvedValue([]),
    });
    try {
      render(<AssistantView api={api} sessionId="tenant:user" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.change(screen.getByLabelText("PDF for this question"), {
        target: { value: `${id}:1` },
      });
      if (summary)
        fireEvent.click(
          screen.getByRole("button", { name: "Summarize selected PDF" }),
        );
      else
        fireEvent.change(
          screen.getByRole("textbox", { name: "Message GreenGuard Assistant" }),
          { target: { value: "Ask about this PDF" } },
        );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.createConversation).not.toHaveBeenCalled();
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  },
);
