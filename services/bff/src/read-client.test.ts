import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadClient, ReadUpstreamError } from "./read-client.js";

test("ReadClient forwards bearer and maps each owning store's records", async () => {
  const paths: string[] = [];
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async (input, init) => {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer tenant-one",
      );
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      if (path.endsWith("/latest"))
        return Response.json({
          data: {
            reading_id: "r1",
            device_id: "d1",
            observed_at: "2026-09-24T00:00:00Z",
            received_at: "2026-09-24T00:00:01Z",
            temperature_c: 23,
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
            { resource_type: "site", resource_id: "s1" },
          ],
          source: "elasticsearch",
        });
      return Response.json({
        data: { device_id: "d1", site_id: "s1", serial_number: "sensor-1" },
      });
    },
  );
  assert.equal(
    (await client.device("Bearer tenant-one", "d1"))?.deviceId,
    "d1",
  );
  assert.equal(
    (await client.latest("Bearer tenant-one", "d1"))?.temperatureC,
    23,
  );
  assert.equal(
    (
      await client.history("Bearer tenant-one", {
        deviceId: "d1",
        from: "2026-08-01T00:00:00Z",
        to: "2026-09-01T00:00:00Z",
        limit: 10,
      })
    ).length,
    1,
  );
  assert.deepEqual(
    (await client.search("Bearer tenant-one", "North", 10)).map(
      (hit) => hit?.deviceId,
    ),
    ["d1"],
  );
  assert.deepEqual(paths, [
    "/api/v1/read/devices/d1",
    "/api/v1/read/devices/d1/latest",
    "/api/v1/read/devices/d1/readings",
    "/api/v1/read/search",
  ]);
});

test("ReadClient preserves opaque upstream errors and rejects unsafe URL", async () => {
  assert.throws(() => new ReadClient("http://example.com"), /HTTPS/);
  const client = new ReadClient("http://127.0.0.1:8093", async () =>
    Response.json({ code: "read_unavailable" }, { status: 503 }),
  );
  await assert.rejects(
    client.device("Bearer token", "d1"),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "read_unavailable",
  );
});

test("ReadClient rejects dot-segment IDs before URL normalization", async () => {
  let calls = 0;
  const client = new ReadClient("http://127.0.0.1:8093", async () => {
    calls++;
    return Response.json({ data: null });
  });
  for (const id of [".", ".."]) {
    await assert.rejects(
      client.device("Bearer token", id),
      (error: unknown) =>
        error instanceof ReadUpstreamError &&
        error.code === "invalid_resource_id",
    );
    await assert.rejects(
      client.latest("Bearer token", id),
      (error: unknown) =>
        error instanceof ReadUpstreamError &&
        error.code === "invalid_resource_id",
    );
  }
  assert.equal(calls, 0);
});

test("reading versions preserve large wire strings and reject ambiguous objects", async () => {
  const exact = new ReadClient("http://127.0.0.1:8093", async () =>
    Response.json({
      data: {
        reading_id: "r1",
        device_id: "d1",
        stream_version: "9007199254740993",
      },
    }),
  );
  assert.equal(
    (await exact.reading("Bearer token", "r1"))?.streamVersion,
    "9007199254740993",
  );
  const ambiguous = new ReadClient("http://127.0.0.1:8093", async () =>
    Response.json({
      data: { reading_id: "r1", device_id: "d1", stream_version: {} },
    }),
  );
  await assert.rejects(
    ambiguous.reading("Bearer token", "r1"),
    (error: unknown) =>
      error instanceof ReadUpstreamError &&
      error.code === "invalid_stream_version",
  );
});

test("site cursor and rollup queries preserve owner routing and bearer", async () => {
  const requests: URL[] = [];
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async (input, init) => {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer t1",
      );
      const url = new URL(input.toString());
      requests.push(url);
      if (url.pathname.endsWith("/devices")) {
        return Response.json({
          data: [{ device_id: "device-b", site_id: "site-a" }],
          nextCursor: "device-b",
        });
      }
      return Response.json({
        data: [
          {
            bucket_start: "2026-09-24T00:00:00Z",
            sample_count: 2,
            avg_temperature_c: 21,
          },
        ],
        source: "postgres",
      });
    },
  );
  const site = await client.siteDevices("Bearer t1", "site-a", 1, "device-a");
  assert.deepEqual(
    site.items.map((row) => row?.deviceId),
    ["device-b"],
  );
  assert.equal(site.nextCursor, "device-b");
  const rollups = await client.rollups("Bearer t1", {
    deviceId: "device-b",
    from: "2026-09-24T00:00:00Z",
    to: "2026-09-25T00:00:00Z",
    limit: 10,
    bucket: "hour",
  });
  assert.equal(rollups[0].sampleCount, 2);
  assert.equal(requests[0].pathname, "/api/v1/read/sites/site-a/devices");
  assert.equal(requests[0].searchParams.get("after"), "device-a");
  assert.equal(requests[1].pathname, "/api/v1/read/devices/device-b/rollups");
  assert.equal(requests[1].searchParams.get("bucket"), "hour");
});

test("bin latest and trend preserve sensor, policy, freshness and range metadata", async () => {
  const urls: URL[] = [];
  const client = new ReadClient("http://127.0.0.1:8093", async (input) => {
    const url = new URL(input.toString());
    urls.push(url);
    if (url.pathname.endsWith("/latest"))
      return Response.json({
        data: {
          bin: {
            bin_id: "b1",
            site_id: "s1",
            name: "North",
            site_name: "Farm",
            projected_at: "now",
          },
          devices: [],
          devicesTruncated: false,
          readings: [
            {
              device_id: "d1",
              metric: "co2_ppm",
              unit: "ppm",
              value: 720,
              observed_at: "then",
              age_seconds: 3,
            },
          ],
          layout: [
            { sensor_id: "s2", position: 2, depth_m: 1.5, label: "Lower" },
          ],
          sensorReadings: [],
          policies: [
            {
              policy_id: "p1",
              policy_version: "9007199254740995",
              grain_type: "wheat",
              calibrated: false,
              measurement_thresholds: {},
              risk_thresholds: {},
              provenance: {},
            },
          ],
          freshness: "not_configured",
        },
      });
    return Response.json({
      data: {
        bins: { bin_id: "b1", name: "North" },
        window: "H6",
        resolution: "AUTO",
        bucketSeconds: 300,
        from: "a",
        to: "b",
        buckets: [{ metric: "co2_ppm", average_value: 700, sample_count: 3 }],
        source: "postgres",
      },
    });
  });
  const latest = await client.binReadingsLatest("Bearer one", "b1");
  assert.equal(latest?.readings[0]?.value, 720);
  assert.equal(latest?.layout[0]?.depthM, 1.5);
  assert.equal(latest?.policies[0]?.policyVersion, "9007199254740995");
  assert.equal(latest?.freshness, "not_configured");
  const trend = await client.binReadingsTrend("Bearer one", "b1", "H6");
  assert.equal(trend.bucketSeconds, 300);
  assert.equal(trend.buckets[0]?.averageValue, 700);
  assert.equal(urls[1]?.searchParams.get("resolution"), "AUTO");
});

test("safe GET retries transient failures at most three times", async () => {
  let calls = 0;
  let cancelled = 0;
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async (_url, init) => {
      assert.equal(init?.method, "GET");
      calls++;
      return calls < 3
        ? new Response(
            new ReadableStream({
              cancel: () => {
                cancelled++;
              },
            }),
            { status: 503 },
          )
        : Response.json({ data: { device_id: "d1" } });
    },
    { backoffMs: 1 },
  );
  assert.equal((await client.device("Bearer t1", "d1"))?.deviceId, "d1");
  assert.equal(calls, 3);
  assert.equal(cancelled, 2, "discarded transient bodies must be cancelled");
});

test("safe GET does not retry an owner authorization failure", async () => {
  let calls = 0;
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async () => {
      calls++;
      return Response.json({ code: "tenant_denied" }, { status: 403 });
    },
    { backoffMs: 1 },
  );
  await assert.rejects(
    client.device("Bearer t1", "d1"),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "tenant_denied",
  );
  assert.equal(calls, 1);
});

test("read timeout obeys one overall deadline and never retries POST batches", async () => {
  let getCalls = 0;
  let postCalls = 0;
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async (_url, init) => {
      if (init?.method === "POST") postCalls++;
      else getCalls++;
      return new Promise<Response>(() => undefined);
    },
    { overallTimeoutMs: 30, perAttemptTimeoutMs: 100, backoffMs: 1 },
  );
  const started = performance.now();
  await assert.rejects(
    client.device("Bearer t1", "d1"),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "read_timeout",
  );
  assert.ok(
    performance.now() - started < 500,
    "the overall deadline must bound a stalled fetch",
  );
  assert.equal(getCalls, 1);
  await assert.rejects(
    client.devices("Bearer t1", ["d1"]),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "read_timeout",
  );
  assert.equal(
    postCalls,
    1,
    "POST must not be retried after an ambiguous timeout",
  );
});

test("a prompt header with a stalled body uses the per-attempt deadline", async () => {
  let calls = 0;
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async (_url, init) => {
      calls++;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      init?.signal?.addEventListener(
        "abort",
        () => controller.error(new Error("aborted")),
        { once: true },
      );
      return new Response(stream, { status: 200 });
    },
    { overallTimeoutMs: 200, perAttemptTimeoutMs: 10, backoffMs: 1 },
  );
  const started = performance.now();
  await assert.rejects(
    client.device("Bearer t1", "d1"),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "read_timeout",
  );
  assert.equal(calls, 3);
  assert.ok(
    performance.now() - started < 150,
    "body parsing must share each attempt's 10 ms cap",
  );
});

test("breaker rejects without upstream calls then recovers after a successful probe", async () => {
  let now = 1_000;
  let calls = 0;
  let healthy = false;
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async () => {
      calls++;
      return healthy
        ? Response.json({ data: { device_id: "d1" } })
        : Response.json({ code: "read_busy" }, { status: 503 });
    },
    { backoffMs: 1, failureThreshold: 2, cooldownMs: 100, now: () => now },
  );
  for (let failure = 0; failure < 2; failure++) {
    await assert.rejects(
      client.device("Bearer t1", "d1"),
      (error: unknown) =>
        error instanceof ReadUpstreamError && error.code === "read_busy",
    );
  }
  assert.equal(calls, 6, "each failed GET has exactly three attempts");
  await assert.rejects(
    client.device("Bearer t1", "d1"),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "read_circuit_open",
  );
  assert.equal(calls, 6, "open breaker must not contact upstream");
  now += 100;
  healthy = true;
  assert.equal((await client.device("Bearer t1", "d1"))?.deviceId, "d1");
  assert.equal(calls, 7, "cooldown permits one recovery probe");
  assert.equal((await client.device("Bearer t1", "d1"))?.deviceId, "d1");
  assert.equal(calls, 8, "success closes the breaker");
});

test("a failed recovery probe reopens the breaker for another cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async () => {
      calls++;
      return Response.json({ code: "read_busy" }, { status: 503 });
    },
    { backoffMs: 1, failureThreshold: 1, cooldownMs: 100, now: () => now },
  );
  await assert.rejects(client.device("Bearer t1", "d1"));
  assert.equal(calls, 3);
  now += 100;
  await assert.rejects(client.device("Bearer t1", "d1"));
  assert.equal(calls, 4, "half-open probe uses one attempt");
  await assert.rejects(
    client.device("Bearer t1", "d1"),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "read_circuit_open",
  );
  assert.equal(calls, 4);
});

test("a pre-trip success cannot close an open breaker or clear its recovery probe", async () => {
  let now = 1_000;
  let calls = 0;
  let finishSlow!: (response: Response) => void;
  let finishProbe!: (response: Response) => void;
  const slow = new Promise<Response>((resolve) => {
    finishSlow = resolve;
  });
  const probe = new Promise<Response>((resolve) => {
    finishProbe = resolve;
  });
  const client = new ReadClient(
    "http://127.0.0.1:8093",
    async (url) => {
      calls++;
      const path = new URL(url.toString()).pathname;
      if (path.endsWith("/slow")) return slow;
      if (path.endsWith("/probe")) return probe;
      if (path.endsWith("/fail"))
        return Response.json({ code: "read_busy" }, { status: 503 });
      return Response.json({ data: { device_id: "after" } });
    },
    { backoffMs: 1, failureThreshold: 1, cooldownMs: 100, now: () => now },
  );
  const slowCall = client.device("Bearer t1", "slow");
  await assert.rejects(client.device("Bearer t1", "fail"));
  assert.equal(calls, 4);
  now += 100;
  const probeCall = client.device("Bearer t1", "probe");
  finishSlow(Response.json({ data: { device_id: "slow" } }));
  assert.equal((await slowCall)?.deviceId, "slow");
  await assert.rejects(
    client.device("Bearer t1", "blocked"),
    (error: unknown) =>
      error instanceof ReadUpstreamError && error.code === "read_circuit_open",
  );
  assert.equal(calls, 5, "the stale success must not admit a second probe");
  finishProbe(Response.json({ data: { device_id: "probe" } }));
  assert.equal((await probeCall)?.deviceId, "probe");
  assert.equal((await client.device("Bearer t1", "after"))?.deviceId, "after");
  assert.equal(calls, 6);
});
