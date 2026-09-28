import type { ReadBackends } from "./backends.js";

export class BulkheadFull extends Error {
  constructor(readonly source: "cassandra" | "elasticsearch" | "postgres") {
    super(`${source}_busy`);
  }
}

type Queued<T> = {
  load: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Bounded FIFO within each tenant, scheduled round-robin across tenants. */
class FairReadAdmission {
  private active = 0;
  private readonly activeByTenant = new Map<string, number>();
  private readonly queues = new Map<string, Array<Queued<unknown>>>();
  private readonly order: string[] = [];
  private queued = 0;
  private lastTenant: string | undefined;
  constructor(
    private readonly global = 32,
    private readonly perTenant = 4,
    private readonly queueLimit = 128,
    private readonly tenantQueueLimit = 16,
    private readonly waitMs = 2000,
  ) {}
  run<T>(tenant: string, load: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(tenant) ?? [];
      if (
        this.queued >= this.queueLimit ||
        queue.length >= this.tenantQueueLimit
      ) {
        reject(new BulkheadFull("postgres"));
        return;
      }
      const item: Queued<T> = {
        load,
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.queues.get(tenant);
          const index = current?.indexOf(item as Queued<unknown>) ?? -1;
          if (index >= 0) {
            current?.splice(index, 1);
            this.queued--;
            if (!current?.length) {
              this.queues.delete(tenant);
              const orderIndex = this.order.indexOf(tenant);
              if (orderIndex >= 0) this.order.splice(orderIndex, 1);
            }
            reject(new BulkheadFull("postgres"));
          }
        }, this.waitMs),
      };
      if (!queue.length) this.order.push(tenant);
      queue.push(item as Queued<unknown>);
      this.queues.set(tenant, queue);
      this.queued++;
      this.pump();
    });
  }
  private pump() {
    while (this.active < this.global && this.order.length) {
      let selected = -1;
      const lastIndex =
        this.lastTenant === undefined
          ? -1
          : this.order.indexOf(this.lastTenant);
      const start = lastIndex < 0 ? 0 : (lastIndex + 1) % this.order.length;
      for (let offset = 0; offset < this.order.length; offset++) {
        const i = (start + offset) % this.order.length;
        const tenant = this.order[i]!;
        if ((this.activeByTenant.get(tenant) ?? 0) < this.perTenant) {
          selected = i;
          break;
        }
      }
      if (selected < 0) return;
      const tenant = this.order.splice(selected, 1)[0]!;
      this.lastTenant = tenant;
      const queue = this.queues.get(tenant)!;
      const item = queue.shift()!;
      this.queued--;
      if (queue.length) this.order.push(tenant);
      else this.queues.delete(tenant);
      clearTimeout(item.timer);
      this.active++;
      this.activeByTenant.set(
        tenant,
        (this.activeByTenant.get(tenant) ?? 0) + 1,
      );
      void item
        .load()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          const remaining = (this.activeByTenant.get(tenant) ?? 1) - 1;
          if (remaining) this.activeByTenant.set(tenant, remaining);
          else this.activeByTenant.delete(tenant);
          if (this.queues.has(tenant) && !this.order.includes(tenant))
            this.order.push(tenant);
          this.pump();
        });
    }
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
    readGlobal?: number;
    readPerTenant?: number;
    readQueue?: number;
    readTenantQueue?: number;
    readWaitMs?: number;
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
  const reads = new FairReadAdmission(
    limits.readGlobal ?? 32,
    limits.readPerTenant ?? 4,
    limits.readQueue ?? 128,
    limits.readTenantQueue ?? 16,
    limits.readWaitMs ?? 2000,
  );
  return {
    ...backends,
    binReadings: (tenant, bin, asOf) =>
      reads.run(tenant, () => backends.binReadings(tenant, bin, asOf)),
    binTrend: (query) =>
      reads.run(query.tenantId, () => backends.binTrend(query)),
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
