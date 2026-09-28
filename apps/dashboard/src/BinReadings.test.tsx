// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { BinReadings } from "./BinReadings";
import type { ReadApi } from "./read-api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBin(api: Partial<ReadApi>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/bins/bin-0100"]}>
        <Routes>
          <Route
            path="/bins/:binId"
            element={<BinReadings api={api as ReadApi} sessionId="session-a" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

test("renders projected names, independent measures, positions and uncalibrated policy", async () => {
  const api = {
    binLatest: vi.fn(async () => ({
      bin: { binId: "bin-0100", name: "North Silo", siteName: "Prairie Farm" },
      devices: [{ deviceId: "d1", status: "active" }],
      devicesTruncated: false,
      readings: [
        {
          deviceId: "d1",
          metric: "temperature_c",
          unit: "Cel",
          value: 21.5,
          observedAt: "2026-09-26T10:00:00Z",
          ageSeconds: 3,
          stale: null,
        },
      ],
      layout: [
        { sensorId: "s1", position: 1, depthM: 1.25, label: "Upper probe" },
      ],
      sensorReadings: [],
      policies: [
        {
          policyId: "p1",
          policyVersion: "2",
          grainType: "Wheat",
          calibrated: false,
          status: "active",
          measurementThresholds: "{}",
          riskThresholds: "{}",
        },
      ],
      freshness: "not_configured",
    })),
    binTrend: vi.fn(async () => ({
      bin: null,
      window: "H24",
      resolution: "M15",
      bucketSeconds: 900,
      from: "2026-09-25T10:00:00Z",
      to: "2026-09-26T10:00:00Z",
      buckets: [],
      source: "empty",
    })),
  };
  const client = renderBin(api);
  expect(
    await screen.findByRole("heading", { name: "North Silo" }),
  ).toBeTruthy();
  expect(screen.getByText("Prairie Farm")).toBeTruthy();
  expect(screen.getByText("21.5 °C")).toBeTruthy();
  expect(screen.getAllByText("Not measured")).toHaveLength(3);
  expect(screen.getByText(/stale limits are not configured/)).toBeTruthy();
  expect(screen.getByText("Upper probe")).toBeTruthy();
  expect(screen.getByText("Uncalibrated · active")).toBeTruthy();
  expect(api.binLatest).toHaveBeenCalledWith("bin-0100");
  client.clear();
});

test("uses a stable short bin fallback and preserves latest data when trend fails", async () => {
  const api = {
    binLatest: vi.fn(async () => ({
      bin: { binId: "bin-0100", name: "", siteName: null },
      devices: [],
      devicesTruncated: false,
      readings: [],
      layout: [],
      sensorReadings: [],
      policies: [],
      freshness: "not_configured",
    })),
    binTrend: vi.fn(async () => {
      throw new Error("trend unavailable");
    }),
  };
  const client = renderBin(api);
  expect(await screen.findByRole("heading", { name: "Bin 0100" })).toBeTruthy();
  expect(
    await screen.findByText("No eligible devices are bound to this bin."),
  ).toBeTruthy();
  expect(
    await screen.findByText(
      "Trend data is temporarily unavailable. Latest readings remain available.",
    ),
  ).toBeTruthy();
  client.clear();
});
