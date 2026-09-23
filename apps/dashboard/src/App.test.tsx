// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

const ready = (service: string) =>
  new Response(JSON.stringify({ service, status: "ready" }));

function respondWith(
  handlers: Record<string, () => Response | Promise<Response>>,
) {
  const fetchMock = vi.fn((path: string) => {
    const handler = handlers[path];
    return handler ? handler() : Promise.reject(new Error("offline"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const statuses = () =>
  Array.from(container.querySelectorAll("output")).map((o) => o.textContent);

async function mount() {
  await act(async () => {
    root.render(<App />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("shows checking state, then ready for both services", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  respondWith({
    "/api/devices/readyz": async () => {
      await gate;
      return ready("device-service");
    },
    "/api/telemetry/readyz": async () => {
      await gate;
      return ready("telemetry-ingest");
    },
  });
  await mount();
  expect(statuses()).toEqual(["Checking…", "Checking…"]);
  await act(async () => release());
  expect(statuses()).toEqual(["Ready", "Ready"]);
  expect(container.querySelectorAll("output.ready")).toHaveLength(2);
  expect(container.textContent).toContain("Device service");
  expect(container.textContent).toContain("Telemetry ingestion");
});

test("marks an unhealthy or mismatched service unavailable", async () => {
  respondWith({
    "/api/devices/readyz": () => new Response("down", { status: 503 }),
    "/api/telemetry/readyz": () => ready("someone-else"),
  });
  await mount();
  expect(statuses()).toEqual(["Unavailable", "Unavailable"]);
  expect(container.querySelectorAll("output.offline")).toHaveLength(2);
});

test("polls every five seconds and reflects recovery", async () => {
  let deviceUp = false;
  const fetchMock = respondWith({
    "/api/devices/readyz": () =>
      deviceUp ? ready("device-service") : new Response("", { status: 503 }),
    "/api/telemetry/readyz": () => ready("telemetry-ingest"),
  });
  await mount();
  expect(statuses()).toEqual(["Unavailable", "Ready"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  deviceUp = true;
  await act(async () => vi.advanceTimersByTimeAsync(4999));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(statuses()).toEqual(["Ready", "Ready"]);
});

test("unmounting aborts requests, stops polling and ignores late results", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    await gate;
    return init?.signal?.aborted
      ? Promise.reject(new Error("aborted"))
      : ready("x");
  });
  vi.stubGlobal("fetch", fetchMock);
  await mount();
  const signals = fetchMock.mock.calls.map(([, init]) => init?.signal);
  expect(signals).toHaveLength(2);
  await act(async () => root.unmount());
  expect(signals.every((s) => s?.aborted)).toBe(true);
  await act(async () => release());
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  root = createRoot(container);
});
