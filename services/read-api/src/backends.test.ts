import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  postgresReads,
  CassandraHistory,
  ElasticSearch,
  type HistoryQuery,
} from "./backends.js";

const q: HistoryQuery = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  deviceId: "33333333-3333-4333-8333-333333333333",
  from: new Date("2026-09-22T23:00:00Z"),
  to: new Date("2026-09-24T01:00:00Z"),
  limit: 2,
};
test("Cassandra history fans out by UTC day with tenant partition, deadline and limit", async () => {
  const calls: Array<{ values: unknown[]; timeout: number }> = [];
  let closed = false;
  const fake = {
    execute: async (
      _sql: string,
      values: unknown[],
      options: { readTimeout: number },
    ) => {
      calls.push({ values, timeout: options.readTimeout });
      return {
        rows:
          calls.length === 1
            ? [
                {
                  get: (key: string) =>
                    ({
                      tenant_id: q.tenantId,
                      device_id: q.deviceId,
                      reading_id: "r1",
                      event_id: "e1",
                      stream_version: 1,
                      observed_at: q.to,
                      received_at: q.to,
                      temperature_c: 24,
                      relative_humidity_percent: 60,
                    })[key as "tenant_id"] ?? null,
                },
              ]
            : [],
      };
    },
    shutdown: async () => {
      closed = true;
    },
  };
  const history = new CassandraHistory(fake as never);
  const rows = (await history.list(q)) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, q.tenantId);
  assert.equal(rows[0].device_id, q.deviceId);
  assert.deepEqual(
    calls.map((call) => call.values[2]),
    ["2026-09-24", "2026-09-23", "2026-09-22"],
  );
  assert.ok(
    calls.every(
      (call) =>
        call.values[0] === q.tenantId &&
        call.timeout > 0 &&
        call.timeout <= 5_000,
    ),
  );
  assert.deepEqual(
    calls.map((call) => call.values[5]),
    [2, 1, 1],
  );
  await history.close();
  assert.equal(closed, true);
});
test("search enforces tenant in the query and filters mismatched backend hits", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requestBody = JSON.parse(raw) as Record<string, unknown>;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        hits: {
          hits: [
            { _source: { tenant_id: q.tenantId, name: "Bin A" } },
            { _source: { tenant_id: "foreign", name: "Bin B" } },
            { _source: null },
          ],
        },
      }),
    );
  }).listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const search = new ElasticSearch(
      `http://127.0.0.1:${port}/`,
      "inventory-alias",
    );
    assert.deepEqual(await search.search(q.tenantId, "Bin", 5), [
      { tenant_id: q.tenantId, name: "Bin A" },
    ]);
    assert.equal(requestBody?.size, 5);
    assert.deepEqual(
      (requestBody?.query as { bool: { filter: unknown[] } }).bool.filter,
      [{ term: { tenant_id: q.tenantId } }],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("search HTTPS requires credentials and a Node startup CA", () => {
  assert.throws(
    () => new ElasticSearch("https://search.example"),
    /requires username, password and CA file/,
  );
  assert.throws(
    () =>
      new ElasticSearch("http://search.example", "inventory", {
        username: "reader",
        password: "secret",
        caFile: "/ca.pem",
      }),
    /credentials require HTTPS/,
  );
  assert.throws(
    () =>
      new ElasticSearch("https://reader:secret@search.example", "inventory", {
        username: "reader",
        password: "secret",
        caFile: "/ca.pem",
      }),
    /invalid search URL/,
  );
  assert.throws(
    () =>
      new ElasticSearch("https://search.example", "inventory", {
        username: "reader",
        password: "secret",
        caFile: "/ca.pem",
      }),
    /NODE_EXTRA_CA_CERTS/,
  );
});

test("device current uses one tenant-filtered statement and preserves exact versions and canonical dates", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const current = await postgresReads({
    withTenant: async (
      tenant: string,
      read: (tx: unknown) => Promise<unknown>,
    ) => {
      assert.equal(tenant, q.tenantId);
      return read({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          return {
            rows: [
              {
                device: {
                  inventory_version: "9007199254740993",
                  updated_at: "2026-09-27T12:34:56.123456-05:00",
                },
                latest_reading: {
                  stream_version: "9007199254740995",
                  observed_at: "2026-09-27T12:34:56.123456-05:00",
                  received_at: "2026-09-27T12:34:56.123456-05:00",
                  projected_at: "2026-09-27T12:34:56.123456-05:00",
                  age_seconds: "12.345678",
                  temperature_c: 23.5,
                },
              },
            ],
          };
        },
      });
    },
  } as never).deviceCurrent(q.tenantId, q.deviceId);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [q.tenantId, q.deviceId]);
  assert.equal(
    (calls[0].sql.match(/tenant_id=\$1 AND device_id=\$2/g) ?? []).length,
    2,
  );
  assert.match(calls[0].sql, /inventory_version::text/);
  assert.match(calls[0].sql, /->>'stream_version'/);
  assert.match(calls[0].sql, /->>'age_seconds'/);
  assert.equal(current.device?.inventory_version, "9007199254740993");
  assert.equal(current.latestReading?.stream_version, "9007199254740995");
  assert.equal(current.device?.updated_at, "2026-09-27T17:34:56.123Z");
  assert.equal(current.latestReading?.observed_at, "2026-09-27T17:34:56.123Z");
  assert.equal(current.latestReading?.received_at, "2026-09-27T17:34:56.123Z");
  assert.equal(current.latestReading?.projected_at, "2026-09-27T17:34:56.123Z");
  assert.equal(current.latestReading?.age_seconds, "12.345678");
  assert.equal(current.latestReading?.temperature_c, 23.5);
});
