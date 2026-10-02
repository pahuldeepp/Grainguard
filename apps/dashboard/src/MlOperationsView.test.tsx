// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
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
  models: [{ name: "greenguard.hotspot-transition.classifier", version: "i4-transformer-test", mode: "shadow", dataOrigin: "synthetic_grain_sim", productionEligible: false, status: "healthy", createdAt: "" }],
  drift: [{ feature: "temperature_c", psi: 0.03, sampleCount: 100, status: "healthy" }],
  performance: { status: "unavailable", brierScore: null, sampleCount: 0, evaluatedAt: null },
  retraining: { status: "idle", runId: null, completedAt: null },
};

test("renders the synthetic shadow safety state and drift metrics", async () => {
  const api = { snapshot: vi.fn().mockResolvedValue(snapshot) } as unknown as MlApi;
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><MemoryRouter><MlOperationsView api={api} sessionId="tenant:user:1" /></MemoryRouter></QueryClientProvider>);
  await screen.findAllByText("i4-transformer-test");
  expect(screen.getByText(/synthetic\/shadow and is not production validated/i)).toBeTruthy();
  expect(screen.getByText("PSI 0.030")).toBeTruthy();
  client.clear();
});
