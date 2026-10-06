import assert from "node:assert/strict";
import { test } from "node:test";
import { historyRollups, RollupScanLimit } from "./history-rollup.js";
import type { HistoryQuery, ReadBackends } from "./backends.js";
const tenantId = "11111111-1111-4111-8111-111111111111";
const deviceId = "33333333-3333-4333-8333-333333333333";
const from = new Date("2026-09-22T00:00:00Z"),
  to = new Date("2026-09-24T00:00:00Z"),
  seam = new Date("2026-09-23T12:05:00Z");
const query: HistoryQuery = { tenantId, deviceId, from, to, limit: 100 };
const row = (
  id: string,
  time: string,
  temperature: number | null,
  humidity: number | null = 50,
) => ({
  tenant_id: tenantId,
  device_id: deviceId,
  reading_id: id,
  observed_at: new Date(time),
  temperature_c: temperature,
  relative_humidity_percent: humidity,
});
const backend = (cold: unknown[], hot: unknown[]) =>
  ({
    history: { list: async () => cold },
    hotReadings: async () => hot,
  }) as unknown as Pick<ReadBackends, "history" | "hotReadings">;
test("cold and hybrid rollups aggregate actual samples, deduplicate and use UTC buckets", async () => {
  const data = await historyRollups(
    backend(
      [
        row("1", "2026-09-23T12:00:00Z", 10, 40),
        row("2", "2026-09-23T12:01:00Z", null, 60),
        row("duplicate", "2026-09-23T12:06:00Z", 99, 99),
      ],
      [
        row("duplicate", "2026-09-23T12:06:00Z", 30, null),
        row("3", "2026-09-23T13:00:00Z", 40, 70),
      ],
    ),
    query,
    "hour",
    seam,
  );
  assert.deepEqual(data, [
    {
      bucket_start: new Date("2026-09-23T13:00:00Z"),
      sample_count: 1,
      avg_temperature_c: 40,
      avg_relative_humidity_percent: 70,
    },
    {
      bucket_start: new Date("2026-09-23T12:00:00Z"),
      sample_count: 3,
      avg_temperature_c: 20,
      avg_relative_humidity_percent: 50,
    },
  ]);
  const cold = await historyRollups(
    backend([row("4", "2026-09-22T01:00:00Z", 12)], []),
    { ...query, to: new Date("2026-09-23T00:00:00Z") },
    "day",
    seam,
  );
  assert.equal(cold[0]!.avg_temperature_c, 12);
});
test("complete keyset scan includes more than one page before limiting returned buckets", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) =>
    row(String(i).padStart(4, "0"), "2026-09-22T01:00:00Z", i),
  );
  let pages = 0;
  const backends = backend([], []);
  backends.history.list = async (q) => {
    pages++;
    assert.equal(q.tenantId, tenantId);
    assert.equal(q.deviceId, deviceId);
    assert.ok(q.to <= seam);
    return rows
      .filter((r) => !q.after || r.reading_id > q.after.readingId)
      .slice(0, q.limit);
  };
  const result = await historyRollups(
    backends,
    { ...query, limit: 1 },
    "hour",
    seam,
  );
  assert.equal(pages, 3);
  assert.equal(result[0]!.sample_count, 1001);
  assert.equal(result[0]!.avg_temperature_c, 500);
});
test("hybrid rollup never returns partial averages on a source failure or foreign row", async () => {
  const backends = backend([row("1", "2026-09-22T01:00:00Z", 10)], []);
  backends.hotReadings = async () => {
    throw new Error("postgres unavailable");
  };
  await assert.rejects(
    historyRollups(backends, query, "hour", seam),
    /postgres unavailable/,
  );
  await assert.rejects(
    historyRollups(
      backend(
        [{ ...row("1", "2026-09-22T01:00:00Z", 10), tenant_id: "foreign" }],
        [],
      ),
      query,
      "hour",
      seam,
    ),
    /invalid_rollup_history_row/,
  );
});
test("bounded rollup scan rejects overflow and stalled page cursors", async () => {
  const backends = backend([], []);
  let page = 0;
  backends.history.list = async () =>
    Array.from({ length: 500 }, () =>
      row(String(page++).padStart(8, "0"), "2026-09-22T01:00:00Z", 10),
    );
  await assert.rejects(
    historyRollups(backends, query, "day", seam),
    RollupScanLimit,
  );
  backends.history.list = async () =>
    Array.from({ length: 500 }, () => row("same", "2026-09-22T01:00:00Z", 10));
  await assert.rejects(
    historyRollups(backends, query, "day", seam),
    /rollup_cursor_not_advancing/,
  );
});
