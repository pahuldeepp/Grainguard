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
