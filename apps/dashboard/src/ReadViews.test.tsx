// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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
  vi.useRealTimers();
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

test("devices browse by default, debounce short searches, and restore browse when cleared", async () => {
  const sensor = { deviceId: "d1", name: "Silo sensor", status: "active" };
  const search = vi.fn(async (query: string) => (query ? [] : [sensor]));
  renderView("/devices", { search } as unknown as ReadApi);
  expect(await screen.findByRole("link", { name: "Silo sensor" })).toBeTruthy();
  expect(search).toHaveBeenCalledWith(
    "",
    25,
    undefined,
    expect.any(AbortSignal),
  );
  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText("Device name, ID, or serial number"), {
    target: { value: "s" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(299);
  });
  expect(search).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(search).toHaveBeenLastCalledWith(
    "s",
    25,
    undefined,
    expect.any(AbortSignal),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText("No devices match this search.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Device name, ID, or serial number"), {
    target: { value: "" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301);
  });
  expect(search).toHaveBeenLastCalledWith(
    "",
    25,
    undefined,
    expect.any(AbortSignal),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByRole("link", { name: "Silo sensor" })).toBeTruthy();
});

test("a newer search cancels the old query and never renders its late response", async () => {
  let resolveOld!: (value: unknown[]) => void;
  let oldSignal!: AbortSignal;
  const search = vi.fn(
    (query: string, _limit: number, _minimum: unknown, signal: AbortSignal) => {
      if (query === "old") {
        oldSignal = signal;
        return new Promise<unknown[]>((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve(
        query ? [{ deviceId: "new", name: "New sensor" }] : [],
      );
    },
  );
  renderView("/devices", { search } as unknown as ReadApi);
  await screen.findByText("No devices in your workspace yet.");
  const input = screen.getByLabelText("Device name, ID, or serial number");
  fireEvent.change(input, { target: { value: "old" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(oldSignal).toBeDefined());
  fireEvent.change(input, { target: { value: "new" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByRole("link", { name: "New sensor" })).toBeTruthy();
  expect(oldSignal.aborted).toBe(true);
  await act(async () => {
    resolveOld([{ deviceId: "old", name: "Old sensor" }]);
  });
  expect(screen.queryByRole("link", { name: "Old sensor" })).toBeNull();
});

test("switching sessions clears the query and cannot display another workspace's pending result", async () => {
  let resolveOld!: (value: unknown[]) => void;
  let oldSignal!: AbortSignal;
  const oldSearch = vi.fn(
    (
      _query: string,
      _limit: number,
      _minimum: unknown,
      signal: AbortSignal,
    ) => {
      oldSignal = signal;
      return new Promise<unknown[]>((resolve) => {
        resolveOld = resolve;
      });
    },
  );
  const newSearch = vi.fn(async () => [
    { deviceId: "new", name: "New workspace sensor" },
  ]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (api: ReadApi, sessionId: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DeviceSearch api={api} sessionId={sessionId} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(
    tree({ search: oldSearch } as unknown as ReadApi, "tenant-a"),
  );
  await waitFor(() => expect(oldSignal).toBeDefined());
  fireEvent.change(screen.getByLabelText("Device name, ID, or serial number"), {
    target: { value: "abc" },
  });
  view.rerender(tree({ search: newSearch } as unknown as ReadApi, "tenant-b"));
  expect(
    await screen.findByRole("link", { name: "New workspace sensor" }),
  ).toBeTruthy();
  expect(
    (
      screen.getByLabelText(
        "Device name, ID, or serial number",
      ) as HTMLInputElement
    ).value,
  ).toBe("");
  expect(newSearch).toHaveBeenCalledWith(
    "",
    25,
    undefined,
    expect.any(AbortSignal),
  );
  expect(oldSignal.aborted).toBe(true);
  await act(async () => {
    resolveOld([{ deviceId: "old", name: "Other workspace sensor" }]);
  });
  expect(
    screen.queryByRole("link", { name: "Other workspace sensor" }),
  ).toBeNull();
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

test("history loads cursor pages and identifies the stores used", async () => {
  const row = (readingId: string, observedAt: string) => ({
    readingId,
    deviceId: "d1",
    observedAt,
    receivedAt: observedAt,
    projectedAt: null,
    temperatureC: 20,
    relativeHumidityPercent: 60,
    streamVersion: null,
    inventoryEnrichment: null,
  });
  const history = vi.fn(
    async (
      _id: string,
      _from: string,
      _to: string,
      _limit: number,
      after?: string,
    ) =>
      after
        ? {
            items: [row("r3", "2026-09-20T11:00:00Z")],
            nextCursor: null,
            sources: { postgres: false, cassandra: true },
          }
        : {
            items: [
              row("r2", "2026-09-20T12:00:00Z"),
              row("r1", "2026-09-20T11:30:00Z"),
            ],
            nextCursor: "page-2-cursor",
            sources: { postgres: true, cassandra: false },
          },
  );
  renderView("/devices/d1/history", { history } as unknown as ReadApi);
  fireEvent.click(screen.getByRole("button", { name: "Load history" }));
  await waitFor(() =>
    expect(screen.getByText(/Showing 2 readings/).textContent).toContain(
      "Sources: PostgreSQL.",
    ),
  );
  expect(screen.getAllByRole("row")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Load more readings" }));
  await waitFor(() =>
    expect(screen.getByText(/Showing 3 readings/).textContent).toContain(
      "Sources: PostgreSQL + Cassandra.",
    ),
  );
  expect(screen.getAllByRole("row")).toHaveLength(4);
  expect(history.mock.calls[1][4]).toBe("page-2-cursor");
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

test("older rollup ranges offer an actionable explanation and recent-range recovery", async () => {
  const rollups = vi
    .fn()
    .mockRejectedValueOnce(new Error("rollup_outside_hot_window"))
    .mockResolvedValueOnce([]);
  renderView("/devices/d1/rollups", { rollups } as unknown as ReadApi);
  fireEvent.click(screen.getByRole("button", { name: "Load averages" }));
  expect(
    await screen.findByText(/This range includes older readings/),
  ).toBeTruthy();
  expect(screen.queryByText("rollup_outside_hot_window")).toBeNull();
  expect(
    screen
      .getByRole("link", { name: "View older reading history" })
      .getAttribute("href"),
  ).toBe("/devices/d1/history");
  fireEvent.click(screen.getByRole("button", { name: "Use recent 12 hours" }));
  await waitFor(() => expect(rollups).toHaveBeenCalledTimes(2));
  const [, from, to] = rollups.mock.calls[1];
  expect(new Date(to).getTime() - new Date(from).getTime()).toBe(
    12 * 60 * 60 * 1000,
  );
});
