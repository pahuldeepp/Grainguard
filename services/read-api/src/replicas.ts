import pg, { type PoolClient, type QueryConfig, type QueryResultRow } from "pg";
import type { ReadTransaction } from "@greenguard/read-model";
import type { TenantRoute } from "@greenguard/membership-client";

export interface MinimumSequence {
  shardIncarnation: string;
  placementEpoch: string;
  sequence: string;
}
export interface ReplicaRequest {
  tenantId: string;
  minimumSequence?: MinimumSequence;
  placement?: Pick<
    TenantRoute,
    "shardId" | "shardIncarnation" | "placementEpoch"
  >;
  /** Absolute Unix time in milliseconds; every admission attempt shares it. */
  deadline: number;
  signal?: AbortSignal;
  /** Internal primary-only reads: cache guard rebuilds and entitlement authority. */
  primaryOnly?: boolean;
  /** Internal metadata does not certify application rows in the HTTP response. */
  certify?: boolean;
}
export class FreshnessUnavailable extends Error {
  constructor() {
    super("read_freshness_unavailable");
  }
}
/** Only an authoritative placement or current primary can establish this. A
 * lagging standby must never manufacture an identity-change recovery signal. */
export class ConsistencyIdentityMismatch extends Error {
  constructor() {
    super("consistency_identity_mismatch");
  }
}
export interface ReplicaLease {
  tx: ReadTransaction;
  endpoint: string;
  watermark?: MinimumSequence;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
export interface ReplicaProvider {
  acquire(request: ReplicaRequest): Promise<ReplicaLease>;
  withTenant<T>(
    tenantId: string,
    fn: (tx: ReadTransaction) => Promise<T>,
    minimumSequence?: MinimumSequence,
    deadline?: number,
  ): Promise<T>;
  health(): Promise<EndpointHealth[]>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
export interface EndpointHealth {
  /** Ordinal name, never a credential-bearing connection URL. */
  endpoint: string;
  healthy: boolean;
  retryAt: number;
}
interface ReadPool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
  on(event: "error", listener: () => void): unknown;
  readonly waitingCount?: number;
  readonly totalCount?: number;
  readonly idleCount?: number;
  readonly options?: { max?: number };
}
export class ReadPoolBusy extends FreshnessUnavailable {}
class LocalPoolWaitTimeout extends ReadPoolBusy {}
class ReadCancelled extends FreshnessUnavailable {}
interface Endpoint {
  id: string;
  pool: ReadPool;
  healthy: boolean;
  failures: number;
  retryAt: number;
  probe?: Promise<void>;
}
export interface ReplicaOptions {
  /** An already-owned pool: close() only closes the replica pools. */
  primaryPool?: ReadPool;
  poolFactory?: (url: string) => ReadPool;
  now?: () => number;
  attemptTimeoutMs?: number;
  /** Used for shard bundles without a replica; still a read-only snapshot. */
  allowPrimaryOnly?: boolean;
  /** Always check and expose the snapshot's committed projection watermark. */
  requireWatermark?: boolean;
  /** Explicit development mode, restricted to loopback endpoints. */
  allowLoopback?: boolean;
}
const TENANT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTEGER = /^(0|[1-9][0-9]{0,18})$/;
const WATERMARK =
  "SELECT shard_incarnation::text, placement_epoch::text, sequence::text FROM read.projection_watermarks WHERE tenant_id=$1 AND shard_incarnation=$2::uuid AND placement_epoch=$3::bigint";
function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Invalid read replica URL");
  }
}
function parseUrls(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid read replica URL configuration");
  }
}

/** Select and admit a transaction before exposing it to application SQL. */
export function createReadReplicas(
  raw: string | undefined,
  hosts: string | undefined,
  primary: string,
  options: ReplicaOptions = {},
): ReplicaProvider | undefined {
  if (raw && hosts) throw new Error("Specify replica URLs or hosts, not both");
  if (!raw && !hosts && !options.allowPrimaryOnly) return undefined;
  const values: unknown = raw
    ? parseUrls(raw)
    : (hosts ? hosts.split(",") : []).map((value) => {
        const host = value.trim();
        if (!/^[a-z0-9.-]+$/.test(host))
          throw new Error("Invalid read replica host");
        const url = parseUrl(primary);
        url.hostname = host;
        url.port = "5432";
        url.searchParams.set("sslmode", "verify-full");
        url.searchParams.set("sslrootcert", "/etc/greenguard/rds/ca.pem");
        return url.toString();
      });
  if (
    !Array.isArray(values) ||
    values.length < (options.allowPrimaryOnly ? 0 : 1) ||
    values.length > 5 ||
    (values.length === 0 && !options.primaryPool)
  )
    throw new Error(
      "READ_REPLICA_DATABASE_URLS must contain 1–5 database URLs",
    );
  const urls = values.map((value) => {
    if (typeof value !== "string") throw new Error("Invalid read replica URL");
    const url = parseUrl(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      decodeURIComponent(url.username) !== "read_query" ||
      !url.password ||
      !url.hostname ||
      url.pathname !== "/greenguard_read" ||
      (!(
        options.allowLoopback &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ) &&
        (url.searchParams.get("sslmode") !== "verify-full" ||
          !url.searchParams.get("sslrootcert")))
    )
      throw new Error(
        "Read replicas require read_query, greenguard_read and verified TLS with a CA file",
      );
    return url.toString();
  });
  if (new Set(urls).size !== urls.length)
    throw new Error("Read replica URLs must be unique");
  const now = options.now ?? Date.now;
  const timeout = options.attemptTimeoutMs ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000)
    throw new Error("Invalid replica attempt timeout");
  const factory =
    options.poolFactory ??
    ((connectionString) =>
      new pg.Pool({
        connectionString,
        max: 5,
        connectionTimeoutMillis: timeout,
        query_timeout: timeout,
      }));
  const endpoints: Endpoint[] = urls.map((url, index) => ({
    id: `replica-${index + 1}`,
    pool: factory(url),
    healthy: true,
    failures: 0,
    retryAt: 0,
  }));
  const primaryEndpoint: Endpoint | undefined = options.primaryPool && {
    id: "primary",
    pool: options.primaryPool,
    healthy: true,
    failures: 0,
    retryAt: 0,
  };
  let next = 0;
  let primaryReadyProbeAt = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const failed = (endpoint: Endpoint) => {
    endpoint.healthy = false;
    endpoint.failures = Math.min(endpoint.failures + 1, 6);
    endpoint.retryAt =
      now() + Math.min(30_000, 500 * 2 ** (endpoint.failures - 1));
  };
  const healthy = (endpoint: Endpoint) => {
    endpoint.healthy = true;
    endpoint.failures = 0;
    endpoint.retryAt = 0;
  };
  for (const endpoint of endpoints)
    endpoint.pool.on("error", () => failed(endpoint));
  primaryEndpoint?.pool.on("error", () => failed(primaryEndpoint));

  const releasedClients = new WeakSet<PoolClient>();
  const releaseClient = (client: PoolClient, discard?: boolean | Error) => {
    if (releasedClients.has(client)) return;
    releasedClients.add(client);
    client.release(discard);
  };
  const active = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new ReadCancelled();
  };
  const cancelWork = <T>(
    work: Promise<T>,
    signal?: AbortSignal,
    cancel?: () => void,
  ): Promise<T> => {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        cancel?.();
        reject(new ReadCancelled());
      };
      signal.addEventListener("abort", abort, { once: true });
      work
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  };
  const requestRemaining = (deadline: number) => {
    const ms = Math.ceil(deadline - now());
    if (closed || ms <= 0) throw new FreshnessUnavailable();
    return ms;
  };
  const remaining = (deadline: number) =>
    Math.min(timeout, requestRemaining(deadline));
  const connect = (
    endpoint: Endpoint,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<PoolClient> => {
    active(signal);
    const ms = remaining(deadline);
    const work = new Promise<PoolClient>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        const pool = endpoint.pool;
        const saturated =
          (pool.waitingCount ?? 0) > 0 &&
          pool.idleCount === 0 &&
          typeof pool.options?.max === "number" &&
          (pool.totalCount ?? 0) >= pool.options.max;
        reject(
          saturated ? new LocalPoolWaitTimeout() : new FreshnessUnavailable(),
        );
      }, ms);
      endpoint.pool.connect().then(
        (client) => {
          releasedClients.delete(client);
          clearTimeout(timer);
          if (expired || closed || signal?.aborted) {
            // No transaction or tenant setting has been started on this client.
            // Return a late pool checkout instead of churning healthy connections.
            releaseClient(client, closed);
            if (!expired) reject(new FreshnessUnavailable());
          } else resolve(client);
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (!expired)
            reject(
              error instanceof Error &&
                error.message === "timeout exceeded when trying to connect"
                ? new LocalPoolWaitTimeout()
                : error,
            );
        },
      );
    });
    return cancelWork(work, signal);
  };
  const query = (
    client: PoolClient,
    text: string,
    values: unknown[],
    deadline: number,
    signal?: AbortSignal,
  ) => {
    active(signal);
    const config: QueryConfig<unknown[]> & { query_timeout: number } = {
      text,
      values,
      query_timeout: remaining(deadline),
    };
    return cancelWork(client.query<QueryResultRow>(config), signal, () =>
      releaseClient(client, true),
    );
  };
  const release = async (client: PoolClient, commit: boolean) => {
    if (releasedClients.has(client)) return;
    let discard: Error | undefined;
    try {
      // Finishing an admitted transaction must remain possible during shutdown
      // or after its request deadline. Cleanup has its own bounded timeout.
      const config: QueryConfig & { query_timeout: number } = {
        text: commit ? "COMMIT" : "ROLLBACK",
        query_timeout: timeout,
      };
      await client.query(config);
    } catch (error) {
      discard =
        error instanceof Error ? error : new Error("replica cleanup failed");
      throw error;
    } finally {
      releaseClient(client, discard);
    }
  };
  const probe = (endpoint: Endpoint, force = false): Promise<void> => {
    if (endpoint.probe) return endpoint.probe;
    if (closed || (!force && !endpoint.healthy && now() < endpoint.retryAt))
      return Promise.resolve();
    endpoint.probe = (async () => {
      let client: PoolClient | undefined;
      const deadline = now() + timeout;
      try {
        client = await connect(endpoint, deadline);
        await query(client, "SELECT 1", [], deadline);
        healthy(endpoint);
      } catch (error) {
        if (!(error instanceof LocalPoolWaitTimeout)) failed(endpoint);
      } finally {
        if (client) releaseClient(client, !endpoint.healthy);
      }
    })().finally(() => {
      endpoint.probe = undefined;
    });
    return endpoint.probe;
  };
  const acquire = async (request: ReplicaRequest): Promise<ReplicaLease> => {
    if (!TENANT.test(request.tenantId))
      throw new Error("valid tenant ID required");
    const minimum = request.minimumSequence;
    if (
      minimum &&
      (!minimum.shardIncarnation ||
        minimum.shardIncarnation.length > 256 ||
        !INTEGER.test(minimum.placementEpoch) ||
        !INTEGER.test(minimum.sequence) ||
        BigInt(minimum.placementEpoch) > 9223372036854775807n ||
        BigInt(minimum.sequence) > 9223372036854775807n)
    )
      throw new Error("invalid minimum projection sequence");
    if (!Number.isFinite(request.deadline))
      throw new Error("invalid replica deadline");
    active(request.signal);
    remaining(request.deadline);
    const start = next;
    let sawPoolWait = false;
    let sawEndpointFailure = false;
    next = endpoints.length ? (next + 1) % endpoints.length : 0;
    const candidates = (request.primaryOnly ? [] : endpoints).map(
      (_, index) => endpoints[(start + index) % endpoints.length],
    );
    // Recovery has its own bounded deadline. A known-good endpoint must not wait
    // behind a failed endpoint's recovery; a probe restores it for later requests.
    for (const endpoint of candidates)
      if (!endpoint.healthy && now() >= endpoint.retryAt)
        void probe(endpoint).catch(() => failed(endpoint));
    const eligible = candidates.filter((e) => e.healthy);
    if (primaryEndpoint) eligible.push(primaryEndpoint);
    for (const endpoint of eligible) {
      let client: PoolClient | undefined;
      try {
        active(request.signal);
        client = await connect(endpoint, request.deadline, request.signal);
        await query(
          client,
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          [],
          request.deadline,
          request.signal,
        );
        await query(
          client,
          "SELECT set_config('app.tenant_id', $1, true)",
          [request.tenantId],
          request.deadline,
          request.signal,
        );
        await query(
          client,
          "SELECT set_config('statement_timeout', $1, true)",
          [String(requestRemaining(request.deadline))],
          request.deadline,
          request.signal,
        );
        let ownerIdentity:
          { shardIncarnation: string; placementEpoch: string } | undefined;
        if (request.placement || minimum || options.requireWatermark) {
          const owner = await query(
            client,
            "SELECT shard_id,shard_incarnation::text,placement_epoch::text,state FROM greenguard_internal.projection_ownership_snapshot($1::uuid)",
            [request.tenantId],
            request.deadline,
            request.signal,
          );
          const row = owner.rows[0];
          if (
            endpoint.id === "primary" &&
            row?.state === "active" &&
            minimum &&
            typeof row.shard_incarnation === "string" &&
            typeof row.placement_epoch === "string" &&
            (!request.placement ||
              (row.shard_id === request.placement.shardId &&
                row.shard_incarnation === request.placement.shardIncarnation &&
                row.placement_epoch === request.placement.placementEpoch)) &&
            (row.shard_incarnation !== minimum.shardIncarnation ||
              row.placement_epoch !== minimum.placementEpoch)
          ) {
            const rejected = client;
            client = undefined;
            await release(rejected, false);
            throw new ConsistencyIdentityMismatch();
          }
          if (
            !row ||
            typeof row.shard_incarnation !== "string" ||
            typeof row.placement_epoch !== "string" ||
            row.state !== "active" ||
            (request.placement &&
              (row.shard_id !== request.placement.shardId ||
                row.shard_incarnation !== request.placement.shardIncarnation ||
                row.placement_epoch !== request.placement.placementEpoch)) ||
            (minimum &&
              (row.shard_incarnation !== minimum.shardIncarnation ||
                row.placement_epoch !== minimum.placementEpoch))
          ) {
            const rejected = client;
            client = undefined;
            await release(rejected, false);
            continue;
          }
          ownerIdentity = {
            shardIncarnation: row.shard_incarnation,
            placementEpoch: row.placement_epoch,
          };
        }
        let watermark: MinimumSequence | undefined;
        if (minimum || options.requireWatermark) {
          const result = await query(
            client,
            WATERMARK,
            [
              request.tenantId,
              ownerIdentity!.shardIncarnation,
              ownerIdentity!.placementEpoch,
            ],
            request.deadline,
            request.signal,
          );
          const row = result.rows[0] as
            | {
                shard_incarnation?: string;
                placement_epoch?: string;
                sequence?: string;
              }
            | undefined;
          if (
            !row ||
            typeof row.shard_incarnation !== "string" ||
            !row.shard_incarnation ||
            typeof row.placement_epoch !== "string" ||
            !INTEGER.test(row.placement_epoch) ||
            typeof row.sequence !== "string" ||
            !INTEGER.test(row.sequence) ||
            BigInt(row.sequence) > 9223372036854775807n ||
            BigInt(row.placement_epoch) > 9223372036854775807n ||
            (minimum &&
              (row.shard_incarnation !== minimum.shardIncarnation ||
                row.placement_epoch !== minimum.placementEpoch ||
                BigInt(row.sequence) < BigInt(minimum.sequence))) ||
            (request.placement &&
              (row.shard_incarnation !== request.placement.shardIncarnation ||
                row.placement_epoch !== request.placement.placementEpoch))
          ) {
            const rejected = client;
            client = undefined;
            await release(rejected, false);
            // Lag is not a connectivity failure. Next endpoint uses a new snapshot.
            continue;
          }
          watermark = {
            shardIncarnation: row.shard_incarnation,
            placementEpoch: row.placement_epoch,
            sequence: row.sequence,
          };
        }
        healthy(endpoint);
        const admitted = client;
        let finished = false;
        // Read-model helpers use promise-based pg queries. Recheck the original
        // deadline for every business statement, preserving its single snapshot.
        const tx: ReadTransaction = {
          query: ((
            config: string | QueryConfig<unknown[]>,
            values?: unknown[],
          ) => {
            active(request.signal);
            if (finished) throw new FreshnessUnavailable();
            const statement: QueryConfig<unknown[]> & {
              query_timeout: number;
            } = {
              ...(typeof config === "string"
                ? { text: config, values }
                : config),
              query_timeout: requestRemaining(request.deadline),
            };
            const signal = AbortSignal.any([
              AbortSignal.timeout(statement.query_timeout),
              ...(request.signal ? [request.signal] : []),
            ]);
            return cancelWork(admitted.query(statement), signal, () =>
              releaseClient(admitted, true),
            );
          }) as PoolClient["query"],
        };
        const cancelAdmitted = () => {
          finished = true;
          releaseClient(admitted, true);
        };
        request.signal?.addEventListener("abort", cancelAdmitted, {
          once: true,
        });
        if (request.signal?.aborted) cancelAdmitted();
        const finish = async (commit: boolean) => {
          request.signal?.removeEventListener("abort", cancelAdmitted);
          if (finished) {
            if (commit) active(request.signal);
            return;
          }
          if (commit) {
            try {
              active(request.signal);
              requestRemaining(request.deadline);
              if (releasedClients.has(admitted))
                throw new FreshnessUnavailable();
            } catch (error) {
              finished = true;
              releaseClient(admitted, true);
              throw error;
            }
          }
          finished = true;
          await release(admitted, commit);
        };
        return {
          tx,
          endpoint: endpoint.id,
          watermark,
          commit: () => finish(true),
          rollback: () => finish(false),
        };
      } catch (error) {
        if (client) releaseClient(client, true);
        if (error instanceof ReadCancelled || request.signal?.aborted)
          throw new ReadCancelled();
        if (error instanceof ConsistencyIdentityMismatch) throw error;
        if (error instanceof LocalPoolWaitTimeout) {
          sawPoolWait = true;
          if (closed || now() >= request.deadline)
            throw new FreshnessUnavailable();
          continue;
        }
        if (closed || now() >= request.deadline)
          throw new FreshnessUnavailable();
        sawEndpointFailure = true;
        failed(endpoint);
      }
    }
    if (sawPoolWait && !sawEndpointFailure) throw new ReadPoolBusy();
    throw new FreshnessUnavailable();
  };
  return {
    acquire,
    async withTenant(tenantId, fn, minimumSequence, deadline = now() + 5000) {
      const lease = await acquire({ tenantId, minimumSequence, deadline });
      // Business SQL is outside the admission retry loop. Never replay it.
      try {
        const result = await fn(lease.tx);
        await lease.commit();
        return result;
      } catch (error) {
        try {
          await lease.rollback();
        } catch {
          /* preserve application failure */
        }
        throw error;
      }
    },
    async health() {
      await Promise.all(endpoints.map((endpoint) => probe(endpoint)));
      return endpoints.map((endpoint) => ({
        endpoint: endpoint.id,
        healthy: endpoint.healthy,
        retryAt: endpoint.retryAt,
      }));
    },
    async ready() {
      await Promise.all(endpoints.map((endpoint) => probe(endpoint)));
      if (endpoints.some((endpoint) => endpoint.healthy) && !closed) return;
      if (primaryEndpoint) {
        // Primary availability can recover sooner than replica failure backoff.
        // Keep an independent short readiness interval to bound sequential probes.
        if (now() >= primaryReadyProbeAt) {
          primaryReadyProbeAt = now() + 100;
          await probe(primaryEndpoint, true);
        }
        if (primaryEndpoint.healthy && !closed) return;
      }
      throw new FreshnessUnavailable();
    },
    close() {
      closed = true;
      closing ??= Promise.allSettled(
        endpoints.map((endpoint) => endpoint.pool.end()),
      ).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new Error("read replica shutdown failed");
      });
      return closing;
    },
  };
}
