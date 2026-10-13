// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AssistantAgent } from "./AssistantAgent";
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  decide: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("./advisor-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./advisor-api")>()),
  AdvisorApi: class {
    list = calls.list;
    get = calls.get;
    decide = calls.decide;
    execute = calls.execute;
  },
}));
beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.list.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
test("honors Retry-After and prevents repeated Agent requests during cooldown", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response("{}", { status: 429, headers: { "Retry-After": "26" } }),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<AssistantAgent getAccessToken={async () => "test-token"} />);
  fireEvent.change(screen.getByLabelText("Agent request"), {
    target: { value: "temperature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
  const retry = await screen.findByRole("button", { name: /Try again in 26s/ });
  expect(retry.hasAttribute("disabled")).toBe(true);
  fireEvent.click(retry);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test("sends selected document scope and opens validated Agent source citations", async () => {
  const citation = {
    document_id: "12345678-abcd-4000-8000-000000000001",
    document_version: 2,
    page_start: 3,
    page_end: 3,
    chunk_id: "12345678-abcd-4000-8000-000000000002",
  };
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      content: [{ type: "text", text: "Temperature checks." }],
      citations: [citation],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const open = vi.fn();
  render(
    <AssistantAgent
      getAccessToken={async () => "test-token"}
      selectedDocument={{ documentId: citation.document_id, version: 2 }}
      onCitation={open}
    />,
  );
  fireEvent.change(screen.getByLabelText("Agent request"), {
    target: { value: "temperature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Document .*p.3/ }),
  );
  expect(open).toHaveBeenCalledWith(citation);
  expect(JSON.parse(fetcher.mock.calls[0][1].body).selected_document).toEqual({
    document_id: citation.document_id,
    document_version: 2,
  });
});

test("shows a device lookup error without reporting a general Agent outage", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "device_not_found" }, { status: 404 }),
      ),
  );
  render(<AssistantAgent getAccessToken={async () => "test-token"} />);
  fireEvent.change(screen.getByLabelText("Agent request"), {
    target: { value: "Read temperature for device DEMO-MISSING" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
  expect(
    await screen.findByText(
      "That device was not found in your account. Check its name or ID.",
    ),
  ).toBeTruthy();
});

const proposal = {
  proposal_id: "12345678-abcd-4000-8000-000000000001",
  action_hash: "a".repeat(64),
  status: "approved" as const,
  version: 2,
  expires_at: "2020-01-01T00:00:00Z",
  action: {
    action: "acknowledge_alert",
    target: "12345678-abcd-4000-8000-000000000002",
    params: { note: "Reviewed by operator" },
    preconditions: { etag: '"1"' },
  },
  execution_status: "retryable" as const,
  execution_attempts: 1,
  execution_receipt: null,
};
const succeeded = {
  ...proposal,
  execution_status: "succeeded" as const,
  execution_attempts: 2,
  execution_receipt: { owner: "workflow-alerts", status: 200 },
};
const tokenProvider = async () => "test-token";
async function retryButton() {
  const button = await screen.findByRole("button", {
    name: "Retry approved action",
  });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
}
test("manually retries an approved exact action after a fresh status read, including after its approval deadline", async () => {
  calls.list.mockResolvedValue([proposal]);
  calls.get.mockResolvedValueOnce(proposal).mockResolvedValueOnce(succeeded);
  calls.execute.mockResolvedValue({ execution_status: "succeeded" });
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  expect(
    screen.queryByRole("button", { name: "Approve this exact action" }),
  ).toBeNull();
  fireEvent.click(await retryButton());
  expect(await screen.findByText("Completed and confirmed")).toBeTruthy();
  expect(calls.get).toHaveBeenCalledTimes(2);
  expect(calls.execute).toHaveBeenCalledTimes(1);
  expect(calls.execute.mock.calls[0][0]).toEqual(proposal);
  expect(calls.decide).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Retry approved action" }),
  ).toBeNull();
});
test("synchronously fences repeated retry clicks while checking current proposal state", async () => {
  calls.list.mockResolvedValue([proposal]);
  let resolve!: (value: typeof proposal) => void;
  calls.get
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValueOnce(succeeded);
  calls.execute.mockResolvedValue({ execution_status: "succeeded" });
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  const button = await retryButton();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(calls.get).toHaveBeenCalledTimes(1);
  await act(async () => resolve(proposal));
  await screen.findByText("Completed and confirmed");
  expect(calls.execute).toHaveBeenCalledTimes(1);
});
test("requires review again when a fresh proposal has a different hash or version", async () => {
  calls.list.mockResolvedValue([proposal]);
  calls.get.mockResolvedValue({
    ...proposal,
    version: 3,
    action_hash: "b".repeat(64),
  });
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  fireEvent.click(await retryButton());
  await screen.findByText(
    "This proposal changed. Review its current action and status before continuing.",
  );
  expect(calls.execute).not.toHaveBeenCalled();
});
test("a refreshed success prevents retrying an action whose earlier receipt was lost", async () => {
  calls.list.mockResolvedValue([proposal]);
  calls.get.mockResolvedValue(succeeded);
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  fireEvent.click(await retryButton());
  await screen.findByText("Completed and confirmed");
  expect(calls.execute).not.toHaveBeenCalled();
});
test("reconciles a timed-out execution with its completed receipt without automatically repeating mutation", async () => {
  calls.list.mockResolvedValue([proposal]);
  calls.get.mockResolvedValueOnce(proposal).mockResolvedValueOnce(succeeded);
  calls.execute.mockRejectedValue(new TypeError("Failed to fetch"));
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  fireEvent.click(await retryButton());
  await screen.findByText("Completed and confirmed");
  expect(calls.execute).toHaveBeenCalledTimes(1);
  expect(calls.decide).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});
test("blocks an ambiguous action until its status can be refreshed", async () => {
  calls.list.mockResolvedValue([proposal]);
  calls.get
    .mockResolvedValueOnce(proposal)
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  calls.execute.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  fireEvent.click(await retryButton());
  await screen.findByText(
    "Current status unavailable. Refresh before another action.",
  );
  expect(
    screen
      .getByRole("button", { name: "Retry approved action" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(calls.execute).toHaveBeenCalledTimes(1);
  calls.get.mockResolvedValue(proposal);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh action status" }),
  );
  await retryButton();
  expect(calls.execute).toHaveBeenCalledTimes(1);
});
test("does not execute terminal, exhausted, rejected or expired proposals", async () => {
  calls.list.mockResolvedValue([
    { ...proposal, execution_status: "retryable", execution_attempts: 8 },
    {
      ...proposal,
      proposal_id: "12345678-abcd-4000-8000-000000000003",
      execution_status: "failed",
    },
    {
      ...proposal,
      proposal_id: "12345678-abcd-4000-8000-000000000004",
      status: "rejected",
    },
    {
      ...proposal,
      proposal_id: "12345678-abcd-4000-8000-000000000005",
      status: "pending",
      version: 1,
    },
  ]);
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  const retry = await screen.findByRole("button", {
    name: "Retry approved action",
  });
  expect(retry.hasAttribute("disabled")).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Approve this exact action" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(retry);
  expect(calls.get).not.toHaveBeenCalled();
  expect(calls.execute).not.toHaveBeenCalled();
});
test("checks fresh authorization before execution and reports revoked permission safely", async () => {
  const { AdvisorRequestError } = await import("./advisor-api");
  calls.list.mockResolvedValue([proposal]);
  calls.get.mockRejectedValue(new AdvisorRequestError(403, 1));
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  fireEvent.click(await retryButton());
  await screen.findByText(
    "You no longer have permission to review this action.",
  );
  expect(calls.execute).not.toHaveBeenCalled();
  expect(
    screen
      .getByRole("button", { name: "Retry approved action" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
test("a session change discards a pending execution preflight and old approval content", async () => {
  calls.list.mockResolvedValueOnce([proposal]).mockResolvedValueOnce([]);
  let resolve!: (value: typeof proposal) => void;
  calls.get.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<AssistantAgent getAccessToken={tokenProvider} />);
  fireEvent.click(await retryButton());
  view.rerender(
    <AssistantAgent getAccessToken={async () => "new-user-token"} />,
  );
  await act(async () => resolve(proposal));
  expect(calls.execute).not.toHaveBeenCalled();
  expect(
    screen.queryByText("Reviewed by operator", { exact: false }),
  ).toBeNull();
});
test("pending approval is never resubmitted automatically after an ambiguous decision response", async () => {
  const pending = {
    ...proposal,
    status: "pending" as const,
    version: 1,
    expires_at: new Date(Date.now() + 600000).toISOString(),
    execution_status: "not_applicable" as const,
    execution_attempts: 0,
  };
  calls.list.mockResolvedValue([pending]);
  calls.get.mockResolvedValueOnce(pending).mockResolvedValueOnce(proposal);
  calls.decide.mockRejectedValue(new TypeError("Failed to fetch"));
  render(<AssistantAgent getAccessToken={tokenProvider} />);
  const approve = await screen.findByRole("button", {
    name: "Approve this exact action",
  });
  await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
  fireEvent.click(approve);
  await screen.findByRole("button", { name: "Retry approved action" });
  expect(calls.decide).toHaveBeenCalledTimes(1);
  expect(calls.execute).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Approve this exact action" }),
  ).toBeNull();
});

test.each([
  [401, "Your session expired. Sign in again to use the agent."],
  [403, "You do not have access to this request."],
  [503, "Agent services are temporarily unavailable. Please try again later."],
  [500, "The agent could not complete this request."],
])(
  "preserves safe Agent failure guidance for HTTP %s",
  async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: "private_detail" }, { status }),
        ),
    );
    render(<AssistantAgent getAccessToken={tokenProvider} />);
    fireEvent.change(screen.getByLabelText("Agent request"), {
      target: { value: "temperature" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
  },
);
