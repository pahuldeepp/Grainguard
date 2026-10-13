/** Placement responses come only from the authenticated control-plane endpoint. */
export interface TenantRoute {
  tenantId: string;
  shardId: string;
  shardIncarnation: string;
  placementEpoch: string;
  state: "active" | "quiescing" | "activating";
  expiresAt: string;
}

export class PlacementError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
export const MAX_ROUTE_TTL_MS = 2_000;
export function placementEpoch(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new PlacementError("invalid_placement_epoch");
  return BigInt(value);
}

export function validateTenantRoute(
  value: unknown,
  tenantId: string,
  now = Date.now(),
): TenantRoute {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PlacementError("invalid_placement_response");
  const route = value as Record<string, unknown>;
  if (
    Object.keys(route)
      .sort((a, b) => (a < b ? -1 : Number(a > b)))
      .join(",") !==
      "expiresAt,placementEpoch,shardId,shardIncarnation,state,tenantId" ||
    !UUID.test(tenantId) ||
    route.tenantId !== tenantId ||
    typeof route.shardId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(route.shardId) ||
    typeof route.shardIncarnation !== "string" ||
    !UUID.test(route.shardIncarnation) ||
    !["active", "quiescing", "activating"].includes(route.state as string) ||
    typeof route.expiresAt !== "string"
  )
    throw new PlacementError("invalid_placement_response");
  placementEpoch(route.placementEpoch);
  const expires = Date.parse(route.expiresAt);
  if (
    !Number.isFinite(expires) ||
    expires <= now ||
    expires - now > MAX_ROUTE_TTL_MS
  )
    throw new PlacementError("expired_placement_response");
  return { ...route } as unknown as TenantRoute;
}

export function httpPlacementFetcher(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Explicitly enable only where Istio STRICT mTLS protects the pod-to-pod hop. */
  meshMtls?: boolean;
}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5_000 ||
    !options.token
  )
    throw new PlacementError("invalid_placement_client_config");
  let endpoint: URL;
  try {
    endpoint = new URL(options.baseUrl);
  } catch {
    throw new PlacementError("invalid_placement_client_config");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    (endpoint.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
      options.meshMtls !== true) ||
    endpoint.username ||
    endpoint.password
  )
    throw new PlacementError("invalid_placement_client_config");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/`;
  endpoint.search = "";
  endpoint.hash = "";
  return async (tenantId: string): Promise<unknown> => {
    if (!UUID.test(tenantId)) throw new PlacementError("invalid_tenant_id");
    const url = new URL(`v1/internal/placements/${tenantId}`, endpoint);
    const signal = AbortSignal.timeout(timeoutMs);
    const bounded = <T>(work: () => Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        const abort = () => reject(new PlacementError("placement_unavailable"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => {
            if (signal.aborted)
              throw new PlacementError("placement_unavailable");
            return work();
          })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    const response = await bounded(() =>
      (options.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${options.token}` },
        signal,
        redirect: "error",
      }),
    );
    if (response.status !== 200) {
      await bounded(async () => {
        await response.body?.cancel().catch(() => undefined);
      });
      throw new PlacementError("placement_unavailable");
    }
    return bounded(() => response.json());
  };
}

/** A short lease is an optimization, never permission to ignore a DB-local fence.
 * Call fresh:true at migration/admission boundaries. Expired entries never serve
 * during an outage, and invalidation also cancels admission of in-flight loads.
 */
export function createPlacementResolver(options: {
  fetch: (tenantId: string) => Promise<unknown>;
  now?: () => number;
  maxEntries?: number;
}) {
  const now = options.now ?? Date.now;
  const max = options.maxEntries ?? 5_000;
  if (!Number.isInteger(max) || max < 1 || max > 100_000)
    throw new PlacementError("invalid_placement_cache_size");
  const entries = new Map<string, TenantRoute>();
  // Short-lived diagnostic guards only. Durable ownership and expected-epoch
  // admission remain authoritative in the primary control plane / shard DBs.
  const highestEpochs = new Map<string, { epoch: bigint; expiresAt: number }>();
  const pending = new Map<string, Promise<TenantRoute>>();
  function load(tenantId: string): Promise<TenantRoute> {
    const existing = pending.get(tenantId);
    if (existing) return existing;
    const work = Promise.resolve().then(async () => {
      try {
        const route = validateTenantRoute(
          await options.fetch(tenantId),
          tenantId,
          now(),
        );
        if (pending.get(tenantId) !== work)
          throw new PlacementError("placement_invalidated");
        const previous = highestEpochs.get(tenantId);
        if (
          previous !== undefined &&
          previous.expiresAt > now() &&
          placementEpoch(route.placementEpoch) < previous.epoch
        )
          throw new PlacementError("placement_authority_invariant_violation");
        highestEpochs.delete(tenantId);
        highestEpochs.set(tenantId, {
          epoch: placementEpoch(route.placementEpoch),
          expiresAt: Date.parse(route.expiresAt),
        });
        while (highestEpochs.size > max)
          highestEpochs.delete(highestEpochs.keys().next().value!);
        entries.delete(tenantId);
        entries.set(tenantId, route);
        while (entries.size > max) entries.delete(entries.keys().next().value!);
        return route;
      } catch (error) {
        if (pending.get(tenantId) === work) entries.delete(tenantId);
        throw error instanceof PlacementError
          ? error
          : new PlacementError("placement_unavailable");
      } finally {
        if (pending.get(tenantId) === work) pending.delete(tenantId);
      }
    });
    pending.set(tenantId, work);
    return work;
  }
  return {
    async resolveTenant(
      tenantId: string,
      demand: {
        fresh?: boolean;
        expectedEpoch?: string;
        requireActive?: boolean;
      } = {},
    ): Promise<TenantRoute> {
      if (!UUID.test(tenantId)) throw new PlacementError("invalid_tenant_id");
      if (demand.expectedEpoch !== undefined)
        placementEpoch(demand.expectedEpoch);
      let route = entries.get(tenantId);
      if (
        demand.fresh ||
        !route ||
        Date.parse(route.expiresAt) <= now() ||
        (demand.expectedEpoch !== undefined &&
          placementEpoch(demand.expectedEpoch) >
            placementEpoch(route.placementEpoch))
      ) {
        route = await load(tenantId);
      }
      if (
        demand.expectedEpoch !== undefined &&
        route.placementEpoch !== demand.expectedEpoch
      )
        throw new PlacementError("stale_placement_epoch");
      if (demand.requireActive !== false && route.state !== "active")
        throw new PlacementError("tenant_quiescing");
      return { ...route };
    },
    invalidate(tenantId: string) {
      entries.delete(tenantId);
      pending.delete(tenantId);
    },
    clear() {
      entries.clear();
      pending.clear();
      highestEpochs.clear();
    },
  };
}
