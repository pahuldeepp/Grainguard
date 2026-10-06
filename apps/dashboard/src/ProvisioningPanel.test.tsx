// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Provisioning } from "./ProvisioningPanel";
import type { ProvisioningApi, ProvisioningStatus } from "./provisioning";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.useRealTimers();
});

function api(status: ProvisioningStatus) {
  return {
    start: vi.fn(async (...args: [string, string, string]) => {
      void args;
      return status.saga;
    }),
    status: vi.fn(async (...args: [string]) => {
      void args;
      return status;
    }),
    redrive: vi.fn(async (...args: [string, string]) => {
      void args;
      return status.saga;
    }),
    session: vi.fn(async () => ({
      subject: "operator",
      tenantId: "tenant-a",
      roles: ["operator", "admin"],
    })),
  };
}

async function render(
  client: ReturnType<typeof api> | null,
  sessionId = "user-a",
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Provisioning
          api={client as ProvisioningApi | null}
          sessionId={sessionId}
        />
      </QueryClientProvider>,
    ),
  );
  if (client)
    await waitFor(() =>
      expect(container.textContent).toContain("Start provisioning"),
    );
}

async function input(label: string, value: string) {
  const labelElement = Array.from(container.querySelectorAll("label")).find(
    (item) => item.textContent?.includes(label),
  );
  const field =
    labelElement?.querySelector("input") ??
    (labelElement?.htmlFor
      ? container.querySelector<HTMLInputElement>(`#${labelElement.htmlFor}`)
      : null);
  if (!field) throw new Error(`missing ${label}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function submit(buttonText: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === buttonText,
  );
  if (!button?.closest("form")) throw new Error(`missing ${buttonText}`);
  await act(async () =>
    button
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const snapshot: ProvisioningStatus = {
  saga: {
    sagaId: "saga-1",
    deviceId: "11111111-1111-4111-8111-111111111111",
    assetId: "22222222-2222-4222-8222-222222222222",
    state: "activating",
    version: 3,
    deadlineAt: "2030-01-01",
  },
  history: [
    {
      version: 3,
      action: "inventory.activated",
      reason: null,
      recordedAt: "2030-01-01",
    },
  ],
};

test("requires a session before offering provisioning controls", async () => {
  await render(null);
  expect(container.textContent).toContain("Sign-in integration is required");
  expect(container.querySelector("button")).toBeNull();
});

test("starts once, tracks durable status, and refreshes after five seconds", async () => {
  const client = api(snapshot);
  await render(client);
  vi.useFakeTimers();
  await input("Device ID", snapshot.saga.deviceId);
  await input("Physical sensor asset ID", snapshot.saga.assetId);
  await submit("Start provisioning");
  expect(client.start).toHaveBeenCalledWith(
    snapshot.saga.deviceId,
    snapshot.saga.assetId,
    expect.any(String),
  );
  expect(client.status).toHaveBeenCalledWith("saga-1");
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(container.textContent).toContain("activating");
  expect(container.textContent).toContain("inventory.activated");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(client.status).toHaveBeenCalledTimes(2);
});

test("retains the idempotency key on a failed start retry", async () => {
  const client = api(snapshot);
  client.start.mockRejectedValueOnce(new Error("Temporary outage"));
  await render(client);
  await input("Device ID", snapshot.saga.deviceId);
  await input("Physical sensor asset ID", snapshot.saga.assetId);
  await submit("Start provisioning");
  await waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Temporary outage",
    ),
  );
  await submit("Start provisioning");
  expect(client.start).toHaveBeenCalledTimes(2);
  expect(client.start.mock.calls[1][2]).toBe(client.start.mock.calls[0][2]);
});

test("shows repair state and redrives with an operator reason", async () => {
  const repair = {
    ...snapshot,
    saga: { ...snapshot.saga, state: "repair_required" },
  };
  const client = api(repair);
  await render(client);
  await input("Track provisioning ID", "saga-1");
  await waitFor(() =>
    expect(container.textContent).toContain("Automatic recovery stopped"),
  );
  await input("Redrive reason", "inspected sensor");
  await submit("Administrator redrive");
  expect(client.redrive).toHaveBeenCalledWith("saga-1", "inspected sensor");
  expect(client.status).toHaveBeenCalledTimes(2);
});

test("clears the prior user's saga immediately when the session changes", async () => {
  const client = api(snapshot);
  await render(client, "user-a");
  await input("Track provisioning ID", "saga-1");
  await waitFor(() =>
    expect(container.textContent).toContain("inventory.activated"),
  );
  await render(client, "user-b");
  expect(container.textContent).not.toContain("inventory.activated");
  expect((container.querySelector("#saga-id") as HTMLInputElement).value).toBe(
    "",
  );
});

test("a successful redrive is not presented as a failure when status refresh fails", async () => {
  const repair = {
    ...snapshot,
    saga: { ...snapshot.saga, state: "repair_required" },
  };
  const client = api(repair);
  client.redrive.mockResolvedValueOnce({
    ...repair.saga,
    state: "activating",
    version: 4,
  });
  client.status
    .mockResolvedValueOnce(repair)
    .mockRejectedValueOnce(new Error("read unavailable"));
  await render(client);
  await input("Track provisioning ID", "saga-1");
  await waitFor(() =>
    expect(container.textContent).toContain("Automatic recovery stopped"),
  );
  await input("Redrive reason", "checked hardware");
  await submit("Administrator redrive");
  expect(container.textContent).toContain(
    "Redrive succeeded; current status is temporarily unavailable",
  );
  expect(container.textContent).toContain("activating");
  expect(container.querySelector("button")?.textContent).not.toContain(
    "Administrator redrive",
  );
});

test("a viewer sees status only, without start controls", async () => {
  const client = api(snapshot);
  client.session.mockResolvedValue({
    subject: "viewer",
    tenantId: "tenant-a",
    roles: ["viewer"],
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Provisioning
          api={client as unknown as ProvisioningApi}
          sessionId="viewer-session"
        />
      </QueryClientProvider>,
    ),
  );
  await waitFor(() =>
    expect(container.textContent).toContain("Your role can view"),
  );
  expect(container.textContent).not.toContain("Start provisioning");
});

test("the idempotency key and tracked saga survive a remount for the same identity", async () => {
  window.sessionStorage.clear();
  const client = api(snapshot);
  await render(client, "iss:alice:login-1");
  await input("Device ID", snapshot.saga.deviceId);
  await input("Physical sensor asset ID", snapshot.saga.assetId);
  await submit("Start provisioning");
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(client, "iss:alice:login-2");
  await waitFor(() => expect(client.status).toHaveBeenCalledWith("saga-1"));
  await input("Device ID", snapshot.saga.deviceId);
  await input("Physical sensor asset ID", snapshot.saga.assetId);
  await submit("Start provisioning");
  expect(client.start.mock.calls[1][2]).toBe(client.start.mock.calls[0][2]);
  expect(window.location.search).toContain("saga=saga-1");
});

test("valid fixture link fills IDs without starting provisioning", async () => {
  const original = window.location.href;
  window.history.replaceState(
    {},
    "",
    `?deviceId=${snapshot.saga.deviceId}&assetId=${snapshot.saga.assetId}`,
  );
  try {
    const client = api(snapshot);
    await render(client);
    expect(container.querySelector<HTMLInputElement>("#device-id")?.value).toBe(
      snapshot.saga.deviceId,
    );
    expect(container.querySelector<HTMLInputElement>("#asset-id")?.value).toBe(
      snapshot.saga.assetId,
    );
    expect(client.start).not.toHaveBeenCalled();
  } finally {
    window.history.replaceState({}, "", original);
  }
});
