import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const shell = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(shell, 'src/services/deployment.generated.ts');
const args = process.argv.slice(2);
const usage = 'Usage: node scripts/configure.mjs --file <public-config.json> | --reset | --ensure';

function fail(message) {
  throw new Error(`${message}\n${usage}`);
}

function httpsUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} must be an HTTPS URL`);
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) fail(`${field} must be an HTTPS URL without credentials, query or fragment`);
  if (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === 'example.com' ||
    url.hostname.endsWith('.example.com') ||
    url.hostname.endsWith('.invalid')
  ) fail(`${field} must use a reachable deployed hostname, not a placeholder or loopback`);
  return url.toString().replace(/\/$/, '');
}

export function publicConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('Configuration must be a JSON object');
  const keys = ['authorizationEndpoint', 'tokenEndpoint', 'bffEndpoint', 'clientId', 'scope'];
  if (Object.keys(input).some(key => ![...keys, 'audience'].includes(key)))
    fail('Configuration contains an unexpected key; do not put secrets here');
  if (keys.some(key => typeof input[key] !== 'string' || !input[key]))
    fail(`Configuration requires: ${keys.join(', ')}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(input.clientId))
    fail('clientId has invalid characters');
  if (input.audience !== undefined &&
    (typeof input.audience !== 'string' || !input.audience || input.audience.length > 200))
    fail('audience must be a nonempty public identifier');
  if (input.scope.length > 500 || !input.scope.split(/\s+/).includes('openid'))
    fail('scope must include openid and be at most 500 characters');
  const bffEndpoint = httpsUrl(input.bffEndpoint, 'bffEndpoint');
  if (new URL(bffEndpoint).pathname !== '/graphql')
    fail('bffEndpoint must point to /graphql');
  return {
    authorizationEndpoint: httpsUrl(input.authorizationEndpoint, 'authorizationEndpoint'),
    tokenEndpoint: httpsUrl(input.tokenEndpoint, 'tokenEndpoint'),
    clientId: input.clientId,
    redirectUri: 'greenguard://auth/callback',
    scope: input.scope,
    ...(input.audience ? { audience: input.audience } : {}),
    bffEndpoint,
  };
}

export function configure(argv = args) {
  if (argv.length === 1 && argv[0] === '--ensure') {
    if (existsSync(output)) return;
    writeFileSync(output, 'export const DEPLOYMENT_CONFIG = null;\n');
    return;
  }
  if (argv.length === 1 && argv[0] === '--reset') {
    writeFileSync(output, 'export const DEPLOYMENT_CONFIG = null;\n');
    return;
  }
  if (argv.length !== 2 || argv[0] !== '--file') fail('Invalid arguments');
  const input = JSON.parse(readFileSync(resolve(argv[1]), 'utf8'));
  const config = publicConfig(input);
  writeFileSync(output, `export const DEPLOYMENT_CONFIG = ${JSON.stringify(config, null, 2)} as const;\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  configure();
