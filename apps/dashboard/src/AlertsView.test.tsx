// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { AlertsView } from "./AlertsView";
import { binLabel } from "./bin-label";
import type { AlertsApi, AlertPage, AlertView } from "./alerts-api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderAlerts(
  api: AlertsApi | null,
  sessionId = "tenant-a:user-a",
  path = "/alerts",
  roles = ["viewer"],
) {
  if (api) {
    const merged = { ...api } as unknown as AlertsApi;
    merged.history ??= vi.fn(async (id: string) => ({
      alertId: id,
      items: [
        {
          transitionId: `${id}:opened`,
          version: "1",
          type: "opened",
          fromState: null,
          toState: "open",
          occurredAt: "2026-09-25T10:00:00Z",
          actor: { kind: "system", isYou: false, handle: null },
          cause: { kind: "risk_event" },
        },
      ],
      nextCursor: null,
      complete: true,
      source: { status: "ok", reasonCode: null },
    }));
    merged.notifications ??= vi.fn(async () => ({
      items: [],
      nextCursor: null,
      complete: true,
      sources: {
        intents: { status: "ok", reasonCode: null },
        warning: { status: "ok", reasonCode: null },
        critical: {
          status: "not_configured",
          reasonCode: "channel_unconfigured",
        },
        transitions: { status: "ok", reasonCode: null },
      },
    }));
    api = merged;
  }
  const provisioningApi = {
    session: vi.fn(async () => ({
      subject: "user-a",
      tenantId: "tenant-a",
      roles,
    })),
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AlertsView
          api={api}
          provisioningApi={provisioningApi as never}
          sessionId={sessionId}
        />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const make = (
  n: number,
  severity: string,
  state = "open",
  openedAt = "2026-09-25T10:00:00Z",
): AlertView => ({
  alertId: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
  ruleId: "grain-risk-default",
  binId: `bin-${n}`,
  state,
  severity,
  score: 70 + n,
  version: "3",
  openedAt,
  acknowledgedAt: state === "acknowledged" ? "2026-09-25T11:00:00Z" : null,
  escalationLevel: 0,
});

test("alert list uses the owner page cursor and keeps the signed-in scope", async () => {
  const list = vi.fn(async (after?: string): Promise<AlertPage> => ({
    items: [],
    nextCursor: after ? null : "11111111-1111-4111-8111-111111111111",
  }));
  const client = renderAlerts({ list } as unknown as AlertsApi);
  await waitFor(() => expect(list).toHaveBeenCalledWith(undefined, "open"));
  fireEvent.click(await screen.findByRole("link", { name: "Next page" }));
  await waitFor(() =>
    expect(list).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "open",
    ),
  );
  expect(screen.getByTestId("location").textContent).toContain("after=");
  client.clear();
});

test("an uncertain acknowledgement retries with the same idempotency key", async () => {
  const item = make(1, "high");
  const acknowledge = vi.fn(async (...args: [string, string, string]) => {
    void args;
    throw new Error("Request timed out");
  });
  const client = renderAlerts({
    list: async () => ({ items: [item], nextCursor: null }),
    acknowledge,
  } as unknown as AlertsApi);
  const button = await screen.findByRole("button", { name: "Acknowledge" });
  fireEvent.click(button);
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
  await screen.findByRole("alert");
  fireEvent.click(button);
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
  expect(acknowledge.mock.calls[0][2]).toEqual(acknowledge.mock.calls[1][2]);
  client.clear();
});

test("signed-out alerts do not fetch", () => {
  const list = vi.fn();
  const client = renderAlerts({ list } as unknown as AlertsApi, "");
  expect(screen.getByText("Sign in to view alerts.")).toBeTruthy();
  expect(list).not.toHaveBeenCalled();
  client.clear();
});

test("lists open alerts by severity then age and shows a severity word", async () => {
  const items = [
    make(1, "warning", "open", "2026-09-25T06:00:00Z"),
    make(2, "critical", "open", "2026-09-25T09:00:00Z"),
    make(3, "critical", "open", "2026-09-25T07:00:00Z"),
    make(4, "high", "acknowledged"),
  ];
  const client = renderAlerts(
    {
      list: async () => ({ items, nextCursor: null }),
    } as unknown as AlertsApi,
    "tenant-a:user-a",
    "/alerts?state=all",
  );
  await screen.findByText("Bin 0003");
  const rows = screen.getAllByRole("listitem");
  expect(
    rows.map((row) => /Bin \d{4}/.exec(row.textContent ?? "")?.[0]),
  ).toEqual(["Bin 0003", "Bin 0002", "Bin 0001", "Bin 0004"]);
  expect(within(rows[0]).getByText("Critical")).toBeTruthy();
  expect(within(rows[3]).getByText("Acknowledged")).toBeTruthy();
  client.clear();
});

test("the state filter lives in the URL and shows counts", async () => {
  const list = vi.fn(async (_after?: string, state?: string) => ({
    items:
      state === "acknowledged"
        ? [make(9, "high", "acknowledged")]
        : [make(1, "high"), make(2, "notice")],
    nextCursor: null,
  }));
  const client = renderAlerts({ list } as unknown as AlertsApi);
  await screen.findByRole("button", { name: "Open (2)" });
  expect(screen.getByRole("button", { name: "Acknowledged (1)" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /All/ }).getAttribute("aria-pressed"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Acknowledged (1)" }));
  await screen.findByText("Bin 0009");
  expect(screen.getByTestId("location").textContent).toBe(
    "?state=acknowledged",
  );
  client.clear();
});

test("shows a calm empty state and a retry after a failed load", async () => {
  let fail = true;
  const list = vi.fn(async () => {
    if (fail) throw new Error("boom");
    return { items: [], nextCursor: null };
  });
  const client = renderAlerts({ list } as unknown as AlertsApi);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Alerts are temporarily unavailable.",
  );
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No open alerts. Bins are within limits.");
  client.clear();
});

test("acknowledging from the detail confirms, then offers the list and the next open alert", async () => {
  const first = { ...make(1, "critical"), binName: "North Silo" };
  const second = make(2, "high");
  const acknowledge = vi.fn(async () => ({
    episodeId: "e",
    state: "acknowledged",
    version: "4",
    eventId: "ev",
  }));
  const list = vi.fn(async (_after?: string, state?: string) => ({
    items: state === "open" ? [first, second] : [],
    nextCursor: null,
  }));
  const client = renderAlerts(
    { list, acknowledge } as unknown as AlertsApi,
    "tenant-a:user-a",
    `/alerts?alert=${first.alertId}`,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));
  const status = await screen.findByText("Acknowledged North Silo.");
  expect(status.closest("[aria-live='polite']")).toBeTruthy();
  // The detail stays readable and now says Acknowledged even after the list refetches.
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(4));
  expect(screen.getAllByText("Acknowledged").length).toBeGreaterThan(0);
  const back = screen.getAllByRole("link", { name: "Back to alerts" });
  expect(back.length).toBeGreaterThan(0);
  const next = screen.getByRole("link", { name: "Next open alert" });
  fireEvent.click(next);
  expect(screen.getByTestId("location").textContent).toContain(
    `alert=${second.alertId}`,
  );
  await screen.findByRole("heading", { name: "High alert" });
  client.clear();
});

test("opening an alert keeps the filter in the URL and Back to alerts returns to the list", async () => {
  const item = make(5, "high", "acknowledged");
  const client = renderAlerts(
    {
      list: async () => ({ items: [item], nextCursor: null }),
    } as unknown as AlertsApi,
    "tenant-a:user-a",
    "/alerts?state=acknowledged",
  );
  fireEvent.click(await screen.findByRole("link", { name: /Bin 0005/ }));
  expect(screen.getByTestId("location").textContent).toBe(
    `?state=acknowledged&alert=${item.alertId}`,
  );
  const heading = await screen.findByRole("heading", { name: "High alert" });
  expect(heading).toBeTruthy();
  expect(await screen.findByText("Opened · Team member")).toBeTruthy();
  expect(await screen.findByText("Notification delivery history")).toBeTruthy();
  expect(
    await screen.findByText(/operator or administrator access is required/i),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Back to alerts" }));
  expect(screen.getByTestId("location").textContent).toBe(
    "?state=acknowledged",
  );
  await screen.findByRole("button", { name: /Acknowledged/ });
  client.clear();
});

test("incomplete alert lifecycle history explains the gap without implying Cassandra retention", async () => {
  const item = make(6, "critical");
  const client = renderAlerts(
    {
      list: async () => ({ items: [item], nextCursor: null }),
      history: async (id: string) => ({
        alertId: id,
        items: [],
        nextCursor: null,
        complete: false,
        source: { status: "partial", reasonCode: "incomplete_lifecycle" },
      }),
    } as unknown as AlertsApi,
    "tenant-a:user-a",
    `/alerts?alert=${item.alertId}`,
  );
  expect(
    await screen.findByText(
      /Some alert lifecycle transitions are missing from the stored history/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /current state is available, but its stored transition history has gaps/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText("No lifecycle transitions are available for this alert."),
  ).toBeTruthy();
  expect(screen.queryByText(/retained transition history/i)).toBeNull();
  client.clear();
});

test("operator alert detail uses the owner notification surface and shows critical as not configured", async () => {
  const item = make(7, "high");
  const notifications = vi.fn(async () => ({
    items: [],
    nextCursor: null,
    complete: true,
    sources: {
      intents: { status: "ok", reasonCode: null },
      warning: { status: "ok", reasonCode: null },
      critical: {
        status: "not_configured",
        reasonCode: "critical_channel_unconfigured",
      },
      transitions: { status: "ok", reasonCode: null },
    },
  }));
  const client = renderAlerts(
    {
      list: async () => ({ items: [item], nextCursor: null }),
      notifications,
    } as unknown as AlertsApi,
    "tenant-a:operator-a",
    `/alerts?alert=${item.alertId}`,
    ["operator"],
  );
  await screen.findByText("Not configured · critical_channel_unconfigured");
  expect(notifications).toHaveBeenCalledWith(item.alertId, undefined);
  expect(
    await screen.findByText(
      "No notification attempts are available from the configured sources.",
    ),
  ).toBeTruthy();
  client.clear();
});

test("shows projected facility labels and keeps technical IDs behind an accessible disclosure", async () => {
  const item: AlertView = {
    ...make(100, "high"),
    binName: "North Silo 4",
    siteName: "Prairie Farm",
  };
  const client = renderAlerts(
    {
      list: async () => ({ items: [item], nextCursor: null }),
    } as unknown as AlertsApi,
    "tenant-a:user-a",
    `/alerts?alert=${item.alertId}`,
  );
  await screen.findByRole("heading", { name: "High alert" });
  expect(screen.getByText("North Silo 4")).toBeTruthy();
  expect(screen.getByText("Prairie Farm")).toBeTruthy();
  const disclosure = screen
    .getByText("Technical identifiers")
    .closest("details");
  expect(disclosure?.open).toBe(false);
  expect(disclosure?.querySelector("dd.mono")?.textContent).toBe(item.alertId);
  fireEvent.click(screen.getByText("Technical identifiers"));
  expect(disclosure?.open).toBe(true);
  expect(await screen.findByText(item.alertId)).toBeTruthy();
  expect(screen.getByText(item.version)).toBeTruthy();
  client.clear();
});

test("uses a stable short bin label when the name projection is missing", () => {
  expect(binLabel("bin-0100")).toBe("Bin 0100");
  expect(binLabel("bin-0100", "  Drying Bin  ")).toBe("Drying Bin");
});

test("marks an open alert with a distinct open-state icon and accessible text", async () => {
  const item = make(11, "high");
  const client = renderAlerts(
    {
      list: async () => ({ items: [item], nextCursor: null }),
    } as unknown as AlertsApi,
    "tenant-a:user-a",
    `/alerts?alert=${item.alertId}`,
  );
  await screen.findByRole("heading", { name: "High alert" });
  const openStatus = screen.getByText("Open").closest(".sev-open");
  expect(openStatus).toBeTruthy();
  expect(openStatus?.querySelector("rect")).toBeTruthy();
  client.clear();
});

test("a linked alert that is not in the list says so and offers the way back", async () => {
  const client = renderAlerts(
    {
      list: async () => ({ items: [], nextCursor: null }),
    } as unknown as AlertsApi,
    "tenant-a:user-a",
    "/alerts?alert=missing",
  );
  await screen.findByText("This alert is not in the current list.");
  expect(screen.getByRole("link", { name: "Back to alerts" })).toBeTruthy();
  client.clear();
});
