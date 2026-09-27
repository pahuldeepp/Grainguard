import { LIVE_CONFIG, liveConfigured } from '../src/services/config';

declare const __dirname: string;
const fs = require('fs');
const path = require('path');

const ios = path.join(__dirname, '../ios/GreenGuardMobile');
const read = (name: string) => fs.readFileSync(path.join(ios, name), 'utf8');

test('dev live config points at the local Dex client and holds no secret', () => {
  expect(liveConfigured()).toBe(true);
  expect(LIVE_CONFIG.clientId).toBe('greenguard-mobile');
  expect(LIVE_CONFIG.redirectUri).toBe('greenguard://auth/callback');
  expect(LIVE_CONFIG.authorizationEndpoint).toBe(
    'http://127.0.0.1:5556/dex/auth',
  );
  expect(LIVE_CONFIG.scope).toContain('audience:server:client_id:');
  expect(JSON.stringify(LIVE_CONFIG)).not.toMatch(/password|secret/i);
});

test('the registered redirect matches the Dex template and the URL scheme', () => {
  const dex = fs.readFileSync(
    path.join(__dirname, '../../../../infra/oidc/dex.yaml.tpl'),
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
  const project = fs.readFileSync(
    path.join(ios, '../GreenGuardMobile.xcodeproj/project.pbxproj'),
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
