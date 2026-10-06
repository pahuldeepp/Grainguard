import type { Pool } from "pg";
import type { MinimumSequence, ReplicaProvider } from "./replicas.js";
import cassandra from "cassandra-driver";
import {
  getDevice,
  getDevices,
  getFreshness,
  getBinReadings,
  getBins,
  getSiteNames,
  listBinDevices,
  listBinTrend,
  type BinTrendBucket,
  getLatestReading,
  getReading,
  listDevicesBySite,
  listReadings,
  withReadTenant,
  type Reading,
  type DeviceView,
  type ReadTransaction,
} from "@greenguard/read-model";

export interface HistoryQuery {
  tenantId: string;
  deviceId: string;
  from: Date;
  to: Date;
  limit: number;
  after?: { observedAt: Date; readingId: string };
}
export interface HistoryBackend {
  list(query: HistoryQuery): Promise<unknown[]>;
  close?(): Promise<void>;
}
export interface BinTrendQuery {
  tenantId: string;
  binId: string;
  window: "H1" | "H6" | "H24";
  resolution: "M1" | "M5" | "M15" | "H1";
  from: Date;
  to: Date;
  bucketSeconds: number;
}
export interface SearchBackend {
  search(tenantId: string, query: string, limit: number): Promise<unknown[]>;
}
/** Aggregate JSON uses the same canonical timestamp and numeric wire types as pg rows. */
type JsonView<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };
function normalizeSnapshotRow<T extends Record<string, unknown>>(
  row: T | null,
): T | null {
  if (!row) return null;
  for (const field of [
    "observed_at",
    "received_at",
    "projected_at",
    "updated_at",
  ]) {
    if (typeof row[field] === "string")
      (row as Record<string, unknown>)[field] = new Date(
        row[field] as string,
      ).toISOString();
  }
  return row;
}

export interface DeviceCurrentSnapshot {
  device: JsonView<DeviceView> | null;
  latestReading: JsonView<Reading> | null;
}
export interface DeviceRiskSnapshot {
  status: "available" | "no_assessments" | "device_not_found";
  assessments: Record<string, unknown>[];
  truncated: boolean;
  validity: "unverified";
  actionable: false;
  caveat: string;
}
export interface ReadBackends {
  deviceRisk(query: HistoryQuery): Promise<DeviceRiskSnapshot>;
  deviceCurrent(
    tenantId: string,
    deviceId: string,
  ): Promise<DeviceCurrentSnapshot>;
  device(tenantId: string, deviceId: string): Promise<unknown>;
  devices(tenantId: string, deviceIds: string[]): Promise<unknown[]>;
  sites(tenantId: string, siteIds: string[]): Promise<unknown[]>;
  bins(tenantId: string, binIds: string[]): Promise<unknown[]>;
  reading(tenantId: string, readingId: string): Promise<unknown>;
  devicesBySite(
    tenantId: string,
    siteId: string,
    limit: number,
    after?: string,
  ): Promise<unknown[]>;
  latest(tenantId: string, deviceId: string): Promise<unknown>;
  binReadings(tenantId: string, binId: string, asOf: Date): Promise<unknown>;
  binTrend(
    query: BinTrendQuery,
  ): Promise<{ bins: unknown; buckets: BinTrendBucket[]; source: "postgres" }>;
  hotReadings(query: HistoryQuery): Promise<Reading[]>;
  rollup(query: HistoryQuery, bucket: "hour" | "day"): Promise<unknown[]>;
  history: HistoryBackend;
  search: SearchBackend;
  close?(): Promise<void>;
}
export function postgresReads(
  pool: Pick<Pool, "connect"> | ReplicaProvider,
  options: {
    /** Trusted consistency resolver; callers must not substitute unverified tenant context. */
    minimumSequence?: (
      tenantId: string,
    ) => Promise<MinimumSequence | undefined>;
  } = {},
) {
  const read = async <T>(
    tenantId: string,
    fn: (tx: ReadTransaction) => Promise<T>,
  ): Promise<T> => {
    const minimum = await options.minimumSequence?.(tenantId);
    if ("withTenant" in pool) return pool.withTenant(tenantId, fn, minimum);
    if (minimum)
      throw new Error("minimum consistency requires a replica provider");
    return withReadTenant(pool, tenantId, fn);
  };
  // The transaction executor chooses the endpoint before invoking any query helper.
  return {
    deviceRisk: (q: HistoryQuery) =>
      read(q.tenantId, async (tx): Promise<DeviceRiskSnapshot> => {
        // Fixed projection query only. security_invoker views retain forced RLS;
        // every scalar subquery also binds the authenticated tenant explicitly.
        // Known withdrawals are excluded; absence of one does not prove current risk.
        const result = await tx.query<{
          known: boolean;
          assessments: Record<string, unknown>[];
        }>(
          `SELECT EXISTS(SELECT 1 FROM read.device_views WHERE tenant_id=$1 AND device_id=$2) AS known,
           COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.occurred_at DESC,a.assessment_id)
             FROM (SELECT assessment_id,reading_id,bin_id,lot_id,grain_type,policy_id,
                 policy_version::text,assessment_version::text,policy_calibrated,policy_provenance,
                 score,severity,alert_eligible,reasons,occurred_at
               FROM read.risk_assessments ra WHERE tenant_id=$1 AND device_id=$2
                 AND NOT EXISTS(SELECT 1 FROM read.risk_assessment_invalidations i
                   WHERE i.tenant_id=$1 AND i.tenant_id=ra.tenant_id
                     AND i.assessment_id=ra.assessment_id)
                 AND occurred_at >= $3 AND occurred_at < $4
                 AND EXISTS(SELECT 1 FROM read.device_views WHERE tenant_id=$1 AND device_id=$2)
               ORDER BY occurred_at DESC,assessment_id LIMIT $5) a),'[]'::jsonb) AS assessments`,
          [q.tenantId, q.deviceId, q.from, q.to, q.limit + 1],
        );
        const row = result.rows[0];
        const assessments = (row?.assessments ?? []).slice(0, q.limit);
        return {
          status: !row?.known
            ? "device_not_found"
            : assessments.length
              ? "available"
              : "no_assessments",
          assessments,
          truncated: (row?.assessments.length ?? 0) > q.limit,
          validity: "unverified",
          actionable: false,
          caveat:
            "Historical projected assessments; known withdrawn or superseded assessments are excluded. Absence of a projected invalidation does not establish current validity, policy applicability, source freshness or actionable risk. Range uses assessment event time (occurred_at).",
        };
      }),
    deviceCurrent: (tenantId: string, deviceId: string) =>
      read(tenantId, async (tx): Promise<DeviceCurrentSnapshot> => {
        // Scalar subqueries are one SQL statement/snapshot, including legacy primary mode.
        // Each result is at most one row and both predicates bind the authenticated tenant.
        // PostgreSQL JSON numbers lose int64 precision in JS; preserve version fields as text.
        const result = await tx.query<{
          device: DeviceCurrentSnapshot["device"];
          latest_reading: DeviceCurrentSnapshot["latestReading"];
        }>(
          `SELECT
             (SELECT to_jsonb(d) || jsonb_build_object('inventory_version',d.inventory_version::text) FROM read.device_views d WHERE tenant_id=$1 AND device_id=$2 LIMIT 1) AS device,
             (SELECT to_jsonb(r) || jsonb_build_object('stream_version',to_jsonb(r)->>'stream_version') || CASE WHEN to_jsonb(r) ? 'age_seconds' THEN jsonb_build_object('age_seconds',to_jsonb(r)->>'age_seconds') ELSE '{}'::jsonb END FROM read.latest_readings r WHERE tenant_id=$1 AND device_id=$2 LIMIT 1) AS latest_reading`,
          [tenantId, deviceId],
        );
        const row = result.rows[0];
        return {
          device: normalizeSnapshotRow(row?.device ?? null),
          latestReading: normalizeSnapshotRow(row?.latest_reading ?? null),
        };
      }),
    device: (tenantId: string, deviceId: string) =>
      read(tenantId, (tx) => getDevice(tx, tenantId, deviceId)),
    devices: (tenantId: string, deviceIds: string[]) =>
      read(tenantId, (tx) => getDevices(tx, tenantId, deviceIds)),
    sites: (tenantId: string, siteIds: string[]) =>
      read(tenantId, (tx) => getSiteNames(tx, tenantId, siteIds)),
    bins: (tenantId: string, binIds: string[]) =>
      read(tenantId, (tx) => getBins(tx, tenantId, binIds)),
    reading: (tenantId: string, readingId: string) =>
      read(tenantId, (tx) => getReading(tx, tenantId, readingId)),
    devicesBySite: (
      tenantId: string,
      siteId: string,
      limit: number,
      after?: string,
    ) =>
      read(tenantId, (tx) =>
        listDevicesBySite(tx, tenantId, siteId, limit, after),
      ),
    latest: (tenantId: string, deviceId: string) =>
      read(tenantId, (tx) => getLatestReading(tx, tenantId, deviceId)),
    binReadings: (tenantId: string, binId: string, asOf: Date) =>
      read(tenantId, (tx) => getBinReadings(tx, tenantId, binId, asOf)),
    binTrend: (q: BinTrendQuery) =>
      read(q.tenantId, async (tx) => {
        const bins = await listBinDevices(tx, q.tenantId, q.binId, 51);
        const bin = (await getBins(tx, q.tenantId, [q.binId]))[0] ?? null;
        if (!bin)
          return { bins: null, buckets: [], source: "postgres" as const };
        const activeIds = bins
          .filter((device) => device.status === "active")
          .slice(0, 50)
          .map((device) => device.device_id);
        const buckets = await listBinTrend(
          tx,
          q.tenantId,
          q.binId,
          activeIds,
          q.from,
          q.to,
          q.bucketSeconds,
        );
        return { bins: bin, buckets, source: "postgres" as const };
      }),
    freshness: (tenantId: string, deviceId: string) =>
      read(tenantId, (tx) => getFreshness(tx, tenantId, deviceId)),
    hotReadings: (q: HistoryQuery) =>
      read(q.tenantId, (tx) =>
        listReadings(
          tx,
          q.tenantId,
          q.deviceId,
          q.from,
          q.to,
          q.limit,
          q.after,
        ),
      ),
    rollup: (q: HistoryQuery, bucket: "hour" | "day") =>
      read(q.tenantId, async (tx) => {
        const result = await tx.query(
          `SELECT date_trunc('${bucket}', observed_at) AS bucket_start, count(*)::int AS sample_count, avg(temperature_c) AS avg_temperature_c, avg(relative_humidity_percent) AS avg_relative_humidity_percent FROM read.reading_history WHERE tenant_id=$1 AND device_id=$2 AND observed_at >= $3 AND observed_at < $4 GROUP BY 1 ORDER BY 1 DESC LIMIT $5`,
          [q.tenantId, q.deviceId, q.from, q.to, q.limit],
        );
        return result.rows;
      }),
  };
}
/** Keep history/search caching, but never refill PostgreSQL cache from an ungated replica. */
export function withoutPostgresCache(
  cached: ReadBackends,
  postgres: ReturnType<typeof postgresReads>,
): ReadBackends {
  return { ...cached, ...postgres };
}
export class CassandraHistory implements HistoryBackend {
  constructor(private readonly client: cassandra.Client) {}
  async list(q: HistoryQuery): Promise<unknown[]> {
    const rows: unknown[] = [];
    const deadline = Date.now() + 5_000;
    // The partition key includes UTC day. Bound fan-out to the API's maximum range.
    for (
      let day = Date.UTC(
        q.to.getUTCFullYear(),
        q.to.getUTCMonth(),
        q.to.getUTCDate(),
      );
      day >=
        Date.UTC(
          q.from.getUTCFullYear(),
          q.from.getUTCMonth(),
          q.from.getUTCDate(),
        ) && rows.length < q.limit;
      day -= 86_400_000
    ) {
      const cursorDay = q.after
        ? Date.UTC(
            q.after.observedAt.getUTCFullYear(),
            q.after.observedAt.getUTCMonth(),
            q.after.observedAt.getUTCDate(),
          )
        : undefined;
      if (cursorDay !== undefined && day > cursorDay) continue;
      const date = new Date(day).toISOString().slice(0, 10);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("cassandra_history_timeout");
      const dayStart = new Date(day);
      const dayEnd = new Date(day + 86_400_000);
      const start = new Date(Math.max(q.from.getTime(), dayStart.getTime()));
      const end = new Date(Math.min(q.to.getTime(), dayEnd.getTime()));
      const statements: Array<{ cql: string; values: unknown[] }> = [];
      if (
        q.after &&
        cursorDay === day &&
        q.after.observedAt >= start &&
        q.after.observedAt < end
      ) {
        statements.push({
          cql: "SELECT tenant_id, device_id, day, observed_at, reading_id, event_id, stream_version, received_at, site_id, bin_id, temperature_c, relative_humidity_percent FROM readings_by_device_day WHERE tenant_id=? AND device_id=? AND day=? AND observed_at=? AND reading_id>? LIMIT ?",
          values: [
            q.tenantId,
            q.deviceId,
            date,
            q.after.observedAt,
            q.after.readingId,
          ],
        });
      }
      const rangeEnd =
        q.after && cursorDay === day
          ? new Date(Math.min(end.getTime(), q.after.observedAt.getTime()))
          : end;
      if (start < rangeEnd) {
        statements.push({
          cql: "SELECT tenant_id, device_id, day, observed_at, reading_id, event_id, stream_version, received_at, site_id, bin_id, temperature_c, relative_humidity_percent FROM readings_by_device_day WHERE tenant_id=? AND device_id=? AND day=? AND observed_at >= ? AND observed_at < ? LIMIT ?",
          values: [q.tenantId, q.deviceId, date, start, rangeEnd],
        });
      }
      for (const statement of statements) {
        if (rows.length >= q.limit) break;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error("cassandra_history_timeout");
        const values = [...statement.values, q.limit - rows.length];
        let pageState: string | undefined;
        const seenPages = new Set<string>();
        do {
          const pageBudgetMs = deadline - Date.now();
          if (pageBudgetMs <= 0) throw new Error("cassandra_history_timeout");
          const result = await this.client.execute(statement.cql, values, {
            prepare: true,
            consistency: cassandra.types.consistencies.localQuorum,
            fetchSize: q.limit,
            readTimeout: pageBudgetMs,
            ...(pageState ? { pageState } : {}),
          });
          rows.push(
            ...result.rows.map((row) => ({
              tenant_id: row.get("tenant_id").toString(),
              device_id: row.get("device_id").toString(),
              reading_id: row.get("reading_id").toString(),
              event_id: row.get("event_id").toString(),
              stream_version: row.get("stream_version").toString(),
              site_id: row.get("site_id")?.toString() ?? null,
              bin_id: row.get("bin_id")?.toString() ?? null,
              observed_at: row.get("observed_at"),
              received_at: row.get("received_at"),
              temperature_c: row.get("temperature_c"),
              relative_humidity_percent: row.get("relative_humidity_percent"),
            })),
          );
          pageState = result.pageState;
          if (pageState && seenPages.has(pageState))
            throw new Error("cassandra_history_cursor_not_advancing");
          if (pageState) seenPages.add(pageState);
        } while (pageState && rows.length < q.limit);
      }
    }
    return rows;
  }
  async close() {
    await this.client.shutdown();
  }
}
export class ElasticSearch implements SearchBackend {
  constructor(
    private readonly url: string,
    private readonly alias = "greenguard-inventory",
    private readonly auth?: {
      username: string;
      password: string;
      caFile: string;
    },
  ) {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("invalid search URL");
    if (
      parsed.protocol === "https:" &&
      (!auth?.username || !auth.password || !auth.caFile)
    )
      throw new Error("HTTPS search requires username, password and CA file");
    if (parsed.protocol === "http:" && auth)
      throw new Error("search credentials require HTTPS");
    if (auth && process.env.NODE_EXTRA_CA_CERTS !== auth.caFile)
      throw new Error(
        "search CA file must be configured as NODE_EXTRA_CA_CERTS before Node starts",
      );
  }
  async search(
    tenantId: string,
    query: string,
    limit: number,
  ): Promise<unknown[]> {
    const text = query.trim();
    const literal = text.replace(/([\\*?])/g, "\\$1");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(
        `${this.url.replace(/\/$/, "")}/${encodeURIComponent(this.alias)}/_search`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...(this.auth && {
              authorization: `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`,
            }),
          },
          body: JSON.stringify({
            size: limit,
            sort: [
              ...(text ? [{ _score: "desc" }] : []),
              { "name.keyword": { order: "asc", missing: "_last" } },
              { serial_number: { order: "asc", missing: "_last" } },
              { resource_id: "asc" },
            ],
            query: {
              bool: {
                filter: [
                  { term: { tenant_id: tenantId } },
                  { term: { resource_type: "device" } },
                ],
                ...(text
                  ? {
                      minimum_should_match: 1,
                      should: [
                        { match_phrase_prefix: { name: text } },
                        {
                          wildcard: {
                            serial_number: {
                              value: `*${literal}*`,
                              case_insensitive: true,
                            },
                          },
                        },
                        {
                          wildcard: {
                            resource_id: {
                              value: `*${literal}*`,
                              case_insensitive: true,
                            },
                          },
                        },
                      ],
                    }
                  : {}),
              },
            },
          }),
        },
      );
      if (!response.ok)
        throw new Error(`search backend HTTP ${response.status}`);
      const body = (await response.json()) as {
        hits?: { hits?: Array<{ _source: unknown }> };
      };
      return (body.hits?.hits ?? [])
        .map((hit) => hit._source)
        .filter(
          (source): source is Record<string, unknown> =>
            typeof source === "object" &&
            source !== null &&
            (source as Record<string, unknown>).tenant_id === tenantId,
        );
    } finally {
      clearTimeout(timer);
    }
  }
}
