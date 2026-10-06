// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { RagOperationsView } from "./RagOperationsView";
import { RagOperationsApi, ragOperationsSections } from "./rag-operations-api";

afterEach(cleanup);

test("shows an honest RAG operations page with section navigation while the API is unavailable", async () => {
  const api = {
    snapshot: vi.fn().mockRejectedValue(new Error("rag_ops_unavailable")),
  } as unknown as RagOperationsApi;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/rag/overview"]}>
        <Routes>
          {ragOperationsSections.map((section) => (
            <Route
              key={section}
              path={`/rag/${section}`}
              element={
                <RagOperationsView
                  api={api}
                  sessionId="tenant:user"
                  section={section}
                />
              }
            />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("heading", { name: "RAG Overview" }),
  ).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/telemetry is not connected/i)).toBeTruthy();
  expect(
    screen.getByText(
      /No synthetic or placeholder production metrics are shown/i,
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("navigation", { name: "RAG operations" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Documents" }));
  expect(
    await screen.findByRole("heading", { name: "RAG Documents" }),
  ).toBeTruthy();
  expect(api.snapshot).toHaveBeenLastCalledWith(
    "documents",
    expect.any(AbortSignal),
  );
  client.clear();
});

test("renders the sign-in state and all six links without querying before authentication", () => {
  const api = { snapshot: vi.fn() } as unknown as RagOperationsApi;
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RagOperationsView api={api} section="retrieval" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("heading", { name: "RAG Retrieval" })).toBeTruthy();
  expect(screen.getByText("Sign in to view RAG operations.")).toBeTruthy();
  expect(screen.getAllByRole("link")).toHaveLength(6);
  expect(api.snapshot).not.toHaveBeenCalled();
  client.clear();
});

function snapshotView(
  section: (typeof ragOperationsSections)[number],
  data: Record<string, unknown>,
) {
  const api = {
    snapshot: vi.fn().mockResolvedValue(data),
  } as unknown as RagOperationsApi;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RagOperationsView
          api={api}
          sessionId="tenant:user"
          section={section}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

test("uses actual overview latency, window and source fields", async () => {
  const client = snapshotView("overview", {
    health: "ready",
    query_count: 4,
    success_rate: 0.75,
    latency_ms: { p95: 1234 },
    telemetry_window: "last 5000 requests per service process",
    metrics_source: "bounded process-local summaries",
  });
  expect(await screen.findByText("1234")).toBeTruthy();
  expect(screen.getByText("75.0%")).toBeTruthy();
  expect(screen.getByText("bounded process-local summaries")).toBeTruthy();
  expect(
    screen.getByText("last 5000 requests per service process"),
  ).toBeTruthy();
  client.clear();
});

test.each(["retrieval", "traces"] as const)(
  "renders safe %s rows without arbitrary payload content",
  async (section) => {
    const client = snapshotView(section, {
      source: "process-local recent telemetry",
      items: [
        {
          request_id: "request-1",
          at: 1791000000,
          status: "ok",
          latency_ms: 51,
          citations: [{ document_id: "doc-1" }],
          question: "SECRET QUESTION",
          answer: "SECRET ANSWER",
          token: "SECRET TOKEN",
        },
      ],
    });
    expect(
      await screen.findByRole("table", {
        name: `${section === "traces" ? "Traces" : "Retrieval"} records`,
      }),
    ).toBeTruthy();
    expect(screen.getByText("request-1")).toBeTruthy();
    expect(screen.getByText("51")).toBeTruthy();
    expect(screen.queryByText(/SECRET/)).toBeNull();
    client.clear();
  },
);

test("renders authorized document statuses and chunks", async () => {
  const client = snapshotView("documents", {
    items: [
      {
        document_id: "document-1",
        version: 2,
        current_version: 2,
        status: "ready",
        chunk_count: 17,
        created_at: "2026-10-03T00:00:00Z",
        source_key: "SECRET PATH",
      },
    ],
  });
  expect(await screen.findByText("document-1")).toBeTruthy();
  expect(screen.getByText("ready")).toBeTruthy();
  expect(screen.getByText("17")).toBeTruthy();
  expect(screen.queryByText("SECRET PATH")).toBeNull();
  client.clear();
});

test.each(["cache", "evaluations"] as const)(
  "states unavailable %s honestly without invented metrics",
  async (section) => {
    const client = snapshotView(section, { available: false, metrics: null });
    expect(
      await screen.findByText(
        section === "cache"
          ? /No cache metrics are available/
          : /No reviewed production evaluation report/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Records shown")).toBeNull();
    expect(screen.queryByText("0%")).toBeNull();
    client.clear();
  },
);

test.each([
  [
    "cache",
    {
      available: true,
      redis: "configured",
      retrieval_hits: 7,
      retrieval_misses: 2,
      embedding_hits: 4,
      embedding_misses: 3,
      hit_ratio: 0.6875,
      window: "Since process start",
    },
    "Retrieval hits",
  ],
  [
    "evaluations",
    {
      available: true,
      dataset: "synthetic",
      dataset_version: "synthetic-answer-contract-v1",
      case_count: 16,
      passed_count: 16,
      passed: true,
      production_baseline: false,
    },
    "Passed controls",
  ],
] as const)(
  "renders connected %s metrics honestly",
  async (section, data, label) => {
    const api = {
      snapshot: vi.fn().mockResolvedValue(data),
    } as unknown as RagOperationsApi;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <RagOperationsView
            api={api}
            sessionId="tenant:user"
            section={section}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(label)).toBeTruthy();
    if (section === "evaluations")
      expect(screen.getByText(/Synthetic contract checks only/)).toBeTruthy();
    else expect(screen.getByText("68.8%")).toBeTruthy();
    client.clear();
  },
);
