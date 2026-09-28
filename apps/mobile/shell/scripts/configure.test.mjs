import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicConfig } from './configure.mjs';

const input = {
  authorizationEndpoint: 'https://auth.greenguard.app/dex/auth',
  tokenEndpoint: 'https://auth.greenguard.app/dex/token',
  bffEndpoint: 'https://api.greenguard.app/graphql',
  clientId: 'greenguard-mobile',
  scope: 'openid profile offline_access audience:server:client_id:greenguard-dashboard',
};

test('deployed public config accepts HTTPS OIDC endpoints and audience scope', () => {
  assert.deepEqual(publicConfig(input), {
    authorizationEndpoint: 'https://auth.greenguard.app/dex/auth',
    tokenEndpoint: 'https://auth.greenguard.app/dex/token',
    clientId: 'greenguard-mobile',
    redirectUri: 'greenguard://auth/callback',
    scope: 'openid profile offline_access audience:server:client_id:greenguard-dashboard',
    bffEndpoint: 'https://api.greenguard.app/graphql',
  });
});

test('disposable Cognito output shape configures native PKCE without a Dex audience', () => {
  const cell = {
    authorizationEndpoint: 'https://gg-cell.auth.us-east-1.amazoncognito.com/oauth2/authorize',
    tokenEndpoint: 'https://gg-cell.auth.us-east-1.amazoncognito.com/oauth2/token',
    bffEndpoint: 'https://d123.cloudfront.net/graphql',
    clientId: '3examplepublicclientid',
    scope: 'openid email profile',
  };
  assert.deepEqual(publicConfig(cell), {
    ...cell,
    redirectUri: 'greenguard://auth/callback',
  });
});

test('deployment config rejects HTTP, credentials, unknown keys and wrong API path', () => {
  assert.throws(() => publicConfig({ ...input, authorizationEndpoint: 'http://auth.greenguard.app/dex/auth' }), /HTTPS/);
  assert.throws(() => publicConfig({ ...input, bffEndpoint: 'https://user:pass@api.greenguard.app/graphql' }), /credentials/);
  assert.throws(() => publicConfig({ ...input, clientSecret: 'bad' }), /unexpected key/);
  assert.throws(() => publicConfig({ ...input, bffEndpoint: 'https://api.greenguard.app/healthz' }), /graphql/);
  assert.throws(() => publicConfig({ ...input, bffEndpoint: 'https://api.example.com/graphql' }), /placeholder/);
});
