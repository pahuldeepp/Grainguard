import type { AuthorizationConfig } from "./pkce.js";
import { decodeClaims } from "./jwt.js";

export interface OidcConfig extends AuthorizationConfig {
  tokenEndpoint: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
}

export interface OidcDeps {
  fetch: typeof fetch;
  now: () => number;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "OidcError";
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
}

// React Native's fetch does not serialise a URLSearchParams object (the server then sees no
// grant_type), so the form body is built as an explicit string.
function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

async function requestTokens(
  config: OidcConfig,
  form: Record<string, string>,
  previousRefreshToken: string | undefined,
  deps: OidcDeps,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await deps.fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formEncode({ client_id: config.clientId, ...form }),
    });
  } catch {
    throw new OidcError("Identity provider unreachable", true);
  }
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    const transient = response.status >= 500 || response.status === 429;
    throw new OidcError(
      transient
        ? `Identity provider unavailable (${response.status})`
        : `Token request rejected: ${payload.error ?? response.status}`,
      transient,
    );
  }
  if (!payload.access_token)
    throw new OidcError("Token response has no access_token", false);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? previousRefreshToken,
    idToken: payload.id_token,
    expiresAt: deps.now() + (payload.expires_in ?? 0) * 1000,
  };
}

export async function exchangeCode(
  config: OidcConfig,
  grant: { code: string; verifier: string; nonce: string },
  deps: OidcDeps,
): Promise<TokenSet> {
  const tokens = await requestTokens(
    config,
    {
      grant_type: "authorization_code",
      code: grant.code,
      code_verifier: grant.verifier,
      redirect_uri: config.redirectUri,
    },
    undefined,
    deps,
  );
  if (tokens.idToken && decodeClaims(tokens.idToken).nonce !== grant.nonce)
    throw new OidcError("ID token nonce mismatch", false);
  return tokens;
}

export function refreshTokens(
  config: OidcConfig,
  refreshToken: string,
  deps: OidcDeps,
): Promise<TokenSet> {
  return requestTokens(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    refreshToken,
    deps,
  );
}
