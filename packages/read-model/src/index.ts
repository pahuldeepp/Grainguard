import type { Pool, PoolClient, QueryResultRow } from "pg";

export type ReadTransaction = Pick<PoolClient, "query">;

export async function withReadTenant<T>(
  db: Pick<Pool, "connect">,
  tenantId: string,
  fn: (tx: ReadTransaction) => Promise<T>,
): Promise<T> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      tenantId,
    )
  ) {
    throw new Error("valid tenant ID required");
  }
  const tx = await db.connect();
  let discard: Error | undefined;
  try {
    await tx.query("BEGIN READ ONLY");
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await tx.query("SELECT set_config('statement_timeout', '2000', true)");
    const value = await fn(tx);
    await tx.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await tx.query("ROLLBACK");
    } catch (rollbackError) {
      discard =
        rollbackError instanceof Error
          ? rollbackError
          : new Error("rollback failed");
    }
    throw error;
  } finally {
    tx.release(discard);
  }
}

async function rows<T extends QueryResultRow>(
  tx: ReadTransaction,
  sql: string,
  args: unknown[],
): Promise<T[]> {
  const result = await tx.query<T>(sql, args);
  return result.rows;
}

export interface DeviceView extends QueryResultRow {
  tenant_id: string;
  device_id: string;
  site_id: string;
  bin_id: string | null;
  serial_number: string;
  status: string;
  inventory_version: string;
}
export interface Reading extends QueryResultRow {
  tenant_id: string;
  reading_id: string;
  device_id: string;
  event_id: string;
  observed_at: Date;
  received_at: Date;
  temperature_c: number | null;
  relative_humidity_percent: number | null;
  inventory_enrichment: string;
}
export interface Latest extends QueryResultRow {
  tenant_id: string;
  device_id: string;
  reading_id: string;
  selected_observed_at: Date;
  selected_stream_version: string;
  projected_at: Date;
}

export interface BinView extends QueryResultRow {
  tenant_id: string;
  bin_id: string;
  site_id: string;
  name: string;
  site_name: string | null;
  bin_version: string;
  site_version: string | null;
  projected_at: Date;
}
export interface BinDeviceView extends QueryResultRow {
  tenant_id: string;
  device_id: string;
  site_id: string;
  bin_id: string;
  status: string;
  serial_number: string;
  inventory_version: string;
}
export interface BinMetricSample extends QueryResultRow {
  tenant_id: string;
  bin_id: string;
  device_id: string;
  metric: string;
  unit: string;
  value: number;
  observed_at: Date;
  received_at: Date;
  projected_at: Date;
  reading_id: string;
  stream_version: string;
}
export interface BinSensorSample extends QueryResultRow {
  tenant_id: string;
  bin_id: string;
  device_id: string;
  reading_id: string;
  sensor_id: string;
  cable_id: string;
  layout_version: string;
  position: number;
  depth_m: number | null;
  label: string | null;
  metric: string;
  unit: string;
  value: number;
  observed_at: Date;
  received_at: Date;
}
export interface CableSensorView extends QueryResultRow {
  tenant_id: string;
  device_id: string;
  bin_id: string;
  cable_id: string;
  cable_version: string;
  sensor_id: string;
  position: number;
  depth_m: number | null;
  label: string;
}
export interface BinTrendBucket extends QueryResultRow {
  bucket_at: Date;
  metric: string;
  unit: string;
  min_value: number | null;
  average_value: number | null;
  max_value: number | null;
  sample_count: number;
  device_count: number;
}
export interface BinReadings {
  bin: BinView;
  devices: BinDeviceView[];
  devicesTruncated: boolean;
  readings: BinMetricSample[];
  layout: CableSensorView[];
  sensorReadings: BinSensorSample[];
  policies: BinPolicyView[];
  freshness: "not_configured";
}
export interface BinPolicyView extends QueryResultRow {
  policy_id: string;
  policy_version: string;
  grain_type: string;
  effective_from: Date;
  effective_to: Date | null;
  measurement_thresholds: unknown;
  risk_thresholds: unknown;
  calibrated: boolean;
  status: string;
  provenance: unknown;
  calibration_evidence: string | null;
}

export async function getBins(
  tx: ReadTransaction,
  tenantId: string,
  binIds: string[],
): Promise<BinView[]> {
  if (binIds.length === 0) return [];
  if (binIds.length > 100) throw new Error("at most 100 bin IDs");
  return rows<BinView>(
    tx,
    `SELECT b.tenant_id,b.bin_id,b.site_id,b.name,b.bin_version,b.updated_at AS projected_at,
            s.name AS site_name,s.site_version
       FROM read.bin_views b
       LEFT JOIN read.site_views s ON s.tenant_id=b.tenant_id AND s.site_id=b.site_id
      WHERE b.tenant_id=$1 AND b.bin_id=ANY($2::uuid[])`,
    [tenantId, binIds],
  );
}

export async function getSiteNames(
  tx: ReadTransaction,
  tenantId: string,
  siteIds: string[],
) {
  if (siteIds.length === 0) return [];
  if (siteIds.length > 100) throw new Error("at most 100 site IDs");
  return rows<{ tenant_id: string; site_id: string; name: string }>(
    tx,
    "SELECT tenant_id,site_id,name FROM read.site_views WHERE tenant_id=$1 AND site_id=ANY($2::uuid[])",
    [tenantId, siteIds],
  );
}

export async function listBinDevices(
  tx: ReadTransaction,
  tenantId: string,
  binId: string,
  limit = 51,
): Promise<BinDeviceView[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 51)
    throw new Error("bin device limit must be 1..51");
  return rows<BinDeviceView>(
    tx,
    `SELECT tenant_id,device_id,site_id,bin_id,status,serial_number,inventory_version
       FROM read.device_views
      WHERE tenant_id=$1 AND bin_id=$2 AND status IN ('active','disabled')
      ORDER BY device_id LIMIT $3`,
    [tenantId, binId, limit],
  );
}

export async function listBinMetricSamples(
  tx: ReadTransaction,
  tenantId: string,
  binId: string,
  deviceIds: string[],
): Promise<BinMetricSample[]> {
  if (deviceIds.length === 0) return [];
  if (deviceIds.length > 50) throw new Error("at most 50 active devices");
  return rows<BinMetricSample>(
    tx,
    `WITH devices AS (SELECT unnest($3::uuid[]) AS device_id), metrics(metric) AS
       (VALUES ('temperature_c'),('relative_humidity_percent'),('co2_ppm'),('grain_moisture_percent'))
     SELECT $1::uuid AS tenant_id,$2::uuid AS bin_id,d.device_id,m.metric,
            sample.unit,sample.value,sample.observed_at,sample.received_at,
            sample.projected_at,sample.reading_id,sample.stream_version
       FROM devices d CROSS JOIN metrics m
       CROSS JOIN LATERAL (
         SELECT i.event->'payload'->>'reading_id' AS reading_id,
                (i.event->'payload'->>'observed_at')::timestamptz AS observed_at,
                (i.event->'payload'->>'received_at')::timestamptz AS received_at,
                i.processed_at AS projected_at,
                (i.event->>'aggregate_version')::bigint::text AS stream_version,
                (i.event->'payload'->'measurements'->>m.metric)::double precision AS value,
                i.event->'payload'->'measurement_units'->>m.metric AS unit
           FROM public.consumer_inbox i
          WHERE i.tenant_id=$1 AND i.event->>'event_type'='telemetry.recorded'
            AND i.event->>'aggregate_id'=d.device_id::text
            AND i.event->'payload'->>'device_id'=d.device_id::text
            AND i.event->'payload'->>'bin_id'=$2::text
            AND i.event->'payload'->'measurements' ? m.metric
          ORDER BY (i.event->'payload'->>'observed_at')::timestamptz DESC,
                   (i.event->>'aggregate_version')::bigint DESC LIMIT 1
       ) sample
      WHERE sample.value IS NOT NULL
      ORDER BY sample.observed_at DESC,sample.stream_version::bigint DESC,d.device_id`,
    [tenantId, binId, deviceIds],
  );
}

export async function listBinSensors(
  tx: ReadTransaction,
  tenantId: string,
  binId: string,
  deviceIds: string[],
): Promise<{ layout: CableSensorView[]; latest: BinSensorSample[] }> {
  if (deviceIds.length === 0) return { layout: [], latest: [] };
  if (deviceIds.length > 50) throw new Error("at most 50 active devices");
  const layout = await rows<CableSensorView>(
    tx,
    `SELECT c.tenant_id,c.device_id,c.bin_id,c.cable_id,c.cable_version,
            s.sensor_id,s.position,s.depth_m,s.label
       FROM read.current_cables c JOIN read.cable_layout_sensors s
         ON s.tenant_id=c.tenant_id AND s.cable_id=c.cable_id AND s.cable_version=c.cable_version
      WHERE c.tenant_id=$1 AND c.bin_id=$2 AND c.device_id=ANY($3::uuid[]) AND c.operation='upsert'
      ORDER BY c.device_id,c.cable_id,s.position,s.sensor_id LIMIT 5001`,
    [tenantId, binId, deviceIds],
  );
  if (layout.length > 5000) throw new Error("sensor layout exceeds bound");
  const latest = await rows<BinSensorSample>(
    tx,
    `SELECT tenant_id,bin_id,device_id,reading_id,sensor_id,cable_id,layout_version,
            position,depth_m,label,metric,unit,value,observed_at,received_at
       FROM read.latest_sensor_readings
      WHERE tenant_id=$1 AND bin_id=$2 AND device_id=ANY($3::uuid[])
      ORDER BY device_id,cable_id,position,metric,sensor_id LIMIT 20001`,
    [tenantId, binId, deviceIds],
  );
  if (latest.length > 20000)
    throw new Error("latest sensor samples exceed bound");
  return { layout, latest };
}

export async function listBinTrend(
  tx: ReadTransaction,
  tenantId: string,
  binId: string,
  deviceIds: string[],
  from: Date,
  to: Date,
  bucketSeconds: number,
): Promise<BinTrendBucket[]> {
  if (
    deviceIds.length > 50 ||
    !Number.isInteger(bucketSeconds) ||
    bucketSeconds < 60 ||
    bucketSeconds > 3600 ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > 24 * 60 * 60 * 1000
  )
    throw new Error("invalid bin trend query");
  if (deviceIds.length === 0) return [];
  return rows<BinTrendBucket>(
    tx,
    `WITH samples AS (
       SELECT tenant_id,bin_id,device_id,observed_at,metric,unit,value
         FROM read.bin_metric_history
        WHERE tenant_id=$1 AND bin_id=$2 AND device_id=ANY($3::uuid[])
          AND observed_at >= $4 AND observed_at < $5
     ), buckets AS (
       SELECT date_bin(make_interval(secs => $6::double precision),observed_at,$4::timestamptz) AS bucket_at,
              metric,unit,min(value) AS min_value,avg(value) AS average_value,max(value) AS max_value,
              count(*)::int AS sample_count,count(DISTINCT device_id)::int AS device_count
         FROM samples GROUP BY 1,2,3
     ), times AS (
       SELECT generate_series($4::timestamptz,$5::timestamptz-make_interval(secs => $6::double precision),make_interval(secs => $6::double precision)) AS bucket_at
     ), metrics(metric,unit) AS (VALUES ('temperature_c','Cel'),('relative_humidity_percent','%'),('co2_ppm','ppm'),('grain_moisture_percent','%'))
     SELECT times.bucket_at,metrics.metric,metrics.unit,buckets.min_value,buckets.average_value,buckets.max_value,
            COALESCE(buckets.sample_count,0)::int AS sample_count,COALESCE(buckets.device_count,0)::int AS device_count
       FROM times CROSS JOIN metrics LEFT JOIN buckets ON buckets.bucket_at=times.bucket_at AND buckets.metric=metrics.metric
      ORDER BY times.bucket_at,metrics.metric`,
    [tenantId, binId, deviceIds, from, to, bucketSeconds],
  );
}

export async function getBinPolicies(
  tx: ReadTransaction,
  tenantId: string,
  binId: string,
  asOf: Date,
): Promise<BinPolicyView[]> {
  return rows<BinPolicyView>(
    tx,
    `SELECT policy_id,policy_version,grain_type,effective_from,effective_to,
            measurement_thresholds,risk_thresholds,calibrated,status,provenance,calibration_evidence
       FROM read.risk_policy_versions
      WHERE tenant_id=$1 AND (bin_id=$2 OR bin_id IS NULL)
        AND status='active' AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
      ORDER BY (bin_id=$2) DESC,effective_from DESC,policy_version DESC LIMIT 20`,
    [tenantId, binId, asOf],
  );
}

/** One tenant-scoped snapshot of current bin membership and its read models. */
export async function getBinReadings(
  tx: ReadTransaction,
  tenantId: string,
  binId: string,
  asOf: Date,
): Promise<BinReadings | null> {
  const bin = (await getBins(tx, tenantId, [binId]))[0];
  if (!bin) return null;
  const devices = await listBinDevices(tx, tenantId, binId, 51);
  const devicesTruncated = devices.length > 50;
  const page = devices.slice(0, 50);
  const active = page.filter((device) => device.status === "active");
  const deviceIds = active.map((device) => device.device_id);
  const [allReadings, sensors, policies] = await Promise.all([
    listBinMetricSamples(tx, tenantId, binId, deviceIds),
    listBinSensors(tx, tenantId, binId, deviceIds),
    getBinPolicies(tx, tenantId, binId, asOf),
  ]);
  const latest = new Map<string, BinMetricSample>();
  for (const sample of [...allReadings].sort(
    (a, b) =>
      b.observed_at.getTime() - a.observed_at.getTime() ||
      (BigInt(b.stream_version) > BigInt(a.stream_version)
        ? 1
        : BigInt(b.stream_version) < BigInt(a.stream_version)
          ? -1
          : a.device_id.localeCompare(b.device_id)),
  ))
    if (!latest.has(sample.metric)) latest.set(sample.metric, sample);
  return {
    bin,
    devices: page,
    devicesTruncated,
    readings: [...latest.values()].sort((a, b) =>
      a.metric.localeCompare(b.metric),
    ),
    layout: sensors.layout,
    sensorReadings: sensors.latest,
    policies,
    freshness: "not_configured",
  };
}

export async function getDevice(
  tx: ReadTransaction,
  tenantId: string,
  deviceId: string,
): Promise<DeviceView | null> {
  return (
    (
      await rows<DeviceView>(
        tx,
        "SELECT * FROM read.device_views WHERE tenant_id=$1 AND device_id=$2",
        [tenantId, deviceId],
      )
    )[0] ?? null
  );
}
export async function getDevices(
  tx: ReadTransaction,
  tenantId: string,
  deviceIds: string[],
): Promise<DeviceView[]> {
  if (deviceIds.length === 0) return [];
  if (deviceIds.length > 100) throw new Error("at most 100 device IDs");
  return rows<DeviceView>(
    tx,
    "SELECT * FROM read.device_views WHERE tenant_id=$1 AND device_id = ANY($2::uuid[])",
    [tenantId, deviceIds],
  );
}
export async function listDevicesBySite(
  tx: ReadTransaction,
  tenantId: string,
  siteId: string,
  limit = 100,
  after?: string,
): Promise<DeviceView[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("limit must be 1..500");
  if (
    after !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      after,
    )
  )
    throw new Error("after must be a valid device ID");
  return rows<DeviceView>(
    tx,
    "SELECT * FROM read.device_views WHERE tenant_id=$1 AND site_id=$2 AND ($4::uuid IS NULL OR device_id > $4::uuid) ORDER BY device_id LIMIT $3",
    [tenantId, siteId, limit, after ?? null],
  );
}
export async function getLatestReading(
  tx: ReadTransaction,
  tenantId: string,
  deviceId: string,
): Promise<Reading | null> {
  return (
    (
      await rows<Reading>(
        tx,
        "SELECT * FROM read.latest_readings WHERE tenant_id=$1 AND device_id=$2",
        [tenantId, deviceId],
      )
    )[0] ?? null
  );
}
export async function getReading(
  tx: ReadTransaction,
  tenantId: string,
  readingId: string,
): Promise<Reading | null> {
  return (
    (
      await rows<Reading>(
        tx,
        "SELECT * FROM read.reading_history WHERE tenant_id=$1 AND reading_id=$2",
        [tenantId, readingId],
      )
    )[0] ?? null
  );
}
export async function listReadings(
  tx: ReadTransaction,
  tenantId: string,
  deviceId: string,
  from: Date,
  to: Date,
  limit = 100,
): Promise<Reading[]> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to
  )
    throw new Error("invalid history range or limit");
  return rows<Reading>(
    tx,
    "SELECT * FROM read.reading_history WHERE tenant_id=$1 AND device_id=$2 AND observed_at >= $3 AND observed_at < $4 ORDER BY observed_at DESC, stream_version DESC LIMIT $5",
    [tenantId, deviceId, from, to, limit],
  );
}
export async function getFreshness(
  tx: ReadTransaction,
  tenantId: string,
  deviceId: string,
): Promise<Latest | null> {
  return (
    (
      await rows<Latest>(
        tx,
        "SELECT * FROM read.device_latest WHERE tenant_id=$1 AND device_id=$2",
        [tenantId, deviceId],
      )
    )[0] ?? null
  );
}
