import {
  LOCAL_DEV_CONFIG,
  resolveLiveConfig,
} from '../src/services/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

declare const __dirname: string;

const ios = join(__dirname, '../ios/GreenGuardMobile');
const read = (name: string) => readFileSync(join(ios, name), 'utf8');

test('dev live config points at the local Dex client and holds no secret', () => {
  expect(LOCAL_DEV_CONFIG.clientId).toBe('greenguard-mobile');
  expect(LOCAL_DEV_CONFIG.redirectUri).toBe('greenguard://auth/callback');
  expect(LOCAL_DEV_CONFIG.authorizationEndpoint).toBe(
    'http://127.0.0.1:5556/dex/auth',
  );
  expect(LOCAL_DEV_CONFIG.scope).toContain('audience:server:client_id:');
  expect(JSON.stringify(LOCAL_DEV_CONFIG)).not.toMatch(/password|secret/i);
});

test('a deployment config overrides localhost in Debug and Release', () => {
  const deployed = {
    ...LOCAL_DEV_CONFIG,
    authorizationEndpoint: 'https://auth.example.com/dex/auth',
    tokenEndpoint: 'https://auth.example.com/dex/token',
    bffEndpoint: 'https://api.example.com/graphql',
  };
  expect(resolveLiveConfig(deployed, true)).toEqual(deployed);
  expect(resolveLiveConfig(deployed, false)).toEqual(deployed);
  expect(resolveLiveConfig(null, false).bffEndpoint).toBe('');
  expect(resolveLiveConfig(null, true)).toEqual(LOCAL_DEV_CONFIG);
});

test('the registered redirect matches the Dex template and the URL scheme', () => {
  const dex = readFileSync(
    join(__dirname, '../../../../infra/oidc/dex.yaml.tpl'),
    'utf8',
  );
  expect(dex).toContain('id: greenguard-mobile');
  expect(dex).toContain('greenguard://auth/callback');
  for (const plist of ['Info.plist', 'Info-Debug.plist'])
    expect(read(plist)).toMatch(
      /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>greenguard<\/string>/,
    );
});

test('plain HTTP is allowed to localhost in Debug only', () => {
  expect(read('Info.plist')).not.toContain('NSAppTransportSecurity');
  expect(read('Info.plist')).not.toContain('NSAllowsArbitraryLoads');
  const debug = read('Info-Debug.plist');
  expect(debug).toContain('NSExceptionDomains');
  expect(debug).toContain('<key>127.0.0.1</key>');
  expect(debug).toMatch(/NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
  const project = readFileSync(
    join(ios, '../GreenGuardMobile.xcodeproj/project.pbxproj'),
    'utf8',
  );
  const debugPlists = (project.match(/INFOPLIST_FILE = [^;]+;/g) ?? []).map(
    (line: string) => line.replace(/"/g, ''),
  );
  expect(debugPlists.sort()).toEqual([
    'INFOPLIST_FILE = GreenGuardMobile/Info-Debug.plist;',
    'INFOPLIST_FILE = GreenGuardMobile/Info.plist;',
  ]);
});
