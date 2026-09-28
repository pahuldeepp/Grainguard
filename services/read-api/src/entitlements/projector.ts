import pg from "pg";
import {
  admitOwnerPlacement,
  closeOwnerDatabase,
  createOwnerDatabase,
  ownerDatabases,
  resolveOwnerDatabase,
  type OwnerDatabaseOptions,
} from "@greenguard/membership-client/owner-db";

export function createProjectorPool(
  env: NodeJS.ProcessEnv = process.env,
  options: Partial<
    Pick<OwnerDatabaseOptions<pg.Pool>, "create" | "resolve" | "readRegistry">
  > = {},
): pg.Pool {
  return createOwnerDatabase({
    legacyUrl: env.READ_ENTITLEMENT_PROJECTOR_URL ?? "",
    env,
    service: "read-api",
    database: "greenguard_read",
    roles: ["read_entitlement_projector"],
    create: (url) =>
      new pg.Pool({
        connectionString: url,
        max: 5,
        connectionTimeoutMillis: 2000,
        query_timeout: 5000,
      }),
    close: (pool) => pool.end(),
    ...options,
  });
}

export function closeProjectorPool(pool: pg.Pool): Promise<void> {
  return closeOwnerDatabase(pool, 5000, (owner) => owner.end());
}
import {
  startProbeHealth,
  startEntitlementWorker,
  type Envelope,
} from "@greenguard/entitlements";
export async function applyEntitlement(
  pool: Pick<pg.Pool, "connect">,
  event: Envelope,
): Promise<boolean> {
  const { database, route } = await resolveOwnerDatabase(pool, event.tenant_id);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await admitOwnerPlacement(event.tenant_id, route, (sql, parameters) =>
      client.query(sql, parameters),
    );
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
  const owners = ownerDatabases(pool);
  // Keep concurrency explicit even if a future registry has more shards.
  for (let offset = 0; offset < owners.length; offset += 2) {
    await Promise.all(
      owners.slice(offset, offset + 2).map((owner) =>
        owner.query(
          `INSERT INTO read.entitlement_feed_health(partition_id,verified_at)
       VALUES($1,LEAST($2::timestamptz,clock_timestamp()))
       ON CONFLICT(partition_id) DO UPDATE SET verified_at=GREATEST(read.entitlement_feed_health.verified_at,excluded.verified_at)`,
          [partition, emittedAt],
        ),
      ),
    );
  }
}
export async function startProjector(
  pool: pg.Pool,
  brokers: string[],
  start: typeof startEntitlementWorker = startEntitlementWorker,
  health?: Awaited<ReturnType<typeof startProbeHealth>>,
): Promise<() => Promise<void>> {
  let stop: Awaited<ReturnType<typeof startEntitlementWorker>> | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= Promise.resolve()
      .then(() => stop?.())
      .finally(() => closeProjectorPool(pool)));
  try {
    stop = await start({
      brokers,
      groupId: "greenguard-read-entitlements-v1",
      clientId: "read-entitlements",
      apply: (event) => applyEntitlement(pool, event),
      heartbeat: (partition, at) => applyHeartbeat(pool, partition, at),
      onGroupAssigned: health?.ready,
      onGroupUnavailable: health?.notReady,
      onFatal: () => {
        console.error("read entitlement projector failed");
        void shutdown()
          .catch(() => undefined)
          .finally(() => process.exit(1));
      },
    });
  } catch (error) {
    await closeProjectorPool(pool).catch(() => undefined);
    throw error;
  }
  return shutdown;
}

if (process.argv[1]?.endsWith("/entitlements/projector.js")) {
  const url = process.env.READ_ENTITLEMENT_PROJECTOR_URL,
    brokers = process.env.KAFKA_BROKERS;
  if ((!url && !process.env.SHARD_REGISTRY_FILE) || !brokers)
    throw new Error(
      "READ_ENTITLEMENT_PROJECTOR_URL or SHARD_REGISTRY_FILE and KAFKA_BROKERS required",
    );
  const pool = createProjectorPool();
  const health = await startProbeHealth();
  const stop = await startProjector(
    pool,
    brokers.split(","),
    undefined,
    health,
  );
  const shutdown = () => {
    void stop()
      .catch(() => {
        console.error("read entitlement projector shutdown failed");
        process.exitCode = 1;
      })
      .finally(() => health.close());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
