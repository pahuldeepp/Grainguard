// Live-mode endpoints for the LOCAL development stack only (Stage 10e, ADR-0014).
// Nothing here is secret: Dex client `greenguard-mobile` is a public PKCE client
// registered in infra/oidc/dex.yaml.tpl, and the password is typed by the person
// signing in, never stored in source. In a release bundle every value is empty,
// so live sign-in reports "not configured" instead of contacting localhost.
//
// The scope line carries Dex's cross-client audience request: the BFF accepts
// the single audience `greenguard-dashboard`, so the mobile token must list it.
const DEV_LIVE_CONFIG = {
  authorizationEndpoint: 'http://127.0.0.1:5556/dex/auth',
  tokenEndpoint: 'http://127.0.0.1:5556/dex/token',
  clientId: 'greenguard-mobile',
  redirectUri: 'greenguard://auth/callback',
  scope:
    'openid profile offline_access audience:server:client_id:greenguard-dashboard',
  bffEndpoint: 'http://127.0.0.1:4400/graphql',
};

const EMPTY_LIVE_CONFIG = {
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: '',
  redirectUri: '',
  scope: '',
  bffEndpoint: '',
};

export const LIVE_CONFIG: typeof DEV_LIVE_CONFIG = __DEV__
  ? DEV_LIVE_CONFIG
  : EMPTY_LIVE_CONFIG;

export function liveConfigured(): boolean {
  return Object.values(LIVE_CONFIG).every(value => value.length > 0);
}
