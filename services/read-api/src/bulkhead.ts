import type { ReadBackends } from "./backends.js";

export class BulkheadFull extends Error {
  constructor(readonly source: "cassandra" | "elasticsearch") {
    super(`${source}_busy`);
  }
}

class Bulkhead {
  private active = 0;
  private readonly tenants = new Map<string, number>();
  constructor(
    private readonly source: "cassandra" | "elasticsearch",
    private readonly globalLimit: number,
    private readonly tenantLimit: number,
  ) {
    if (
      !Number.isInteger(globalLimit) ||
      globalLimit < 1 ||
      !Number.isInteger(tenantLimit) ||
      tenantLimit < 1
    )
      throw new Error("invalid_bulkhead_limit");
  }
  async run<T>(tenant: string, load: () => Promise<T>): Promise<T> {
    const tenantActive = this.tenants.get(tenant) ?? 0;
    if (this.active >= this.globalLimit || tenantActive >= this.tenantLimit)
      throw new BulkheadFull(this.source);
    // Acquire synchronously before the first await, so concurrent calls cannot oversubscribe.
    this.active++;
    this.tenants.set(tenant, tenantActive + 1);
    try {
      return await load();
    } finally {
      this.active--;
      const remaining = (this.tenants.get(tenant) ?? 1) - 1;
      if (remaining === 0) this.tenants.delete(tenant);
      else this.tenants.set(tenant, remaining);
    }
  }
}

export function bulkheadBackends(
  backends: ReadBackends,
  limits: {
    historyGlobal?: number;
    historyPerTenant?: number;
    searchGlobal?: number;
    searchPerTenant?: number;
  } = {},
): ReadBackends {
  const history = new Bulkhead(
    "cassandra",
    limits.historyGlobal ?? 32,
    limits.historyPerTenant ?? 4,
  );
  const search = new Bulkhead(
    "elasticsearch",
    limits.searchGlobal ?? 64,
    limits.searchPerTenant ?? 8,
  );
  return {
    ...backends,
    history: {
      list: (query) =>
        history.run(query.tenantId, () => backends.history.list(query)),
      close: backends.history.close?.bind(backends.history),
    },
    search: {
      search: (tenant, query, limit) =>
        search.run(tenant, () => backends.search.search(tenant, query, limit)),
    },
  };
}
