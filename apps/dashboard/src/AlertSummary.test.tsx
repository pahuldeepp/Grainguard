// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AlertSummary } from "./AlertSummary";
import type { AlertsApi, AlertView } from "./alerts-api";

afterEach(cleanup);

const alert = (n: number, severity: string): AlertView => ({
  alertId: `id-${n}`,
  ruleId: "grain-risk-default",
  binId: `bin-${n}`,
  state: "open",
  severity,
  score: 50 + n,
  version: "1",
  openedAt: "2026-09-25T10:00:00Z",
  acknowledgedAt: null,
  escalationLevel: 0,
});

function renderSummary(api: AlertsApi | null, sessionId = "t:u") {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AlertSummary api={api} sessionId={sessionId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

test("renders nothing and does not fetch when signed out", () => {
  const list = vi.fn();
  renderSummary({ list } as unknown as AlertsApi, "");
  expect(screen.queryByRole("heading")).toBeNull();
  expect(list).not.toHaveBeenCalled();
});

test("lists the worst open alerts first, at most five, with a link to each", async () => {
  const items = [
    alert(1, "notice"),
    alert(2, "critical"),
    alert(3, "warning"),
    alert(4, "high"),
    alert(5, "notice"),
    alert(6, "notice"),
  ];
  const client = renderSummary({
    list: async () => ({ items, nextCursor: "more" }),
  } as unknown as AlertsApi);
  await screen.findByText("Bin 0002");
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(
    screen.getByRole("heading", { name: /Open alerts/ }).textContent,
  ).toContain("6+");
  expect(screen.getByText("Bin 0002").closest("a")?.getAttribute("href")).toBe(
    "/alerts?alert=id-2",
  );
  expect(screen.getByRole("link", { name: "All alerts" })).toBeTruthy();
  client.clear();
});

test("says bins are within limits when nothing is open, and offers retry on failure", async () => {
  const list = vi
    .fn()
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValue({ items: [], nextCursor: null });
  const client = renderSummary({ list } as unknown as AlertsApi);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("No open alerts. Bins are within limits."),
  ).toBeTruthy();
  expect(list).toHaveBeenCalledTimes(2);
  client.clear();
});

test("uses projected bin and site names in the overview summary", async () => {
  const item = {
    ...alert(7, "high"),
    binName: "North Silo",
    siteName: "Prairie Farm",
  };
  const client = renderSummary({
    list: async () => ({ items: [item], nextCursor: null }),
  } as unknown as AlertsApi);
  await screen.findByText("North Silo");
  expect(screen.getByText("Prairie Farm")).toBeTruthy();
  client.clear();
});
