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
export async function listDevicesBySite(
  tx: ReadTransaction,
  tenantId: string,
  siteId: string,
  limit = 100,
): Promise<DeviceView[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("limit must be 1..500");
  return rows<DeviceView>(
    tx,
    "SELECT * FROM read.device_views WHERE tenant_id=$1 AND site_id=$2 ORDER BY device_id LIMIT $3",
    [tenantId, siteId, limit],
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
