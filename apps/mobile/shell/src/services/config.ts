// Public build-time endpoints. `deployment.generated.ts` is created by the
// configure script and ignored by Git. Release builds have no localhost fallback.
import { DEPLOYMENT_CONFIG } from './deployment.generated';

// Dex's audience is a cross-client PKCE scope. The shared PKCE client builds
// this special scope from audienceMode/audience and does not send `audience=`.
export const LOCAL_DEV_CONFIG = {
  authorizationEndpoint: 'http://127.0.0.1:5556/dex/auth',
  tokenEndpoint: 'http://127.0.0.1:5556/dex/token',
  clientId: 'greenguard-mobile',
  redirectUri: 'greenguard://auth/callback',
  scope: 'openid profile offline_access',
  audience: 'greenguard-dashboard',
  audienceMode: 'scope' as const,
  bffEndpoint: 'http://127.0.0.1:4400/graphql',
};

const EMPTY_LIVE_CONFIG = {
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: '',
  redirectUri: '',
  scope: '',
  audience: undefined,
  audienceMode: undefined,
  bffEndpoint: '',
};

export type MobileLiveConfig = Omit<typeof LOCAL_DEV_CONFIG, 'audience' | 'audienceMode'> & {
  audience?: string;
  audienceMode?: 'scope' | 'query-param';
};

export function resolveLiveConfig(
  deployment: MobileLiveConfig | null,
  development: boolean,
): MobileLiveConfig {
  return deployment ?? (development ? LOCAL_DEV_CONFIG : EMPTY_LIVE_CONFIG);
}

export const LIVE_CONFIG: MobileLiveConfig = resolveLiveConfig(
  DEPLOYMENT_CONFIG,
  __DEV__,
);

export function liveConfigured(): boolean {
  return Boolean(LIVE_CONFIG.authorizationEndpoint && LIVE_CONFIG.tokenEndpoint &&
    LIVE_CONFIG.clientId && LIVE_CONFIG.redirectUri && LIVE_CONFIG.scope && LIVE_CONFIG.bffEndpoint);
}
