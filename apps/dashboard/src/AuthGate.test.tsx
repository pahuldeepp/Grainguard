// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { createDashboardStore } from "./dashboard-state";

const signinRedirect = vi.fn();
let manager: unknown = null;
vi.mock("./auth", () => ({
  createAuthManager: () => manager,
  applySessionChange: vi.fn(),
  currentAccessToken: vi.fn(),
  returnPathFor: () => "/",
  sessionIdFor: () => "t:u",
  signOut: vi.fn(),
}));

import { AuthGate } from "./AuthGate";

function renderGate() {
  return render(
    <Provider store={createDashboardStore()}>
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AuthGate />
        </MemoryRouter>
      </QueryClientProvider>
    </Provider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline"))),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  signinRedirect.mockReset();
});

function fakeManager(getUser: () => Promise<unknown>) {
  const events = {
    addUserLoaded: vi.fn(),
    addUserUnloaded: vi.fn(),
    addUserSignedOut: vi.fn(),
    addAccessTokenExpired: vi.fn(),
    removeUserLoaded: vi.fn(),
    removeUserUnloaded: vi.fn(),
    removeUserSignedOut: vi.fn(),
    removeAccessTokenExpired: vi.fn(),
  };
  return { events, getUser, signinRedirect };
}

test("without a configured identity provider the app shell renders", async () => {
  manager = null;
  renderGate();
  expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
});

test("signed-out visitors get one clear sign-in action", async () => {
  manager = fakeManager(async () => null);
  renderGate();
  const button = await screen.findByRole("button", { name: "Sign in" });
  expect(
    screen.getByRole("heading", { level: 1, name: "Sign in" }),
  ).toBeTruthy();
  button.click();
  await waitFor(() => expect(signinRedirect).toHaveBeenCalledOnce());
});

test("a failed sign-in is announced with the reason", async () => {
  manager = fakeManager(async () => {
    throw new Error("Issuer unreachable");
  });
  renderGate();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Issuer unreachable",
  );
});

test("a signed-in user gets the shell with a Sign out button", async () => {
  manager = fakeManager(async () => ({ expired: false, state: null }));
  renderGate();
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeTruthy();
});
