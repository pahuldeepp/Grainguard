import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTestIssuer } from "../packages/tenant-auth/dist/testing/issuer.js";
import {
  createMachineControlPlaneVerifier,
  machineAwareVerifier,
} from "../packages/tenant-auth/dist/machine-control-plane.js";
import { createDb } from "../services/tenant-control-plane/dist/db/client.js";
import { createControlPlaneApp } from "../services/tenant-control-plane/dist/app.js";
import { createApp as createReadApp } from "../services/read-api/dist/app.js";
import { createApp as createBffApp } from "../services/bff/dist/main.js";
import { ReadClient } from "../services/bff/dist/read-client.js";
import { ProvisioningClient } from "../services/bff/dist/provisioning.js";
import {
  operationHash,
  operations,
} from "../services/bff/dist/query-policy.js";
import { createGateway } from "../services/gateway/dist/server.js";

if (!process.env.CONTROL_DATABASE_URL)
  throw new Error("CONTROL_DATABASE_URL is required");
const issuer = await createTestIssuer();
const lookupToken = randomUUID();
const db = createDb(process.env.CONTROL_DATABASE_URL, 5);
const control = await createControlPlaneApp({
  db,
  lookupToken,
  apiKeyPepper: "stage09b live e2e pepper with at least 32 bytes",
  auth: {
    issuer: issuer.issuer,
    audience: issuer.audience,
    keys: { getKey: issuer.getKey },
  },
  m2m: {
    issuer: issuer.issuer,
    audience: issuer.audience,
    getKey: issuer.getKey,
  },
});
let readServer, bffServer, bffApollo, gateway;
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("missing listener"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
const close = (server) =>
  new Promise((resolve) => server.close(() => resolve()));
try {
  await control.listen(0, "127.0.0.1");
  const controlURL = await control.getUrl();
  const machine = createMachineControlPlaneVerifier({
    endpoint: controlURL,
    lookupToken,
  });
  const verify = machineAwareVerifier(
    async () => {
      throw new Error("human verifier not used in this test");
    },
    machine,
    "read:telemetry",
  );
  const backends = {
    device: async (tenant) => ({
      device_id: deviceId,
      name: `tenant:${tenant}`,
    }),
    devices: async (tenant, ids) =>
      ids.map((device_id) => ({ device_id, name: `tenant:${tenant}` })),
    reading: async () => null,
    devicesBySite: async () => [],
    latest: async () => null,
    hotReadings: async () => [],
    rollup: async () => [],
    history: { list: async () => [] },
    search: { search: async () => [] },
  };
  const deviceId = randomUUID();
  readServer = createReadApp({ verify, backends }).listen(0, "127.0.0.1");
  await new Promise((resolve) => readServer.once("listening", resolve));
  const readAddress = readServer.address();
  if (!readAddress || typeof readAddress === "string")
    throw new Error("read listener missing");
  const readURL = `http://127.0.0.1:${readAddress.port}`;
  const bff = await createBffApp({
    verify,
    provisioning: new ProvisioningClient("http://127.0.0.1:1"),
    read: new ReadClient(readURL),
  });
  bffApollo = bff.server;
  bffServer = bff.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => bffServer.once("listening", resolve));
  const bffAddress = bffServer.address();
  if (!bffAddress || typeof bffAddress === "string")
    throw new Error("BFF listener missing");
  const bffURL = `http://127.0.0.1:${bffAddress.port}`;
  gateway = createGateway({
    verify,
    bff: new URL(bffURL),
    read: new URL(readURL),
    saga: new URL("http://127.0.0.1:1"),
  });
  const gatewayURL = await listen(gateway);
  const actor = await issuer.sign({ sub: `stage09b-machine-${randomUUID()}` });
  async function admin(path, body) {
    const response = await fetch(new URL(path, controlURL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${actor}`,
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, `control-plane status ${response.status}`);
    return result;
  }
  const a = (await admin("/v1/organizations", { name: "Stage09b E2E A" }))
    .tenantId;
  const b = (await admin("/v1/organizations", { name: "Stage09b E2E B" }))
    .tenantId;
  const apiKey = await admin(`/v1/organizations/${a}/credentials/api-keys`, {
    name: "read key",
    kind: "usr",
    scopes: ["read:telemetry"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const clientId = `stage09b-${randomUUID()}`;
  const oauth = await admin(
    `/v1/organizations/${b}/credentials/oauth-clients`,
    {
      name: "read client",
      issuer: issuer.issuer,
      clientId,
      scopes: ["read:telemetry"],
    },
  );
  const m2m = await issuer.sign({
    sub: `${clientId}@clients`,
    azp: clientId,
    gty: "client-credentials",
    scope: "read:telemetry",
    tenant_id: a,
    gg_tenant: b,
  });
  async function graphql(authorization, expectedTenant) {
    const response = await fetch(`${gatewayURL}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
        "x-tenant-id": expectedTenant === a ? b : a,
      },
      body: JSON.stringify({
        extensions: {
          persistedQuery: {
            sha256Hash: operationHash(operations.deviceCurrent),
          },
        },
        variables: { id: deviceId },
      }),
    });
    return { status: response.status, body: await response.json() };
  }
  for (const [credential, tenant] of [
    [apiKey.key, a],
    [m2m, b],
  ]) {
    const result = await graphql(`Bearer ${credential}`, tenant);
    assert.equal(result.status, 200);
    assert.equal(result.body.data?.device?.name, `tenant:${tenant}`);
    assert.equal(result.body.errors, undefined);
    const direct = await fetch(
      `${gatewayURL}/api/v1/read/devices/${deviceId}`,
      {
        headers: {
          authorization: `Bearer ${credential}`,
          "x-tenant-id": tenant === a ? b : a,
        },
      },
    );
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).data.name, `tenant:${tenant}`);
    const saga = await fetch(`${gatewayURL}/v1/provisioning`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    assert.equal(saga.status, 403);
  }
  const lookupMs = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await machine.verify(`Bearer ${apiKey.key}`, "read:telemetry");
    lookupMs.push(performance.now() - start);
  }
  lookupMs.sort((left, right) => left - right);
  const lookupP95 = lookupMs[94];
  const missingScope = await admin(
    `/v1/organizations/${a}/credentials/api-keys`,
    {
      name: "write key",
      kind: "usr",
      scopes: ["write:devices"],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  );
  assert.equal((await graphql(`Bearer ${missingScope.key}`, a)).status, 403);
  await admin(
    `/v1/organizations/${a}/credentials/${apiKey.principalId}/revoke`,
    {},
  );
  assert.equal((await graphql(`Bearer ${apiKey.key}`, a)).status, 401);
  await admin(
    `/v1/organizations/${b}/credentials/${oauth.principalId}/revoke`,
    {},
  );
  assert.equal((await graphql(`Bearer ${m2m}`, b)).status, 401);
  console.log(
    `Stage09b machine E2E: API key and OAuth JWT, two tenants, spoof denial, scope denial, revocation: PASS; local owner lookup p95=${lookupP95.toFixed(2)}ms (100 sequential requests)`,
  );
} finally {
  if (gateway) await close(gateway);
  if (bffServer) await close(bffServer);
  if (bffApollo) await bffApollo.stop();
  if (readServer) await close(readServer);
  await control.close();
}
