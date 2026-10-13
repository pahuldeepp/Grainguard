import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicConfig } from './configure.mjs';

const input = {
  authorizationEndpoint: 'https://auth.greenguard.app/dex/auth',
  tokenEndpoint: 'https://auth.greenguard.app/dex/token',
  bffEndpoint: 'https://api.greenguard.app/graphql',
  clientId: 'greenguard-mobile',
  scope: 'openid profile offline_access',
  audience: 'greenguard-dashboard',
  audienceMode: 'scope',
};

test('deployed Dex config accepts scope audience mode without baking the special scope into base scopes', () => {
  assert.deepEqual(publicConfig(input), {
    authorizationEndpoint: 'https://auth.greenguard.app/dex/auth',
    tokenEndpoint: 'https://auth.greenguard.app/dex/token',
    clientId: 'greenguard-mobile',
    redirectUri: 'greenguard://auth/callback',
    scope: 'openid profile offline_access',
    audience: 'greenguard-dashboard',
    audienceMode: 'scope',
    bffEndpoint: 'https://api.greenguard.app/graphql',
  });
});

test('generic provider may explicitly select query-param audience mode', () => {
  const generic = publicConfig({ ...input, audienceMode: 'query-param' });
  assert.equal(generic.audienceMode, 'query-param');
  assert.equal(generic.audience, 'greenguard-dashboard');
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
  assert.throws(() => publicConfig({ ...input, audienceMode: 'fragment' }), /audienceMode must be/);
  assert.throws(() => publicConfig({ ...input, audience: undefined }), /audienceMode requires/);
  assert.throws(() => publicConfig({ ...input, audienceMode: undefined }), /requires an explicit audienceMode/);
  assert.throws(() => publicConfig({ ...input, bffEndpoint: 'https://api.greenguard.app/healthz' }), /graphql/);
  assert.throws(() => publicConfig({ ...input, bffEndpoint: 'https://api.example.com/graphql' }), /placeholder/);
});
