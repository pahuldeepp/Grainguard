import type { HistoryQuery, ReadBackends } from "./backends.js";
import {
  assertReadActive,
  readContext,
  readWithinBudget,
} from "./consistency.js";

export class RollupScanLimit extends Error {
  constructor() {
    super("rollup_scan_limit");
  }
}
export interface HistoryRollup {
  bucket_start: Date;
  sample_count: number;
  avg_temperature_c: number | null;
  avg_relative_humidity_percent: number | null;
}
const PAGE_SIZE = 500;
const MAX_ROWS = 50_000;
const SCAN_BUDGET_MS = 5_000;
/** Scan every selected source before returning aggregates. The row cap and shared
 * deadline fail the whole request; they never turn a partial scan into an average. */
export async function historyRollups(
  backends: Pick<ReadBackends, "hotReadings" | "history">,
  query: HistoryQuery,
  bucket: "hour" | "day",
  hotStart: Date,
): Promise<HistoryRollup[]> {
  const context = readContext.getStore();
  const deadline = Math.min(
    Date.now() + SCAN_BUDGET_MS,
    context?.deadline ?? Infinity,
  );
  const timeoutSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const signal = context?.signal
    ? AbortSignal.any([context.signal, timeoutSignal])
    : timeoutSignal;
  const byId = new Map<string, Record<string, unknown>>();
  let scanned = 0;
  const scan = async (
    source: (q: HistoryQuery) => Promise<unknown[]>,
    from: Date,
    to: Date,
  ) => {
    if (from >= to) return;
    let after: HistoryQuery["after"];
    for (;;) {
      assertReadActive();
      if (Date.now() >= deadline) throw new Error("rollup_scan_timeout");
      const rows = await readWithinBudget(
        () =>
          source({
            ...query,
            from,
            to,
            limit: PAGE_SIZE,
            ...(after ? { after } : {}),
          }),
        signal,
      );
      if (Date.now() >= deadline) throw new Error("rollup_scan_timeout");
      if (rows.length > PAGE_SIZE || (scanned += rows.length) > MAX_ROWS)
        throw new RollupScanLimit();
      for (const value of rows) {
        const row = value as Record<string, unknown>;
        const observedAt = new Date(row.observed_at as string | number | Date);
        if (
          row.tenant_id !== query.tenantId ||
          row.device_id !== query.deviceId ||
          typeof row.reading_id !== "string" ||
          !Number.isFinite(observedAt.getTime()) ||
          observedAt < query.from ||
          observedAt >= query.to
        )
          throw new Error("invalid_rollup_history_row");
        for (const metric of ["temperature_c", "relative_humidity_percent"])
          if (
            row[metric] != null &&
            (typeof row[metric] !== "number" || !Number.isFinite(row[metric]))
          )
            throw new Error("invalid_rollup_metric");
        byId.set(row.reading_id, row);
      }
      if (rows.length < PAGE_SIZE) break;
      const last = rows.at(-1) as Record<string, unknown>;
      const next = {
        observedAt: new Date(last.observed_at as string | number | Date),
        readingId: last.reading_id as string,
      };
      if (
        after &&
        (next.observedAt > after.observedAt ||
          (next.observedAt.getTime() === after.observedAt.getTime() &&
            next.readingId <= after.readingId))
      )
        throw new Error("rollup_cursor_not_advancing");
      after = next;
    }
  };
  // Cold first, then hot: PostgreSQL wins any duplicate reading identity.
  await scan(
    (q) => backends.history.list(q),
    query.from,
    new Date(Math.min(query.to.getTime(), hotStart.getTime())),
  );
  await scan(
    (q) => backends.hotReadings(q),
    new Date(Math.max(query.from.getTime(), hotStart.getTime())),
    query.to,
  );
  const width = bucket === "hour" ? 3_600_000 : 86_400_000;
  const buckets = new Map<
    number,
    {
      count: number;
      temp: number;
      tempCount: number;
      humidity: number;
      humidityCount: number;
    }
  >();
  for (const row of byId.values()) {
    const start =
      Math.floor(
        new Date(row.observed_at as string | number | Date).getTime() / width,
      ) * width;
    const aggregate = buckets.get(start) ?? {
      count: 0,
      temp: 0,
      tempCount: 0,
      humidity: 0,
      humidityCount: 0,
    };
    aggregate.count++;
    if (typeof row.temperature_c === "number") {
      aggregate.temp += row.temperature_c;
      aggregate.tempCount++;
    }
    if (typeof row.relative_humidity_percent === "number") {
      aggregate.humidity += row.relative_humidity_percent;
      aggregate.humidityCount++;
    }
    buckets.set(start, aggregate);
  }
  return [...buckets]
    .sort(([a], [b]) => b - a)
    .slice(0, query.limit)
    .map(([start, a]) => ({
      bucket_start: new Date(start),
      sample_count: a.count,
      avg_temperature_c: a.tempCount ? a.temp / a.tempCount : null,
      avg_relative_humidity_percent: a.humidityCount
        ? a.humidity / a.humidityCount
        : null,
    }));
}
