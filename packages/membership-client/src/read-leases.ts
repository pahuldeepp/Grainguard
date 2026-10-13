import {
  PlacementError,
  validateTenantRoute,
  type TenantRoute,
} from "./placement.js";

export interface ReadAdmissionLease {
  leaseId: string;
  expiresAt: string;
  route: TenantRoute;
}
export interface ReadAdmissionOptions {
  deadline?: number;
  signal?: AbortSignal;
}
export interface ReadLeaseAuthority {
  acquire(
    tenantId: string,
    options?: ReadAdmissionOptions,
  ): Promise<ReadAdmissionLease>;
  admit(
    lease: ReadAdmissionLease,
    options?: ReadAdmissionOptions,
  ): Promise<void>;
  release(lease: ReadAdmissionLease): Promise<void>;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function httpReadLeaseAuthority(options: {
  baseUrl: string;
  token: string;
  meshMtls?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}): ReadLeaseAuthority {
  let endpoint: URL;
  try {
    endpoint = new URL(options.baseUrl);
  } catch {
    throw new PlacementError("invalid_placement_client_config");
  }
  if (
    !options.token ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
      !options.meshMtls)
  )
    throw new PlacementError("invalid_placement_client_config");
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/`;
  endpoint.search = endpoint.hash = "";
  const now = options.now ?? Date.now;
  const request = async (
    path: string,
    method: string,
    budget?: ReadAdmissionOptions,
  ) => {
    const remaining =
      budget?.deadline === undefined ? 1000 : budget.deadline - now();
    if (
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      budget?.signal?.aborted
    )
      throw new PlacementError("read_admission_unavailable");
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(remaining)))),
      ...(budget?.signal ? [budget.signal] : []),
    ]);
    const bounded = <T>(work: () => Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        const abort = () =>
          reject(new PlacementError("read_admission_unavailable"));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => {
            if (signal.aborted)
              throw new PlacementError("read_admission_unavailable");
            return work();
          })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
    try {
      const response = await bounded(() =>
        (options.fetch ?? fetch)(new URL(path, endpoint), {
          method,
          headers: { authorization: `Bearer ${options.token}` },
          signal,
          redirect: "error",
        }),
      );
      if (!response.ok) {
        if (response.body)
          await bounded(() => response.body!.cancel().catch(() => undefined));
        throw new PlacementError("read_admission_unavailable");
      }
      return (await bounded(() => response.json())) as unknown;
    } catch (error) {
      throw error instanceof PlacementError
        ? error
        : new PlacementError("read_admission_unavailable");
    }
  };
  function path(lease: ReadAdmissionLease) {
    if (!UUID.test(lease.leaseId) || !UUID.test(lease.route.tenantId))
      throw new PlacementError("invalid_read_lease");
    return `v1/internal/placements/${lease.route.tenantId}/read-leases/${lease.leaseId}`;
  }
  return {
    async acquire(tenantId, budget) {
      if (!UUID.test(tenantId)) throw new PlacementError("invalid_tenant_id");
      const value = await request(
        `v1/internal/placements/${tenantId}/read-leases`,
        "POST",
        budget,
      );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new PlacementError("invalid_read_lease");
      const row = value as Record<string, unknown>;
      if (
        Object.keys(row)
          .sort((a, b) => (a < b ? -1 : Number(a > b)))
          .join(",") !== "expiresAt,leaseId,route" ||
        typeof row.leaseId !== "string" ||
        !UUID.test(row.leaseId) ||
        typeof row.expiresAt !== "string"
      )
        throw new PlacementError("invalid_read_lease");
      const expires = Date.parse(row.expiresAt);
      if (
        !Number.isFinite(expires) ||
        expires <= now() ||
        expires - now() > 5000
      )
        throw new PlacementError("expired_read_lease");
      const route = validateTenantRoute(row.route, tenantId, now());
      if (route.state !== "active")
        throw new PlacementError("tenant_quiescing");
      return { leaseId: row.leaseId, expiresAt: row.expiresAt, route };
    },
    async admit(lease, budget) {
      const expires = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expires) || expires <= now())
        throw new PlacementError("expired_read_lease");
      const value = await request(`${path(lease)}/admit`, "POST", budget);
      if (
        !value ||
        typeof value !== "object" ||
        (value as { admitted?: unknown }).admitted !== true
      )
        throw new PlacementError("read_admission_unavailable");
    },
    async release(lease) {
      await request(path(lease), "DELETE");
    },
  };
}
