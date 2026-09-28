import pg from "pg";
import {
  startEntitlementWorker,
  type Envelope,
} from "@greenguard/entitlements";
export async function applyEntitlement(
  pool: Pick<pg.Pool, "connect">,
  event: Envelope,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [
      event.tenant_id,
    ]);
    const p = event.payload;
    const result = await client.query(
      `INSERT INTO read.tenant_entitlements
   (tenant_id,plan_key,plan_version,limits,features,source_version,applied_at)
   VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,clock_timestamp())
   ON CONFLICT(tenant_id) DO UPDATE SET plan_key=excluded.plan_key,plan_version=excluded.plan_version,
    limits=excluded.limits,features=excluded.features,source_version=excluded.source_version,applied_at=excluded.applied_at
   WHERE read.tenant_entitlements.source_version<excluded.source_version`,
      [
        event.tenant_id,
        p.plan_key,
        p.plan_version,
        JSON.stringify(p.limits),
        JSON.stringify(p.features),
        p.source_version,
      ],
    );
    await client.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
// Feed health (ADR-0022): monotonic per partition, no tenant data, never touches plan rows.
export async function applyHeartbeat(
  pool: Pick<pg.Pool, "query">,
  partition: number,
  emittedAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO read.entitlement_feed_health(partition_id,verified_at)
  VALUES($1,LEAST($2::timestamptz,clock_timestamp()))
  ON CONFLICT(partition_id) DO UPDATE SET verified_at=GREATEST(read.entitlement_feed_health.verified_at,excluded.verified_at)`,
    [partition, emittedAt],
  );
}
if (process.argv[1]?.endsWith("/entitlements/projector.js")) {
  const url = process.env.READ_ENTITLEMENT_PROJECTOR_URL,
    brokers = process.env.KAFKA_BROKERS;
  if (!url || !brokers)
    throw new Error(
      "READ_ENTITLEMENT_PROJECTOR_URL and KAFKA_BROKERS required",
    );
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 2000,
  });
  const stop = await startEntitlementWorker({
    brokers: brokers.split(","),
    groupId: "greenguard-read-entitlements-v1",
    clientId: "read-entitlements",
    apply: (event) => applyEntitlement(pool, event),
    heartbeat: (partition, at) => applyHeartbeat(pool, partition, at),
    onFatal: (error) => {
      console.error(error);
      process.exit(1);
    },
  });
  const shutdown = () => {
    void stop().finally(() => pool.end());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
