import pg, { type Pool } from "pg";
import type { ReadTransaction } from "@greenguard/read-model";
import type { ProjectionWatermark } from "@greenguard/membership-client";
import {
  readContext,
  recordSnapshotWatermark,
  assertReadActive,
} from "./consistency.js";
import {
  createReadReplicas,
  FreshnessUnavailable,
  type MinimumSequence,
  type ReplicaProvider,
  type ReplicaLease,
  type ReplicaRequest,
} from "./replicas.js";

export interface ShardReadRegistry {
  providers: Map<string, ReplicaProvider>;
  incarnations: Map<string, string>;
  primary(tenantId: string): Pick<Pool, "connect">;
  ready(): Promise<void>;
  close(): Promise<void>;
}

/** Private configuration only: client tokens cannot supply endpoints. Each pod
 * reserves five primary and five per-replica connections per configured shard.
 */
export function createShardReadRegistry(
  raw: string,
  options: {
    allowLoopback?: boolean;
    poolMax?: number;
    poolFactory?: (url: string) => Pool;
  } = {},
): ShardReadRegistry {
  const poolMax = options.poolMax ?? 5;
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 32)
    throw new Error("invalid_read_shard_pool_max");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid_read_shard_registry");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("read_shard_registry_requires_s1_s2_s3_s4");
  const providers = new Map<string, ReplicaProvider>();
  const pools = new Map<string, Pool>();
  const incarnations = new Map<string, string>();
  const urls = new Set<string>();
  // Match the private registry emitted by scripts/shards-local.mjs and GitOps.
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join(",") !==
      "database,formatVersion,service,shards" ||
    envelope.formatVersion !== 1 ||
    envelope.service !== "read-api" ||
    envelope.database !== "greenguard_read" ||
    !envelope.shards ||
    typeof envelope.shards !== "object" ||
    Array.isArray(envelope.shards) ||
    Object.keys(envelope.shards).sort().join(",") !== "s1,s2,s3,s4"
  )
    throw new Error("invalid_read_shard_registry");
  // Validate the entire manifest before allocating any pool.
  const entries = Object.entries(envelope.shards).map(([shard, config]) => {
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("invalid_read_shard_registry");
    const row = config as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !==
        "incarnation,primaryUrl,replicaUrls" ||
      typeof row.primaryUrl !== "string" ||
      typeof row.incarnation !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        row.incarnation,
      ) ||
      !Array.isArray(row.replicaUrls) ||
      row.replicaUrls.length > 5 ||
      row.replicaUrls.some((x) => typeof x !== "string")
    )
      throw new Error("invalid_read_shard_registry");
    const endpoints = [row.primaryUrl, ...(row.replicaUrls as string[])].map(
      (rawUrl) => {
        let url: URL;
        try {
          url = new URL(rawUrl);
        } catch {
          throw new Error("invalid_read_shard_endpoint");
        }
        const local =
          options.allowLoopback &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        if (
          !["postgres:", "postgresql:"].includes(url.protocol) ||
          decodeURIComponent(url.username) !== "read_query" ||
          !url.password ||
          !url.hostname ||
          url.pathname !== "/greenguard_read" ||
          url.hash ||
          [...url.searchParams.keys()].some(
            (key) =>
              ![
                "sslmode",
                "sslrootcert",
                "sslcert",
                "sslkey",
                "connect_timeout",
                "application_name",
              ].includes(key) || url.searchParams.getAll(key).length !== 1,
          ) ||
          (!local &&
            (url.searchParams.get("sslmode") !== "verify-full" ||
              !url.searchParams.get("sslrootcert")))
        )
          throw new Error("invalid_read_shard_endpoint");
        const normalized = url.toString();
        const address = `${url.hostname}:${url.port || "5432"}${url.pathname}`;
        if (urls.has(address)) throw new Error("duplicate_read_shard_endpoint");
        urls.add(address);
        return normalized;
      },
    );
    return {
      shard,
      primary: endpoints[0],
      replicas: endpoints.slice(1),
      incarnation: row.incarnation,
    };
  });
  const factory =
    options.poolFactory ??
    ((connectionString) =>
      new pg.Pool({
        connectionString,
        max: poolMax,
        connectionTimeoutMillis: 1000,
        query_timeout: 4000,
      }));
  for (const { shard, primary, replicas, incarnation } of entries) {
    const pool = factory(primary);
    pools.set(shard, pool);
    incarnations.set(shard, incarnation);
    providers.set(
      shard,
      createReadReplicas(JSON.stringify(replicas), undefined, primary, {
        primaryPool: pool,
        poolFactory: factory,
        allowPrimaryOnly: true,
        allowLoopback: options.allowLoopback,
        requireWatermark: true,
        attemptTimeoutMs: 1000,
      })!,
    );
  }
  return {
    providers,
    incarnations,
    primary(tenantId) {
      const ctx = readContext.getStore();
      assertReadActive(ctx);
      if (
        !ctx?.lease ||
        ctx.tenantId !== tenantId ||
        Date.parse(ctx.lease.expiresAt) <= Date.now()
      )
        throw new FreshnessUnavailable();
      const pool = pools.get(ctx.lease.route.shardId);
      if (
        !pool ||
        incarnations.get(ctx.lease.route.shardId) !==
          ctx.lease.route.shardIncarnation
      )
        throw new FreshnessUnavailable();
      return pool;
    },
    async ready() {
      const results = await Promise.allSettled(
        [...providers.values()].map((p) => p.ready()),
      );
      if (!results.some((r) => r.status === "fulfilled"))
        throw new FreshnessUnavailable();
    },
    async close() {
      const results = await Promise.allSettled([
        ...[...providers.values()].map((p) => p.close()),
        ...[...pools.values()].map((p) => p.end()),
      ]);
      if (results.some((r) => r.status === "rejected"))
        throw new Error("read_shard_shutdown_failed");
    },
  };
}

/** Request-local context binds the verified tenant, placement and requested
 * minimum to one snapshot. No mutable tenant-wide callback is shared by requests.
 */
export function contextualReplicaProvider(
  source: ReplicaProvider | ShardReadRegistry,
): ReplicaProvider {
  const provider = (tenantId: string): ReplicaProvider => {
    if (!("providers" in source)) return source;
    const ctx = readContext.getStore();
    assertReadActive(ctx);
    if (
      !ctx?.lease ||
      ctx.tenantId !== tenantId ||
      Date.parse(ctx.lease.expiresAt) <= Date.now()
    )
      throw new FreshnessUnavailable();
    const result = source.providers.get(ctx.lease.route.shardId);
    if (
      !result ||
      source.incarnations.get(ctx.lease.route.shardId) !==
        ctx.lease.route.shardIncarnation
    )
      throw new FreshnessUnavailable();
    return result;
  };
  const acquire = async (request: ReplicaRequest): Promise<ReplicaLease> => {
    const ctx = readContext.getStore();
    assertReadActive(ctx);
    if (ctx && ctx.tenantId !== request.tenantId)
      throw new FreshnessUnavailable();
    const minimum = request.minimumSequence ?? ctx?.minimum;
    const placement = ctx?.lease?.route;
    if (
      minimum &&
      placement &&
      (minimum.shardIncarnation !== placement.shardIncarnation ||
        minimum.placementEpoch !== placement.placementEpoch)
    )
      throw new FreshnessUnavailable();
    const lease = await provider(request.tenantId).acquire({
      ...request,
      minimumSequence: minimum,
      placement,
      signal: ctx?.signal ?? request.signal,
      deadline: Math.min(request.deadline, ctx?.deadline ?? request.deadline),
    });
    if (ctx && lease.watermark && request.certify !== false) {
      const watermark: ProjectionWatermark = {
        v: 1,
        tenantId: request.tenantId,
        ...lease.watermark,
      };
      try {
        recordSnapshotWatermark(ctx, watermark);
      } catch (error) {
        await lease.rollback().catch(() => {});
        throw error;
      }
    }
    return lease;
  };
  return {
    acquire,
    async withTenant<T>(
      tenantId: string,
      fn: (tx: ReadTransaction) => Promise<T>,
      minimumSequence?: MinimumSequence,
      deadline = Date.now() + 4000,
    ) {
      const lease = await acquire({ tenantId, minimumSequence, deadline });
      try {
        const result = await fn(lease.tx);
        await lease.commit();
        return result;
      } catch (error) {
        await lease.rollback().catch(() => {});
        throw error;
      }
    },
    health: async () =>
      "providers" in source
        ? (
            await Promise.all(
              [...source.providers.values()].map((p) => p.health()),
            )
          ).flat()
        : source.health(),
    ready: () => source.ready(),
    close: () => source.close(),
  };
}
