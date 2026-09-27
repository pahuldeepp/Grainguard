// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  DeviceCurrent,
  DeviceHistory,
  DeviceRollups,
  DeviceSearch,
} from "./ReadViews";
import type { ReadApi } from "./read-api";
import { formatTimestamp } from "./format";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderView(
  path: string,
  api: ReadApi | null,
  sessionId = "session-a",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/devices"
            element={<DeviceSearch api={api} sessionId={sessionId} />}
          />
          <Route
            path="/devices/:deviceId"
            element={<DeviceCurrent api={api} sessionId={sessionId} />}
          />
          <Route
            path="/devices/:deviceId/history"
            element={<DeviceHistory api={api} sessionId={sessionId} />}
          />
          <Route
            path="/devices/:deviceId/rollups"
            element={<DeviceRollups api={api} sessionId={sessionId} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("current view shows observed and received times without inventing a missing measurement", async () => {
  const api = {
    current: vi.fn(async () => ({
      device: {
        deviceId: "d1",
        name: "Bin sensor",
        status: "active",
        siteId: "s1",
        binId: null,
        projectedAt: null,
      },
      latestReading: {
        readingId: "r1",
        deviceId: "d1",
        observedAt: "2026-09-20T12:00:00Z",
        receivedAt: "2026-09-20T12:01:00Z",
        projectedAt: null,
        temperatureC: null,
        relativeHumidityPercent: 63,
        streamVersion: null,
        inventoryEnrichment: null,
      },
    })),
  } as unknown as ReadApi;
  renderView("/devices/d1", api);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await waitFor(() =>
    expect(screen.getByText("Bin sensor", { exact: false })).toBeTruthy(),
  );
  expect(screen.getByText("No measurement")).toBeTruthy();
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(
    screen.getByText(formatTimestamp("2026-09-20T12:00:00Z")),
  ).toBeTruthy();
  expect(screen.getByText("Latest reading")).toBeTruthy();
  const readingsRegion = screen.getByRole("region", { name: "Readings" });
  const table = screen.getByRole("table");
  expect(readingsRegion.contains(table)).toBe(true);
  expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
});

test("accepted reading stays pending until projected, even when latest is older", async () => {
  let projected = false;
  const reading = vi.fn(async () =>
    projected
      ? {
          readingId: "r2",
          deviceId: "d1",
          observedAt: "2026-09-19T12:00:00Z",
          receivedAt: "2026-09-20T12:02:00Z",
          projectedAt: "2026-09-20T12:03:00Z",
          temperatureC: 20,
          relativeHumidityPercent: 60,
          streamVersion: "2",
          inventoryEnrichment: null,
        }
      : null,
  );
  const api = {
    current: vi.fn(async () => ({
      device: {
        deviceId: "d1",
        siteId: "s1",
        binId: null,
        name: "Sensor",
        status: "active",
        projectedAt: null,
      },
      latestReading: {
        readingId: "r1",
        deviceId: "d1",
        observedAt: "2026-09-20T12:00:00Z",
        receivedAt: "2026-09-20T12:01:00Z",
        projectedAt: "2026-09-20T12:01:30Z",
        temperatureC: 21,
        relativeHumidityPercent: 61,
        streamVersion: "1",
        inventoryEnrichment: null,
      },
    })),
    reading,
  } as unknown as ReadApi;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/devices/d1?readingId=r2"]}>
        <Routes>
          <Route
            path="/devices/:deviceId"
            element={<DeviceCurrent api={api} sessionId="session-a" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "Stored; updating dashboard",
    ),
  );
  projected = true;
  await client.invalidateQueries({
    queryKey: ["read", "session-a", "accepted", "r2"],
  });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain(
      "historical reading did not replace",
    ),
  );
  expect(reading).toHaveBeenCalledWith("r2");
});

test("search offers a scoped empty state and never fetches before submit", async () => {
  const search = vi.fn(async () => []);
  renderView("/devices", { search } as unknown as ReadApi);
  expect(search).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Device name, ID, or serial number"), {
    target: { value: "silo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(screen.getByText("No devices match this search.")).toBeTruthy(),
  );
  expect(search).toHaveBeenCalledWith("silo");
});

test("history rejects an inverted range before querying", () => {
  const history = vi.fn();
  renderView("/devices/d1/history", { history } as unknown as ReadApi);
  fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-09-21T12:00" },
  });
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-09-20T12:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load history" }));
  expect(screen.getByRole("alert").textContent).toContain("valid start time");
  expect(history).not.toHaveBeenCalled();
});

test("unauthenticated current view never requests device data", () => {
  const current = vi.fn();
  renderView("/devices/d1", { current } as unknown as ReadApi, "");
  expect(screen.getByText("Sign in to view device readings.")).toBeTruthy();
  expect(current).not.toHaveBeenCalled();
});

test("rollups request owner averages with an explicit bounded range and bucket", async () => {
  const rollups = vi.fn(async (...args: [string, string, string, string]) => {
    void args;
    return [
      {
        bucketStart: "2026-09-25T09:00:00Z",
        sampleCount: 12,
        avgTemperatureC: 21.5,
        avgRelativeHumidityPercent: 62,
      },
    ];
  });
  renderView("/devices/d1/rollups", { rollups } as unknown as ReadApi);
  fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-09-25T09:00" },
  });
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-09-25T10:00" },
  });
  fireEvent.change(screen.getByLabelText("Group by"), {
    target: { value: "day" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load averages" }));
  await waitFor(() => expect(rollups).toHaveBeenCalledTimes(1));
  expect(rollups.mock.calls[0][0]).toBe("d1");
  expect(rollups.mock.calls[0][3]).toBe("day");
  expect(await screen.findByText("21.5 °C")).toBeTruthy();
});

test("an unavailable Read API shows a friendly error", async () => {
  const search = vi.fn(async () => {
    throw new Error("upstream_unavailable");
  });
  renderView("/devices", { search } as unknown as ReadApi);
  fireEvent.change(screen.getByLabelText("Device name, ID, or serial number"), {
    target: { value: "silo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "temporarily unavailable",
    ),
  );
});
