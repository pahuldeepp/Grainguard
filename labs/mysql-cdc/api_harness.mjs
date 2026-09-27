// Local signed RS256 issuer and tenant-bound Device Service import endpoint.
// This is a test fixture, not a production OAuth/Control Plane replacement.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createTestIssuer } from '@greenguard/tenant-auth/testing';
import { createClientCredentialsVerifier } from '@greenguard/tenant-auth/service-principals';
import { startApi } from '../../services/device-service/dist/testing/api.js';
import { createTenant } from '../../services/device-service/dist/testing/fixtures.js';

const source = process.env.MYSQL_CDC_SOURCE_ID || 'partner-one';
const clients = {
  'importer-a': { tenant: process.env.MYSQL_CDC_TENANT_A, secret: process.env.MYSQL_CDC_CLIENT_A },
  'importer-b': { tenant: process.env.MYSQL_CDC_TENANT_B, secret: process.env.MYSQL_CDC_CLIENT_B },
};
if (Object.values(clients).some(binding => !binding.tenant || !binding.secret)) throw new Error('local importer fixture missing');
const issuer = await createTestIssuer();
const verifier = createClientCredentialsVerifier({
  issuer: issuer.issuer, audience: issuer.audience, getKey: issuer.getKey,
  tenantClaim: 'gg_tenant',
  lookup: async (_iss, clientId, hint) => {
    const binding = clients[clientId];
    return binding && binding.tenant === hint
      ? { tenant_id: hint, principal_id: '123e4567-e89b-42d3-a456-426614174000', scopes: ['inventory:import'] }
      : undefined;
  },
});
const api = await startApi({ importVerifier: verifier, importSourceId: source });
for (const {tenant} of Object.values(clients)) await createTenant(api.db, tenant, `mysql-cdc-live-${tenant.slice(0, 8)}`);
const oauth = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/token') { res.writeHead(404).end(); return; }
    const auth = req.headers.authorization || '';
    const decoded = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
    const separator = decoded.indexOf(':');
    if (separator <= 0) {
      res.writeHead(401, {'Content-Type':'application/json'}).end('{"error":"invalid_client"}'); return;
    }
    const clientId = decoded.slice(0, separator);
    const supplied = decoded.slice(separator + 1);
    const binding = clients[clientId];
    const expected = binding?.secret || '';
    if (!binding || !expected || supplied.length !== expected.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      res.writeHead(401, {'Content-Type':'application/json'}).end('{"error":"invalid_client"}'); return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    if (params.get('grant_type') !== 'client_credentials' || params.get('scope') !== 'inventory:import') {
      res.writeHead(400, {'Content-Type':'application/json'}).end('{"error":"invalid_scope"}'); return;
    }
    const token = await issuer.sign({ sub: `${clientId}@clients`, azp: clientId,
      gty: 'client-credentials', scope: 'inventory:import', gg_tenant: binding.tenant });
    res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({access_token:token,token_type:'Bearer',expires_in:300}));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise(resolve => oauth.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({ api_url: new URL('/v1/internal/inventory/imports', api.base).toString(),
  token_url: `http://127.0.0.1:${oauth.address().port}/token`,
  tenants: {'partner-a': clients['importer-a'].tenant, 'partner-b': clients['importer-b'].tenant} }));
async function close() { await api.close(); await new Promise(resolve => oauth.close(resolve)); }
for (const name of ['SIGTERM','SIGINT']) process.on(name, () => close().finally(() => process.exit()));
