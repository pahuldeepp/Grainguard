import {
  InMemoryWebStorage,
  UserManager,
  WebStorageStateStore,
  type User,
} from "oidc-client-ts";
import { dashboardQueryClient } from "./DashboardProviders";
import { dashboardStore, uiActions } from "./dashboard-state";
import { deployedOidcConfig } from "./public-config";

export type AuthSession = { user: User; sessionId: string };

export function oidcConfiguration() {
  const deployed = deployedOidcConfig();
  const authority =
    deployed?.authority ?? import.meta.env.VITE_OIDC_AUTHORITY?.trim();
  const clientId =
    deployed?.clientId ?? import.meta.env.VITE_OIDC_CLIENT_ID?.trim();
  const audience = deployed
    ? deployed.audience
    : import.meta.env.VITE_OIDC_AUDIENCE?.trim();
  const tokenMode =
    deployed?.tokenMode ??
    import.meta.env.VITE_OIDC_TOKEN_MODE?.trim() ??
    "audience";
  const resource = deployed
    ? deployed.resource
    : import.meta.env.VITE_OIDC_RESOURCE?.trim();
  if (
    !authority ||
    !clientId ||
    (tokenMode !== "audience" && tokenMode !== "cognito-access") ||
    (tokenMode === "audience" && !audience) ||
    (tokenMode === "cognito-access" && audience)
  )
    return null;
  const origin = window.location.origin;
  const extraQueryParams: Record<string, string> =
    tokenMode === "cognito-access"
      ? resource
        ? { resource }
        : {}
      : { audience: audience! };
  return {
    authority,
    client_id: clientId,
    redirect_uri: `${origin}/auth/callback`,
    post_logout_redirect_uri: origin,
    response_type: "code",
    // Cognito issues refresh tokens for the code flow without an
    // offline_access scope; Dex uses that scope for offline sessions.
    scope:
      tokenMode === "cognito-access"
        ? "openid profile email"
        : "openid profile email offline_access",
    extraQueryParams,
    // ADR-0014: tokens live in memory only (no Web Storage), so injected script
    // cannot read them from storage after a reload; a reload asks for sign-in again.
    // PKCE verifier/state/nonce stay in sessionStorage for the redirect round trip.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: false,
  } as const;
}

export function createAuthManager() {
  const config = oidcConfiguration();
  return config ? new UserManager(config) : null;
}

export function sessionIdFor(user: User): string {
  const subject = user.profile.sub;
  const sid =
    user.profile.sid ??
    user.session_state ??
    user.profile.auth_time ??
    user.profile.iat;
  return `${user.profile.iss}:${subject}:${sid ?? "undefined"}`;
}

export function returnPathFor(state: unknown): string {
  const candidate =
    state && typeof state === "object" && "returnTo" in state
      ? (state as { returnTo: unknown }).returnTo
      : undefined;
  if (
    typeof candidate !== "string" ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.startsWith("/auth/callback")
  )
    return "/";
  return candidate;
}

export function clearDashboardSession() {
  dashboardQueryClient.clear();
  dashboardStore.dispatch(uiActions.clearSessionSelections());
}

export async function currentAccessToken(
  manager: UserManager,
): Promise<string | null> {
  let user = await manager.getUser();
  if (!user) return null;
  if (user.expired) {
    try {
      user = await manager.signinSilent();
    } catch {
      return null;
    }
  }
  return user && !user.expired ? user.access_token : null;
}

// A renewed token for the same login refetches durable state (reconnect-safe);
// a different login or sign-out discards every tenant-scoped cache first.
export function applySessionChange(
  previous: string | undefined,
  next: string | undefined,
) {
  if (previous && previous !== next) clearDashboardSession();
  else if (previous && next) void dashboardQueryClient.invalidateQueries();
}

// Dex (and some IdPs) publish no end_session_endpoint: always drop the local
// session, and only redirect when the provider supports RP-initiated logout.
export async function signOut(manager: UserManager): Promise<void> {
  clearDashboardSession();
  await manager.removeUser();
  const endSession = await manager.metadataService
    .getEndSessionEndpoint()
    .catch(() => undefined);
  if (endSession) await manager.signoutRedirect();
}
