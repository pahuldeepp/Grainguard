// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MlOperationsView } from "./MlOperationsView";
import type { MlApi } from "./ml-api";

afterEach(cleanup);

const snapshot = {
  capturedAt: "2026-10-02T12:00:00Z",
  scorerReady: true,
  predictionsTotal: 42,
  inferenceP95Ms: 8.2,
  canaryPercentage: 0,
  model: {
    name: "greenguard.hotspot-transition.classifier",
    version: "i4-transformer-test",
    mode: "shadow",
    dataOrigin: "synthetic_grain_sim",
    productionEligible: false,
    status: "healthy",
  },
  models: [
    {
      name: "greenguard.hotspot-transition.classifier",
      version: "i4-transformer-test",
      mode: "shadow",
      dataOrigin: "synthetic_grain_sim",
      productionEligible: false,
      status: "healthy",
      createdAt: "",
    },
  ],
  drift: [
    {
      feature: "temperature_c",
      psi: 0.03,
      sampleCount: 100,
      status: "healthy",
    },
  ],
  performance: {
    status: "unavailable",
    brierScore: null,
    sampleCount: 0,
    evaluatedAt: null,
  },
  retraining: { status: "idle", runId: null, completedAt: null },
  analytics: {
    status: "ready",
    rows: 1536,
    bins: 8,
    averageTemperatureC: 22.5,
    averageHumidityPercent: 64,
  },
};

test("renders the synthetic shadow safety state and drift metrics", async () => {
  const api = {
    snapshot: vi.fn().mockResolvedValue(snapshot),
  } as unknown as MlApi;
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MlOperationsView api={api} sessionId="tenant:user:1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findAllByText("i4-transformer-test");
  expect(
    screen.getByText(/synthetic\/shadow and is not production validated/i),
  ).toBeTruthy();
  expect(screen.getByText("PSI 0.030")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Telemetry analytics" }),
  ).toBeTruthy();
  expect(screen.getByText("1,536")).toBeTruthy();
  client.clear();
});

test("does not offer a retraining action that the synthetic scorer cannot accept", async () => {
  const action = vi.fn();
  const api = {
    snapshot: vi.fn().mockResolvedValue(snapshot),
    action,
  } as unknown as MlApi;
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/ml/retraining"]}>
        <MlOperationsView api={api} sessionId="tenant:user:1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const button = await screen.findByRole("button", {
    name: "Start retraining",
  });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByText(
      /dashboard retraining is unavailable for synthetic shadow models/i,
    ),
  ).toBeTruthy();
  client.clear();
});

test("ML section navigation changes the visible page and active tab", async () => {
  const api = {
    snapshot: vi.fn().mockResolvedValue(snapshot),
  } as unknown as MlApi;
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/ml"]}>
        <MlOperationsView api={api} sessionId="tenant:user:1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Scorer" });
  for (const [label, heading] of [
    ["Drift", "Feature drift"],
    ["Performance", "Model performance"],
    ["Models", "Model registry"],
    ["Retraining", "Retraining"],
    ["Overview", "ML operations"],
  ]) {
    fireEvent.click(screen.getByRole("link", { name: label }));
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: label }).getAttribute("aria-current"),
      ).toBe("page"),
    );
    expect(
      screen.getByRole("heading", { name: heading, level: 1 }),
    ).toBeTruthy();
    if (label !== "Overview")
      expect(screen.queryByRole("heading", { name: "Scorer" })).toBeNull();
  }
  client.clear();
});

test("production-eligible models do not display synthetic-only restrictions", async () => {
  const eligible = {
    ...snapshot,
    model: {
      ...snapshot.model,
      productionEligible: true,
      mode: "production",
      dataOrigin: "field",
    },
  };
  for (const path of ["/ml", "/ml/models", "/ml/retraining"]) {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <MlOperationsView
            api={
              {
                snapshot: vi.fn().mockResolvedValue(eligible),
                action: vi.fn(),
              } as unknown as MlApi
            }
            sessionId="tenant:eligible"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.container.querySelector(".ml-dashboard")).toBeTruthy(),
    );
    expect(screen.queryByText("Actions unavailable for this model")).toBeNull();
    expect(
      screen.queryByText(/Dashboard retraining is unavailable/),
    ).toBeNull();
    expect(
      screen.queryByText(/synthetic\/shadow and is not production validated/i),
    ).toBeNull();
    expect(view.container.querySelector(".ml-page-footnote")).toBeNull();
    view.unmount();
    client.clear();
  }
});
