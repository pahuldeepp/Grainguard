// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AssistantSummaryJob } from "./AssistantSummaryJob";
import type { AssistantApi } from "./assistant-api";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
const document = {
  documentId: "00000000-0000-4000-8000-000000000001",
  version: 1,
  fileName: "Manual.pdf",
};
const id = "00000000-0000-4000-8000-000000000002";
test("starts durable background job, renders completed Markdown and opens citations", async () => {
  const queued = {
    job_id: id,
    status: "queued",
    completed_batches: 0,
    total_batches: 2,
  };
  const citation = {
    document_id: document.documentId,
    document_version: 1,
    page_start: 3,
  };
  const api = {
    startSummaryJob: vi.fn().mockResolvedValue(queued),
    getSummaryJob: vi.fn().mockResolvedValue({
      ...queued,
      status: "completed",
      completed_batches: 2,
      result: {
        answer: "## Drying\n\n- Inspect daily",
        citations: [citation],
      },
    }),
  };
  const onCitation = vi.fn();
  render(
    <AssistantSummaryJob
      api={api as unknown as AssistantApi}
      sessionId="tenant:user"
      document={document}
      busy={false}
      onCitation={onCitation}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Background complete summary" }),
  );
  expect(await screen.findByRole("heading", { name: "Drying" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manual.pdf · p.3" }));
  expect(onCitation).toHaveBeenCalledWith(citation);
  expect(
    sessionStorage.getItem(
      `assistant:summary-job:tenant:user:${document.documentId}:1`,
    ),
  ).toBe(id);
});
test("reuses request key after an ambiguous start failure", async () => {
  const start = vi.fn().mockRejectedValue(new Error("network"));
  render(
    <AssistantSummaryJob
      api={{ startSummaryJob: start } as unknown as AssistantApi}
      sessionId="tenant:user"
      document={document}
      busy={false}
      onCitation={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Background complete summary" }),
  );
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: "Check summary status" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Background complete summary" }),
  );
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(start.mock.calls[0][3]).toBe(start.mock.calls[1][3]);
});
