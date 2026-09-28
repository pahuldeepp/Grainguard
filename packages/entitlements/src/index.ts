export type LimitKey =
  | "devices.max"
  | "seats.max"
  | "api_keys.max"
  | "ingest.readings_per_month"
  | "ingest.rate_per_device"
  | "ingest.rate_per_tenant"
  | "retention.days"
  | "history.range_days"
  | "exports.per_day";
export type FeatureKey = "sso" | "audit_export";
export interface Entitlement {
  tenantId: string;
  planKey: string;
  planVersion: number;
  sourceVersion: bigint;
  limits: Partial<Record<LimitKey, number>>;
  features: Partial<Record<FeatureKey, boolean>>;
  appliedAt: Date;
}
export interface ChangedEvent {
  event_type: "entitlements.changed";
  tenant_id: string;
  payload: {
    tenant_id: string;
    plan_key: string;
    plan_version: string;
    source_version: string;
    limits: Record<string, number>;
    features: Record<string, boolean>;
    effective_at: string;
  };
}
export const DEFAULT_LIMITS: Readonly<Record<LimitKey, number>> = Object.freeze(
  {
    "devices.max": 10,
    "seats.max": 3,
    "api_keys.max": 1,
    "ingest.readings_per_month": 100_000,
    "ingest.rate_per_device": 12,
    "ingest.rate_per_tenant": 12_000,
    "retention.days": 7,
    "history.range_days": 7,
    "exports.per_day": 0,
  },
);
export const MAX_STALENESS_MS = 5 * 60_000;
// Reference implementation of the ADR-0022 freshness rule; the SQL function
// entitlement_feed_fresh() in each consumer database is its persistent twin.
export class EntitlementStore {
  private readonly rows = new Map<string, Entitlement>();
  private readonly feed = new Map<number, number>();
  constructor(
    private readonly onStale: (tenantId: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}
  // Monotonic per partition: a late or replayed heartbeat never lowers health.
  heartbeat(partition: number, emittedAt: Date): void {
    this.feed.set(
      partition,
      Math.max(this.feed.get(partition) ?? 0, emittedAt.getTime()),
    );
  }
  private feedFresh(): boolean {
    return (
      this.feed.size > 0 &&
      Math.min(...this.feed.values()) >= this.now().getTime() - MAX_STALENESS_MS
    );
  }
  apply(event: ChangedEvent): boolean {
    const p = event.payload;
    if (
      event.event_type !== "entitlements.changed" ||
      event.tenant_id !== p.tenant_id ||
      !/^\d+$/.test(p.source_version) ||
      !/^\d+$/.test(p.plan_version) ||
      !Number.isFinite(Date.parse(p.effective_at))
    )
      throw new Error("invalid_entitlement_event");
    const version = BigInt(p.source_version);
    const prior = this.rows.get(event.tenant_id);
    if (prior && version <= prior.sourceVersion) return false;
    const limits: Entitlement["limits"] = {};
    for (const [key, value] of Object.entries(p.limits)) {
      if (!(key in DEFAULT_LIMITS) || !Number.isFinite(value) || value < 0)
        throw new Error("invalid_entitlement_limit");
      limits[key as LimitKey] = value;
    }
    const features: Entitlement["features"] = {};
    for (const [key, value] of Object.entries(p.features)) {
      if (
        (key !== "sso" && key !== "audit_export") ||
        typeof value !== "boolean"
      )
        throw new Error("invalid_entitlement_feature");
      features[key] = value;
    }
    this.rows.set(event.tenant_id, {
      tenantId: event.tenant_id,
      planKey: p.plan_key,
      planVersion: Number(p.plan_version),
      sourceVersion: version,
      limits,
      features,
      appliedAt: this.now(),
    });
    return true;
  }
  decision(
    tenantId: string,
    key: LimitKey,
  ): {
    limit: number;
    planKey: string;
    planVersion: number;
    fallback: boolean;
  } {
    const row = this.current(tenantId);
    return {
      limit: row?.limits[key] ?? DEFAULT_LIMITS[key],
      planKey: row?.planKey ?? "free",
      planVersion: row?.planVersion ?? 1,
      fallback: !row,
    };
  }
  feature(tenantId: string, key: FeatureKey): boolean {
    return this.current(tenantId)?.features[key] ?? false;
  }
  private current(tenantId: string): Entitlement | undefined {
    const row = this.rows.get(tenantId);
    if (!row || !this.feedFresh()) {
      this.onStale(tenantId);
      return undefined;
    }
    return row;
  }
}
export {
  decodeEntitlementEvent,
  decodeHeartbeat,
  InvalidEntitlementEvent,
  type Envelope,
} from "./event.js";
export { startEntitlementWorker, TOPIC, DLQ } from "./worker.js";
export {
  startEntitlementHeartbeat,
  HEARTBEAT_INTERVAL_MS,
} from "./heartbeat.js";
