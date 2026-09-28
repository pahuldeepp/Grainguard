import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import {
  createApolloServer,
  observeResponseWatermark,
  type BffContext,
} from "./schema.js";
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

test("bin readings persisted roots map real metrics and trend coverage through the BFF", async () => {
  const paths: string[] = [];
  const read = new ReadClient("http://127.0.0.1:4001", async (input) => {
    const url = new URL(input.toString());
    paths.push(url.pathname);
    if (url.pathname.endsWith("/latest"))
      return Response.json({
        data: {
          bin: { bin_id: "b1", name: "North", site_name: "Farm" },
          devices: [],
          devicesTruncated: false,
          readings: [
            {
              device_id: "d1",
              metric: "co2_ppm",
              unit: "ppm",
              value: 700,
              observed_at: "now",
              reading_id: "r1",
            },
          ],
          layout: [],
          sensorReadings: [],
          policies: [],
          freshness: "not_configured",
        },
      });
    return Response.json({
      data: {
        bins: { bin_id: "b1", name: "North" },
        window: "H1",
        resolution: "AUTO",
        bucketSeconds: 60,
        from: "a",
        to: "b",
        buckets: [],
        source: "postgres",
      },
    });
  });
  const server = createApolloServer();
  const contextValue = {
    principal,
    authorization: "Bearer tenant-one",
    read,
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
  };
  const latest = await server.executeOperation(
    {
      query:
        'query { binReadingsLatest(binId:"b1") { bin { name } readings { metric value } freshness } }',
    },
    { contextValue },
  );
  const trend = await server.executeOperation(
    {
      query:
        'query { binReadingsTrend(binId:"b1",window:"H1") { window bucketSeconds source } }',
    },
    { contextValue },
  );
  for (const result of [latest, trend]) {
    assert.equal(result.body.kind, "single");
    if (result.body.kind === "single")
      assert.equal(result.body.singleResult.errors, undefined);
  }
  assert.deepEqual(paths, [
    "/api/v1/read/bins/b1/readings/latest",
    "/api/v1/read/bins/b1/readings/trend",
  ]);
  await server.stop();
});

test("GraphQL binds strict minima to principal and isolates aliases from device batching", async () => {
  const token = JSON.stringify({
    v: 1,
    tenantId: principal.tenantId,
    shardIncarnation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    placementEpoch: "1",
    sequence: "9",
  });
  const requests: { method?: string; minimum: string | null }[] = [];
  const read = new ReadClient("http://127.0.0.1:8093", async (_input, init) => {
    const minimum = new Headers(init?.headers).get(
      "x-greenguard-minimum-watermark",
    );
    requests.push({ method: init?.method, minimum });
    return Response.json(
      {
        data:
          init?.method === "POST" ? [{ device_id: "d" }] : { device_id: "d" },
      },
      { headers: { "x-greenguard-watermark": token } },
    );
  });
  const server = createApolloServer();
  const contextValue = {
    principal,
    authorization: "Bearer one",
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    read,
    deviceLoader: createDeviceLoader(read, "Bearer one", principal.tenantId),
  };
  try {
    const response = await server.executeOperation(
      {
        query:
          'query($minimum: String) { eventual: device(id:"d") { deviceId } strict: device(id:"d", minimumConsistency:$minimum) { consistencyToken } }',
        variables: { minimum: token },
      },
      { contextValue },
    );
    assert.equal(response.body.kind, "single");
    if (response.body.kind === "single") {
      assert.equal(response.body.singleResult.errors, undefined);
      assert.equal(
        (
          response.body.singleResult.data?.strict as {
            consistencyToken: string;
          }
        ).consistencyToken,
        token,
      );
    }
    assert.deepEqual(
      requests.sort((a, b) => String(a.method).localeCompare(String(b.method))),
      [
        { method: "GET", minimum: token },
        { method: "POST", minimum: null },
      ],
    );
    for (const minimum of [
      "malformed",
      token.replace(principal.tenantId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    ]) {
      const denied = await server.executeOperation(
        {
          query:
            'query($minimum:String) { device(id:"d", minimumConsistency:$minimum) { deviceId } }',
          variables: { minimum },
        },
        { contextValue },
      );
      if (denied.body.kind === "single")
        assert.equal(
          denied.body.singleResult.errors?.[0].extensions?.code,
          "invalid_consistency_token",
        );
    }
    assert.equal(requests.length, 2);
  } finally {
    await server.stop();
  }
});

test("GraphQL request certificate survives empty PG results and covers the oldest snapshot", async () => {
  const token = (
    sequence: string,
    incarnation = "22222222-2222-4222-8222-222222222222",
  ) =>
    JSON.stringify({
      v: 1,
      tenantId: principal.tenantId,
      shardIncarnation: incarnation,
      placementEpoch: "3",
      sequence,
    });
  const server = createApolloServer();
  const read = new ReadClient("http://127.0.0.1:8093", async (input) => {
    const path = new URL(String(input)).pathname;
    return Response.json(
      { data: path.endsWith("rollups") ? [] : null },
      {
        headers: {
          "x-greenguard-watermark": token(path.endsWith("rollups") ? "7" : "9"),
        },
      },
    );
  });
  const context: BffContext = {
    principal,
    authorization: "Bearer one",
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    read,
  };
  try {
    const response = await server.executeOperation(
      {
        query:
          '{ latestReading(deviceId:"d") { readingId } readingRollups(deviceId:"d", from:"a", to:"b", limit:1, bucket:"hour") { sampleCount } }',
      },
      { contextValue: context },
    );
    assert.equal(response.body.kind, "single");
    if (response.body.kind === "single") {
      assert.equal(response.body.singleResult.errors, undefined);
      assert.equal(
        response.body.singleResult.extensions?.consistencyToken,
        token("7"),
      );
      assert.equal(response.body.singleResult.data?.latestReading, null);
    }
    observeResponseWatermark(context, token("7"));
    assert.throws(
      () =>
        observeResponseWatermark(
          context,
          token("10", "33333333-3333-4333-8333-333333333333"),
        ),
      /consistency_identity_mismatch/,
    );
    const nextContext: BffContext = { ...context, consistencyToken: undefined };
    const nextResponse = await server.executeOperation(
      { query: "{ session { tenantId } }" },
      { contextValue: nextContext },
    );
    if (nextResponse.body.kind === "single")
      assert.equal(
        nextResponse.body.singleResult.extensions?.consistencyToken,
        undefined,
      );
  } finally {
    await server.stop();
  }
});

test("every persisted operation validates against the GraphQL schema", async () => {
  const { parse, validate, buildSchema } = await import("graphql");
  const { operations } = await import("./query-policy.js");
  const { typeDefs } = await import("./schema.js");
  const schema = buildSchema(typeDefs);
  for (const [name, query] of Object.entries(operations))
    assert.deepEqual(validate(schema, parse(query)), [], name);
});

test("persisted DeviceCurrent shares one aggregate HTTP request per authenticated operation", async () => {
  const { operations } = await import("./query-policy.js");
  const calls: Array<{
    path: string;
    authorization: string | null;
    minimum: string | null;
    budget: string | null;
  }> = [];
  const actual = JSON.stringify({
    v: 1,
    tenantId: principal.tenantId,
    shardIncarnation: "22222222-2222-4222-8222-222222222222",
    placementEpoch: "2",
    sequence: "90",
  });
  const read = new ReadClient("http://127.0.0.1:8093", async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      path: new URL(String(input)).pathname,
      authorization: headers.get("authorization"),
      minimum: headers.get("x-greenguard-minimum-watermark"),
      budget: headers.get("x-greenguard-read-budget-ms"),
    });
    return Response.json(
      {
        data: {
          device: { device_id: "d", site_id: "s", serial_number: "sensor" },
          latestReading: {
            device_id: "d",
            reading_id: "r",
            observed_at: "now",
            received_at: "now",
            stream_version: "9007199254740993",
          },
        },
      },
      { headers: { "x-greenguard-watermark": actual } },
    );
  });
  const server = createApolloServer();
  try {
    for (const minimum of [undefined, actual]) {
      const response = await server.executeOperation(
        {
          query: operations.deviceCurrent,
          variables: { id: "d", minimumConsistency: minimum },
        },
        {
          contextValue: {
            principal,
            authorization: "Bearer one",
            read,
            provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
            readDeadline: Date.now() + 4000,
          },
        },
      );
      assert.equal(response.body.kind, "single");
      if (response.body.kind === "single") {
        assert.equal(response.body.singleResult.errors, undefined);
        assert.equal(
          response.body.singleResult.data?.device &&
            (response.body.singleResult.data.device as { deviceId: string })
              .deviceId,
          "d",
        );
        assert.equal(
          (
            response.body.singleResult.data?.latestReading as {
              streamVersion: string;
            }
          ).streamVersion,
          "9007199254740993",
        );
        assert.equal(
          response.body.singleResult.extensions?.consistencyToken,
          actual,
        );
      }
    }
    assert.equal(
      calls.length,
      2,
      "each operation makes one HTTP call, with no cross-request promise reuse",
    );
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/api/v1/read/devices/d/current", "/api/v1/read/devices/d/current"],
    );
    assert.deepEqual(
      calls.map((c) => c.minimum),
      [null, actual],
    );
    assert.ok(
      calls.every(
        (c) =>
          c.authorization === "Bearer one" &&
          Number(c.budget) > 0 &&
          Number(c.budget) <= 4000,
      ),
    );
  } finally {
    await server.stop();
  }
});
