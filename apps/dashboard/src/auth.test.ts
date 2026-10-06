// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import type { User, UserManager } from "oidc-client-ts";
import { dashboardQueryClient } from "./DashboardProviders";
import { dashboardStore, uiActions } from "./dashboard-state";
import {
  applySessionChange,
  signOut,
  clearDashboardSession,
  currentAccessToken,
  oidcConfiguration,
  returnPathFor,
  sessionIdFor,
} from "./auth";

afterEach(() => vi.unstubAllEnvs());

test("requires complete OIDC configuration and uses code flow", () => {
  vi.stubEnv("VITE_OIDC_AUTHORITY", "https://idp.example.test");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "dashboard");
  // The workspace .env contains a real local IdP config; this test exercises
  // the incomplete-config branch and must not inherit that value.
  vi.stubEnv("VITE_OIDC_AUDIENCE", "");
  expect(oidcConfiguration()).toBeNull();
  vi.stubEnv("VITE_OIDC_AUDIENCE", "greenguard-api");
  expect(oidcConfiguration()).toMatchObject({
    authority: "https://idp.example.test",
    client_id: "dashboard",
    response_type: "code",
    extraQueryParams: { audience: "greenguard-api" },
    loadUserInfo: false,
  });
});

test("Cognito mode uses the public client and optional resource binding", () => {
  vi.stubEnv("VITE_OIDC_AUTHORITY", "https://issuer.example.test/pool");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "web-client");
  vi.stubEnv("VITE_OIDC_AUDIENCE", "");
  vi.stubEnv("VITE_OIDC_TOKEN_MODE", "cognito-access");
  expect(oidcConfiguration()).toMatchObject({
    client_id: "web-client",
    extraQueryParams: {},
    scope: "openid profile email",
  });
  vi.stubEnv("VITE_OIDC_RESOURCE", "https://api.example.test");
  expect(oidcConfiguration()?.extraQueryParams).toEqual({
    resource: "https://api.example.test",
  });
  vi.stubEnv("VITE_OIDC_AUDIENCE", "legacy-api");
  expect(oidcConfiguration()).toBeNull();
});

test("uses the IdP session and clears tenant-scoped browser state", () => {
  const user = {
    profile: { iss: "issuer", sub: "person", sid: "login-1" },
  } as User;
  expect(sessionIdFor(user)).toBe("issuer:person:login-1");
  dashboardQueryClient.setQueryData(["devices", "old-session"], {
    tenantId: "old",
  });
  dashboardStore.dispatch(uiActions.selectSite("old-site"));
  dashboardStore.dispatch(uiActions.selectDevice("old-device"));
  clearDashboardSession();
  expect(
    dashboardQueryClient.getQueryData(["devices", "old-session"]),
  ).toBeUndefined();
  expect(dashboardStore.getState().ui.selectedSiteId).toBeNull();
  expect(dashboardStore.getState().ui.selectedDeviceId).toBeNull();
});

test("restores only a relative dashboard route after OIDC callback", () => {
  expect(returnPathFor({ returnTo: "/provisioning?saga=saga-1" })).toBe(
    "/provisioning?saga=saga-1",
  );
  expect(returnPathFor({ returnTo: "//other.example/" })).toBe("/");
  expect(returnPathFor({ returnTo: "https://other.example/" })).toBe("/");
  expect(returnPathFor({ returnTo: "/auth/callback" })).toBe("/");
});

test("returns only a current access token and renews expired tokens", async () => {
  const expired = { expired: true, access_token: "old" } as User;
  const renewed = { expired: false, access_token: "new" } as User;
  const manager = {
    getUser: vi.fn().mockResolvedValue(expired),
    signinSilent: vi.fn().mockResolvedValue(renewed),
  } as unknown as UserManager;
  expect(await currentAccessToken(manager)).toBe("new");
  expect(manager.signinSilent).toHaveBeenCalledOnce();
  vi.mocked(manager.signinSilent).mockRejectedValueOnce(
    new Error("renewal failed"),
  );
  expect(await currentAccessToken(manager)).toBeNull();
});

test("keeps tokens out of Web Storage and uses the email scope for identity", () => {
  vi.stubEnv("VITE_OIDC_AUTHORITY", "http://127.0.0.1:5556/dex");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "greenguard-dashboard");
  vi.stubEnv("VITE_OIDC_AUDIENCE", "greenguard-dashboard");
  const config = oidcConfiguration()!;
  expect(config.scope).toContain("email");
  expect(config.userStore).not.toBe(config.stateStore);
  window.sessionStorage.clear();
  void config.userStore.set("user", "token-material");
  expect(window.sessionStorage).toHaveLength(0);
  expect(window.localStorage).toHaveLength(0);
});

test("same-login renewal refetches; a different login clears state", () => {
  const invalidate = vi.spyOn(dashboardQueryClient, "invalidateQueries");
  dashboardQueryClient.setQueryData(["devices", "s"], { tenantId: "a" });
  applySessionChange("login-1", "login-1");
  expect(invalidate).toHaveBeenCalledOnce();
  applySessionChange(undefined, "login-1");
  expect(invalidate).toHaveBeenCalledOnce();
  applySessionChange("login-1", "login-2");
  expect(dashboardQueryClient.getQueryData(["devices", "s"])).toBeUndefined();
  invalidate.mockRestore();
});

function managerWith(endSession: Promise<string | undefined>) {
  return {
    removeUser: vi.fn().mockResolvedValue(undefined),
    signoutRedirect: vi.fn().mockResolvedValue(undefined),
    metadataService: { getEndSessionEndpoint: vi.fn(() => endSession) },
  } as unknown as UserManager;
}

test("sign-out always drops the local session and redirects only when supported", async () => {
  const local = managerWith(Promise.resolve(undefined));
  dashboardQueryClient.setQueryData(["devices", "x"], { tenantId: "a" });
  await signOut(local);
  expect(local.removeUser).toHaveBeenCalledOnce();
  expect(local.signoutRedirect).not.toHaveBeenCalled();
  expect(dashboardQueryClient.getQueryData(["devices", "x"])).toBeUndefined();
  const failing = managerWith(Promise.reject(new Error("no metadata")));
  await signOut(failing);
  expect(failing.signoutRedirect).not.toHaveBeenCalled();
  const remote = managerWith(Promise.resolve("https://idp.test/logout"));
  await signOut(remote);
  expect(remote.signoutRedirect).toHaveBeenCalledOnce();
});
