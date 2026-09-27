import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import { createApolloServer } from "./schema.js";
import { ProvisioningClient } from "./provisioning.js";
import { ReadClient } from "./read-client.js";
import { createDeviceLoader } from "./device-loader.js";

test("GraphQL aliases use one request batch and reading(id) preserves projection freshness", async () => {
  const calls: string[] = [];
  const read = new ReadClient("http://127.0.0.1:8093", async (input, init) => {
    const path = new URL(input.toString()).pathname;
    calls.push(path);
    if (path.endsWith("/batch")) {
      const ids = (JSON.parse(String(init?.body)) as { deviceIds: string[] })
        .deviceIds;
      return Response.json({
        data: ids.map((device_id) => ({ device_id, serial_number: device_id })),
      });
    }
    return Response.json({
      data: {
        reading_id: "r1",
        device_id: "d1",
        event_id: "e1",
        observed_at: "2026-09-24T00:00:00Z",
        received_at: "2026-09-24T00:00:01Z",
        projected_at: "2026-09-24T00:00:02Z",
        stream_version: "9007199254740993",
      },
    });
  });
  const server = createApolloServer();
  const response = await server.executeOperation(
    {
      query:
        '{ a: device(id:"d1") { deviceId } b: device(id:"d2") { deviceId } c: device(id:"d1") { deviceId } reading(id:"r1") { readingId eventId projectedAt streamVersion } }',
    },
    {
      contextValue: {
        principal,
        authorization: "Bearer tenant-one",
        provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
        read,
        deviceLoader: createDeviceLoader(read, "Bearer tenant-one"),
      },
    },
  );
  assert.equal(response.body.kind, "single");
  if (response.body.kind === "single") {
    assert.equal(response.body.singleResult.errors, undefined);
    assert.deepEqual(
      JSON.parse(JSON.stringify(response.body.singleResult.data)),
      {
        a: { deviceId: "d1" },
        b: { deviceId: "d2" },
        c: { deviceId: "d1" },
        reading: {
          readingId: "r1",
          eventId: "e1",
          projectedAt: "2026-09-24T00:00:02Z",
          streamVersion: "9007199254740993",
        },
      },
    );
  }
  assert.deepEqual(calls.sort(), [
    "/api/v1/read/devices/batch",
    "/api/v1/read/readings/r1",
  ]);
  await server.stop();
});

const principal: Principal = {
  subject: "u1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  roles: ["operator"],
  expiresAt: new Date(Date.now() + 60_000),
};

test("GraphQL rejects oversized history and search before the Read API", async () => {
  let upstreamCalls = 0;
  const server = createApolloServer();
  const contextValue = {
    principal,
    authorization: "Bearer token",
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    read: new ReadClient("http://127.0.0.1:4001", async () => {
      upstreamCalls++;
      return Response.json({ data: [] });
    }),
  };
  for (const [query, variables] of [
    [
      'query($limit: Int!) { readingHistory(deviceId: "d1", from: "2026-09-01", to: "2026-09-02", limit: $limit) { readingId } }',
      { limit: 501 },
    ],
    [
      'query($limit: Int!) { searchDevices(query: "bin", limit: $limit) { deviceId } }',
      { limit: 0 },
    ],
  ] as const) {
    const result = await server.executeOperation(
      { query, variables },
      { contextValue },
    );
    assert.equal(result.body.kind, "single");
    if (result.body.kind === "single")
      assert.equal(
        result.body.singleResult.errors?.[0].extensions?.code,
        "BAD_USER_INPUT",
      );
  }
  assert.equal(upstreamCalls, 0);
  await server.stop();
});

test("GraphQL status maps saga and history from the owning API", async () => {
  const client = new ProvisioningClient("http://127.0.0.1:8092", async () =>
    Response.json({
      saga: {
        TenantID: principal.tenantId,
        SagaID: "s1",
        DeviceID: "d1",
        AssetID: "a1",
        State: "reserving",
        Version: 1,
        FencingToken: 1,
        DeadlineAt: "2026-09-25T00:00:00Z",
      },
      history: [
        { version: 1, action: "started", recorded_at: "2026-09-24T00:00:00Z" },
      ],
    }),
  );
  const server = createApolloServer();
  const response = await server.executeOperation(
    {
      query:
        "query($id: ID!) { provisioningStatus(id: $id) { saga { sagaId state tenantId } history { action } } }",
      variables: { id: "s1" },
    },
    {
      contextValue: {
        principal,
        authorization: "Bearer token",
        provisioning: client,
      },
    },
  );
  assert.deepEqual(response.body.kind, "single");
  if (response.body.kind === "single") {
    assert.equal(response.body.singleResult.errors, undefined);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(response.body.singleResult.data?.provisioningStatus),
      ),
      {
        saga: {
          sagaId: "s1",
          state: "reserving",
          tenantId: principal.tenantId,
        },
        history: [{ action: "started" }],
      },
    );
  }
  await server.stop();
});

test("GraphQL does not turn a foreign-tenant saga into data", async () => {
  const client = new ProvisioningClient("http://127.0.0.1:8092", async () =>
    Response.json({ code: "not_found" }, { status: 404 }),
  );
  const server = createApolloServer();
  const response = await server.executeOperation(
    { query: '{ provisioningStatus(id: "foreign") { saga { sagaId } } }' },
    {
      contextValue: {
        principal,
        authorization: "Bearer tenant-one",
        provisioning: client,
      },
    },
  );
  if (response.body.kind === "single") {
    assert.equal(response.body.singleResult.data, null);
    assert.equal(
      response.body.singleResult.errors?.[0].extensions?.code,
      "not_found",
    );
  }
  await server.stop();
});

test("GraphQL mutations call the owning command API", async () => {
  const paths: string[] = [];
  const client = new ProvisioningClient(
    "http://127.0.0.1:8092",
    async (url) => {
      paths.push((url as URL).pathname);
      return Response.json(
        {
          TenantID: principal.tenantId,
          SagaID: "s1",
          DeviceID: "d1",
          AssetID: "a1",
          State: "reserving",
          Version: 1,
          FencingToken: 1,
          DeadlineAt: "2026-09-25T00:00:00Z",
        },
        { status: 202 },
      );
    },
  );
  const server = createApolloServer();
  const contextValue = {
    principal: { ...principal, roles: ["admin"] as Principal["roles"] },
    authorization: "Bearer token",
    provisioning: client,
  };
  const start = await server.executeOperation(
    {
      query:
        'mutation { startProvisioning(deviceId: "d1", assetId: "a1", idempotencyKey: "key") { sagaId } }',
    },
    { contextValue },
  );
  const redrive = await server.executeOperation(
    {
      query:
        'mutation { redriveProvisioning(id: "s1", reason: "repair") { sagaId } }',
    },
    { contextValue },
  );
  assert.equal(
    start.body.kind === "single" &&
      (start.body.singleResult.data?.startProvisioning as { sagaId: string })
        ?.sagaId,
    "s1",
  );
  assert.equal(
    redrive.body.kind === "single" &&
      (
        redrive.body.singleResult.data?.redriveProvisioning as {
          sagaId: string;
        }
      )?.sagaId,
    "s1",
  );
  assert.deepEqual(paths, ["/v1/provisioning", "/v1/provisioning/s1/redrive"]);
  await server.stop();
});

test("GraphQL composes current PostgreSQL, Cassandra history, and Elasticsearch search through Read API", async () => {
  const paths: string[] = [];
  const read = new ReadClient("http://127.0.0.1:4001", async (url, init) => {
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer tenant-one",
    );
    const path = new URL(url.toString()).pathname;
    paths.push(path);
    if (path.endsWith("/latest"))
      return Response.json({
        data: {
          reading_id: "r1",
          device_id: "d1",
          observed_at: "2026-09-24T00:00:00Z",
          received_at: "2026-09-24T00:00:01Z",
          temperature_c: 24,
        },
      });
    if (path.endsWith("/readings"))
      return Response.json({
        data: [
          {
            reading_id: "r2",
            device_id: "d1",
            observed_at: "2026-08-24T00:00:00Z",
            received_at: "2026-08-24T00:00:01Z",
          },
        ],
        source: "cassandra",
      });
    if (path.endsWith("/search"))
      return Response.json({
        data: [
          {
            resource_type: "device",
            resource_id: "d1",
            site_id: "s1",
            name: "North sensor",
          },
        ],
        source: "elasticsearch",
      });
    return Response.json({
      data: { device_id: "d1", site_id: "s1", serial_number: "North sensor" },
    });
  });
  const server = createApolloServer();
  const contextValue = {
    principal,
    authorization: "Bearer tenant-one",
    read,
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
  };
  const current = await server.executeOperation(
    {
      query:
        'query { device(id:"d1") { deviceId name } latestReading(deviceId:"d1") { temperatureC } }',
    },
    { contextValue },
  );
  const history = await server.executeOperation(
    {
      query:
        'query { readingHistory(deviceId:"d1",from:"2026-08-01T00:00:00Z",to:"2026-09-01T00:00:00Z",limit:10) { readingId } }',
    },
    { contextValue },
  );
  const search = await server.executeOperation(
    {
      query:
        'query { searchDevices(query:"North",limit:10) { deviceId name } }',
    },
    { contextValue },
  );
  for (const response of [current, history, search]) {
    assert.equal(response.body.kind, "single");
    if (response.body.kind === "single")
      assert.equal(response.body.singleResult.errors, undefined);
  }
  assert.deepEqual(paths, [
    "/api/v1/read/devices/d1",
    "/api/v1/read/devices/d1/latest",
    "/api/v1/read/devices/d1/readings",
    "/api/v1/read/search",
  ]);
  await server.stop();
});

test("session returns only the verified principal", async () => {
  const server = createApolloServer();
  const response = await server.executeOperation(
    { query: "query Session { session { subject tenantId roles } }" },
    {
      contextValue: {
        principal,
        authorization: "Bearer token",
        provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
      },
    },
  );
  assert.equal(response.body.kind, "single");
  if (response.body.kind === "single")
    assert.deepEqual(
      JSON.parse(JSON.stringify(response.body.singleResult.data?.session)),
      {
        subject: principal.subject,
        tenantId: principal.tenantId,
        roles: ["operator"],
      },
    );
});
