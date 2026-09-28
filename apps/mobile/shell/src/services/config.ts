// Public build-time endpoints. `deployment.generated.ts` is created by the
// configure script and ignored by Git. Release builds have no localhost fallback.
import { DEPLOYMENT_CONFIG } from './deployment.generated';

// The scope line carries Dex's cross-client audience request: the BFF accepts
// the single audience `greenguard-dashboard`, so the mobile token must list it.
export const LOCAL_DEV_CONFIG = {
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

export type MobileLiveConfig = typeof LOCAL_DEV_CONFIG;

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
  return Object.values(LIVE_CONFIG).every(value => value.length > 0);
}
