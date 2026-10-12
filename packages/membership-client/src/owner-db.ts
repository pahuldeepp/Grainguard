import { readFileSync } from "node:fs";
import {
  createPlacementResolver,
  httpPlacementFetcher,
  PlacementError,
  validateTenantRoute,
  type TenantRoute,
} from "./placement.js";

export class OwnerDatabaseError extends PlacementError {}

/** Production deployments set this to prevent a missing registry from
 * silently selecting the legacy, unsharded database URL. */
export function requireShardRegistry(
  env: NodeJS.ProcessEnv,
  registryKey = "SHARD_REGISTRY_FILE",
): void {
  const required = env.SHARD_ROUTING_REQUIRED;
  if (required !== undefined && required !== "true" && required !== "false")
    throw new OwnerDatabaseError("invalid_shard_routing_required");
  if (required === "true" && !env[registryKey]?.trim())
    throw new OwnerDatabaseError("shard_registry_required");
}

export interface OwnerDatabaseOptions<T extends object> {
  legacyUrl: string;
  env?: NodeJS.ProcessEnv;
  service: string;
  database: string;
  roles: readonly string[];
  create: (url: string, shardId?: string) => T;
  close: (database: T) => Promise<unknown>;
  /** Inject a trusted authority for tests; production uses authenticated HTTP. */
  resolve?: (
    tenantId: string,
    demand?: { fresh?: boolean },
  ) => Promise<TenantRoute>;
  readRegistry?: (path: string) => string;
}
interface Runtime<T extends object> {
  databases: Map<string, T>;
  incarnations: Map<string, string>;
  resolve: (
    tenantId: string,
    demand?: { fresh?: boolean },
  ) => Promise<TenantRoute>;
  close: (database: T) => Promise<unknown>;
  closing?: Promise<void>;
}
const runtimes = new WeakMap<object, Runtime<object>>();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validate all private endpoints before constructing any pool. */
export function parseOwnerRegistry(
  raw: string,
  options: {
    service: string;
    database: string;
    roles: readonly string[];
    allowLoopback?: boolean;
  },
): Array<{ shardId: string; incarnation: string; primaryUrl: string }> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OwnerDatabaseError("invalid_owner_registry");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OwnerDatabaseError("invalid_owner_registry");
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).sort().join(",") !==
      "database,formatVersion,service,shards" ||
    manifest.formatVersion !== 1 ||
    manifest.service !== options.service ||
    manifest.database !== options.database ||
    !manifest.shards ||
    typeof manifest.shards !== "object" ||
    Array.isArray(manifest.shards) ||
    Object.keys(manifest.shards).sort().join(",") !== "s1,s2,s3,s4"
  )
    throw new OwnerDatabaseError("invalid_owner_registry");
  const endpoints = new Set<string>();
  return Object.entries(manifest.shards).map(([shardId, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new OwnerDatabaseError("invalid_owner_registry");
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !==
        "incarnation,primaryUrl,replicaUrls" ||
      typeof row.incarnation !== "string" ||
      !UUID.test(row.incarnation) ||
      typeof row.primaryUrl !== "string" ||
      !Array.isArray(row.replicaUrls) ||
      row.replicaUrls.length > 5 ||
      row.replicaUrls.some((url) => typeof url !== "string")
    )
      throw new OwnerDatabaseError("invalid_owner_registry");
    let primaryUrl = "";
    for (const rawUrl of [row.primaryUrl, ...(row.replicaUrls as string[])]) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new OwnerDatabaseError("invalid_owner_endpoint");
      }
      const allowedParameters = new Set([
        "sslmode",
        "sslrootcert",
        "sslcert",
        "sslkey",
        "application_name",
        "connect_timeout",
      ]);
      if (
        [...url.searchParams.keys()].some((key) => !allowedParameters.has(key))
      )
        throw new OwnerDatabaseError("invalid_owner_endpoint");
      if (
        [...url.searchParams.keys()].some(
          (key) => url.searchParams.getAll(key).length !== 1,
        )
      )
        throw new OwnerDatabaseError("invalid_owner_endpoint");
      let role: string;
      try {
        role = decodeURIComponent(url.username);
        if (!decodeURIComponent(url.password))
          throw new Error("empty credentials");
      } catch {
        throw new OwnerDatabaseError("invalid_owner_endpoint");
      }
      const local =
        options.allowLoopback === true &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !options.roles.includes(role) ||
        !url.password ||
        !url.hostname ||
        url.pathname !== `/${encodeURIComponent(options.database)}` ||
        url.hash ||
        (!local &&
          (url.searchParams.get("sslmode") !== "verify-full" ||
            !url.searchParams.get("sslrootcert")))
      )
        throw new OwnerDatabaseError("invalid_owner_endpoint");
      const normalized = url.toString();
      const endpointIdentity = `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
      if (endpoints.has(endpointIdentity))
        throw new OwnerDatabaseError("duplicate_owner_endpoint");
      endpoints.add(endpointIdentity);
      if (!primaryUrl) primaryUrl = normalized;
    }
    return { shardId, incarnation: row.incarnation, primaryUrl };
  });
}

/** Restrict local fixtures to explicitly active loopback shards. Production
 * processes open every configured shard and cannot use this override. */
function activeOwnerEntries(
  raw: string | undefined,
  localLoopback: boolean,
  entries: Array<{ shardId: string; incarnation: string; primaryUrl: string }>,
) {
  if (raw === undefined || raw === "") return entries;
  if (!localLoopback) throw new OwnerDatabaseError("invalid_owner_registry");

  const active = raw.split(",").map((id) => id.trim());
  if (
    active.length === 0 ||
    !active.includes("s1") ||
    new Set(active).size !== active.length ||
    active.some((id) => !["s1", "s2", "s3", "s4"].includes(id)) ||
    entries.some((entry) => {
      try {
        return !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(entry.primaryUrl).hostname,
        );
      } catch {
        return true;
      }
    })
  )
    throw new OwnerDatabaseError("invalid_owner_registry");

  const selected = new Set(active);
  return entries.filter((entry) => selected.has(entry.shardId));
}

/** A logical handle has no default shard. All tenant work must resolve first. */
export function createOwnerDatabase<T extends object>(
  options: OwnerDatabaseOptions<T>,
): T {
  const env = options.env ?? process.env;
  requireShardRegistry(env);
  if (!env.SHARD_REGISTRY_FILE) {
    if (!options.legacyUrl)
      throw new OwnerDatabaseError("owner_database_not_configured");
    return options.create(options.legacyUrl);
  }
  const entries = activeOwnerEntries(
    env.SHARD_ACTIVE_IDS,
    env.SHARD_LOCAL_LOOPBACK === "true",
    parseOwnerRegistry(
      (options.readRegistry ?? ((path) => readFileSync(path, "utf8")))(
        env.SHARD_REGISTRY_FILE,
      ),
      {
        service: options.service,
        database: options.database,
        roles: options.roles,
        allowLoopback: env.SHARD_LOCAL_LOOPBACK === "true",
      },
    ),
  );
  let resolve = options.resolve;
  if (!resolve) {
    if (!env.CONTROL_PLANE_URL || !env.CONTROL_LOOKUP_TOKEN)
      throw new OwnerDatabaseError("placement_authority_not_configured");
    const resolver = createPlacementResolver({
      fetch: httpPlacementFetcher({
        baseUrl: env.CONTROL_PLANE_URL,
        token: env.CONTROL_LOOKUP_TOKEN,
        meshMtls:
          env.CONTROL_PLANE_MESH_MTLS === "true" ||
          env.GG_MESH_INTERNAL_HTTP === "1",
      }),
    });
    resolve = (tenantId, demand) => resolver.resolveTenant(tenantId, demand);
  }
  const runtime: Runtime<T> = {
    databases: new Map(),
    incarnations: new Map(),
    resolve,
    close: options.close,
  };
  try {
    for (const entry of entries) {
      const database = options.create(entry.primaryUrl, entry.shardId);
      runtime.databases.set(entry.shardId, database);
      runtime.incarnations.set(entry.shardId, entry.incarnation);
      runtimes.set(database, runtime as unknown as Runtime<object>);
    }
  } catch (error) {
    // Construction stays synchronous. Close earlier allocations asynchronously,
    // consuming cleanup failures so the original construction error survives.
    for (const database of runtime.databases.values()) {
      runtimes.delete(database);
      void Promise.resolve()
        .then(() => options.close(database))
        .catch(() => {});
    }
    runtime.databases.clear();
    runtime.incarnations.clear();
    throw error;
  }
  const handle = new Proxy(Object.create(null) as T, {
    set() {
      throw new OwnerDatabaseError("owner_tenant_required");
    },
    has() {
      throw new OwnerDatabaseError("owner_tenant_required");
    },
    ownKeys() {
      throw new OwnerDatabaseError("owner_tenant_required");
    },
    get(_target, key) {
      // DI containers inspect constructors and optional lifecycle hooks before
      // injecting a value. These describe this logical handle, never a pool.
      if (
        key === "then" ||
        key === "constructor" ||
        key === "onModuleInit" ||
        key === "onApplicationBootstrap" ||
        key === "onModuleDestroy" ||
        key === "beforeApplicationShutdown" ||
        key === "onApplicationShutdown"
      )
        return undefined;
      if (key === "$disconnect" || key === "end")
        return () => closeOwnerDatabase(handle);
      throw new OwnerDatabaseError("owner_tenant_required");
    },
  });
  runtimes.set(handle, runtime as unknown as Runtime<object>);
  return handle;
}

export function ownerDatabases<T extends object>(handle: T): T[] {
  const runtime = runtimes.get(handle);
  return runtime ? ([...runtime.databases.values()] as T[]) : [handle];
}

export async function resolveOwnerDatabase<T extends object>(
  handle: T,
  tenantId: string,
  demand?: { fresh?: boolean },
): Promise<{ database: T; route?: TenantRoute }> {
  if (!UUID.test(tenantId)) throw new OwnerDatabaseError("invalid_tenant_id");
  const runtime = runtimes.get(handle);
  if (!runtime) return { database: handle };
  if (runtime.closing) throw new OwnerDatabaseError("owner_database_closing");
  const route = validateTenantRoute(
    await runtime.resolve(tenantId, demand),
    tenantId,
  );
  if (route.state !== "active")
    throw new OwnerDatabaseError("tenant_quiescing");
  const database = runtime.databases.get(route.shardId);
  if (
    !database ||
    runtime.incarnations.get(route.shardId) !== route.shardIncarnation
  )
    throw new OwnerDatabaseError("owner_placement_mismatch");
  return { database: database as T, route };
}

/** Call only after BEGIN, before business SQL, on the same pinned transaction. */
export async function admitOwnerPlacement(
  tenantId: string,
  route: TenantRoute | undefined,
  execute: (sql: string, parameters: unknown[]) => Promise<unknown>,
): Promise<void> {
  if (!UUID.test(tenantId)) throw new OwnerDatabaseError("invalid_tenant_id");
  if (!route) {
    await execute("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return;
  }
  const valid = validateTenantRoute(route, tenantId);
  if (valid.state !== "active")
    throw new OwnerDatabaseError("tenant_quiescing");
  await execute(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.shard_id', $2, true), set_config('app.shard_incarnation', $3, true), set_config('app.placement_epoch', $4, true)",
    [tenantId, valid.shardId, valid.shardIncarnation, valid.placementEpoch],
  );
  try {
    await execute(
      "SELECT greenguard_internal.admit_tenant_placement($1::uuid, $2::text, $3::uuid, $4::bigint)",
      [tenantId, valid.shardId, valid.shardIncarnation, valid.placementEpoch],
    );
  } catch {
    throw new OwnerDatabaseError("owner_admission_denied");
  }
}

/** Close every private pool in parallel, with a bounded caller wait. */
export async function closeOwnerDatabase<T extends object>(
  handle: T,
  timeoutMs = 5_000,
  legacyClose?: (database: T) => Promise<unknown>,
): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new OwnerDatabaseError("invalid_owner_shutdown_timeout");
  const runtime = runtimes.get(handle);
  const work = runtime
    ? (runtime.closing ??= Promise.allSettled(
        [...runtime.databases.values()].map((database) =>
          Promise.resolve().then(() => runtime.close(database)),
        ),
      ).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new OwnerDatabaseError("owner_database_shutdown_failed");
      }))
    : Promise.resolve(legacyClose?.(handle)).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new OwnerDatabaseError("owner_database_shutdown_timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
