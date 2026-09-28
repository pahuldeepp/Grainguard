import { createHash, randomUUID } from "node:crypto";
import {
  OpenFeature,
  type EvaluationContext,
  type Provider,
  type ResolutionDetails,
} from "@openfeature/server-sdk";

export {
  createDynamoFlagSnapshotStore,
  DynamoFlagSnapshotStore,
} from "./dynamodb.js";

import { validateRule } from "./registry.js";

export {
  checkTenantFlags,
  FLAG_REGISTRY,
  PoisonFlagEventError,
  type PoisonReason,
} from "./registry.js";

export type FlagValue = boolean | string | number;
export type FlagDefinitions = Readonly<Record<string, FlagValue>>;
export type FlagRule = {
  value: FlagValue;
  /** Boolean true is served to this percentage of tenants, in stable tenant buckets. */
  rolloutPercent?: number;
  /** Global only: an authoritative kill switch that tenant snapshots cannot override. */
  locked?: boolean;
};
export type FlagSnapshot = {
  version: number;
  flags: Readonly<Record<string, FlagRule>>;
  loadedAt: number;
};
export type FlagChange = {
  scope: "global" | "tenant";
  tenantId?: string;
  version: number;
  flags: Readonly<Record<string, FlagRule>>;
};
export type VerifiedPrincipal = {
  tenantId: string;
  subject: string;
  roles: readonly string[];
};
export type FlagContext = {
  readonly tenantId: string;
  readonly plan?: string;
  readonly cell?: string;
  readonly role?: string;
};
export type FlagDecision<T extends FlagValue> = {
  value: T;
  reason: "configured" | "default";
  configVersion?: number;
};

const TENANT_ID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const CONTEXT = Symbol("verified flag context");
type InternalContext = FlagContext & { readonly [CONTEXT]: true };

/** Call only with the principal returned by the authentication verifier. */
export function contextFromVerifiedPrincipal(
  principal: VerifiedPrincipal,
  attributes: { plan?: string; cell?: string; role?: string } = {},
): FlagContext {
  if (!TENANT_ID.test(principal.tenantId) || !principal.subject) {
    throw new Error("invalid verified principal");
  }
  if (attributes.role && !principal.roles.includes(attributes.role)) {
    throw new Error("role is not held by verified principal");
  }
  return Object.freeze({
    tenantId: principal.tenantId,
    ...attributes,
    [CONTEXT]: true as const,
  });
}

function requireContext(
  context: FlagContext,
): asserts context is InternalContext {
  if ((context as InternalContext)[CONTEXT] !== true) {
    throw new Error("feature flags require verified principal context");
  }
}

function validateSnapshot(snapshot: FlagSnapshot): FlagSnapshot {
  if (
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 0 ||
    !Number.isFinite(snapshot.loadedAt)
  ) {
    throw new Error("invalid flag snapshot version or timestamp");
  }
  const flags: Record<string, FlagRule> = {};
  for (const [key, rule] of Object.entries(snapshot.flags)) {
    validateRule(key, rule);
    flags[key] = Object.freeze({ ...rule });
  }
  return Object.freeze({
    version: snapshot.version,
    loadedAt: snapshot.loadedAt,
    flags: Object.freeze(flags),
  });
}

function bucket(tenantId: string, key: string): number {
  const digest = createHash("sha256").update(`${key}\0${tenantId}`).digest();
  return (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

export class VersionedFlagStore {
  private global?: FlagSnapshot;
  private readonly tenants = new Map<string, FlagSnapshot>();
  private unavailable = false;

  constructor(
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
    private readonly onStale?: (scope: string) => void,
    private readonly maxTenants = 10_000,
  ) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0)
      throw new Error("maxAgeMs must be positive");
  }

  tenantCount(): number {
    return this.tenants.size;
  }

  /** LRU insert; entries far past the freshness window are dropped as well. */
  private putTenant(tenantId: string, snapshot: FlagSnapshot): void {
    this.tenants.delete(tenantId);
    this.tenants.set(tenantId, snapshot);
    const expiry = this.now() - this.maxAgeMs * 4;
    for (const [id, entry] of this.tenants) {
      if (this.tenants.size <= this.maxTenants && entry.loadedAt >= expiry)
        break;
      this.tenants.delete(id);
    }
  }

  /** Apply full, versioned snapshots from the control-plane change feed. */
  apply(change: FlagChange): boolean {
    if (
      change.scope === "tenant" &&
      (!change.tenantId || !TENANT_ID.test(change.tenantId))
    ) {
      throw new Error("tenant change requires a valid tenant ID");
    }
    if (change.scope === "global" && change.tenantId !== undefined)
      throw new Error("global change cannot carry tenant ID");
    const previous =
      change.scope === "global"
        ? this.global
        : this.tenants.get(change.tenantId!);
    if (previous && change.version <= previous.version) return false;
    const snapshot = validateSnapshot({
      version: change.version,
      flags: change.flags,
      loadedAt: this.now(),
    });
    if (change.scope === "global") this.global = snapshot;
    else this.putTenant(change.tenantId!, snapshot);
    return true;
  }

  /** A successful authoritative fetch can renew an unchanged version's freshness. */
  refresh(change: FlagChange): boolean {
    if (change.scope === "global" && change.tenantId !== undefined)
      throw new Error("global change cannot carry tenant ID");
    if (
      change.scope === "tenant" &&
      (!change.tenantId || !TENANT_ID.test(change.tenantId))
    )
      throw new Error("tenant change requires a valid tenant ID");
    const previous =
      change.scope === "global"
        ? this.global
        : this.tenants.get(change.tenantId ?? "");
    if (previous && change.version < previous.version) return false;
    if (previous && change.version === previous.version) {
      const checked = validateSnapshot({
        version: change.version,
        flags: change.flags,
        loadedAt: this.now(),
      });
      if (change.scope === "global") this.global = checked;
      else this.putTenant(change.tenantId!, checked);
      return true;
    }
    return this.apply(change);
  }

  /** Provider outage uses code defaults; a recovered provider may reuse fresh last-good state. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  resolve(
    tenantId: string,
    key: string,
    expectedType: string,
  ): { value: FlagValue; version: number } | undefined {
    if (this.unavailable) return undefined;
    const locked =
      this.global && this.fresh("global", this.global)
        ? this.global.flags[key]
        : undefined;
    const order: [string, FlagSnapshot | undefined][] = locked?.locked
      ? [["global", this.global]]
      : [
          [tenantId, this.touchTenant(tenantId)],
          ["global", this.global],
        ];
    for (const [scope, snapshot] of order) {
      if (!snapshot) continue;
      if (!this.fresh(scope, snapshot)) {
        if (scope === tenantId) return undefined;
        continue;
      }
      const rule = snapshot.flags[key];
      if (!rule) continue;
      if (typeof rule.value !== expectedType) return undefined;
      const value =
        rule.rolloutPercent === undefined
          ? rule.value
          : rule.value && bucket(tenantId, key) < rule.rolloutPercent;
      return { value, version: snapshot.version };
    }
    return undefined;
  }

  private touchTenant(tenantId: string): FlagSnapshot | undefined {
    const snapshot = this.tenants.get(tenantId);
    if (snapshot) {
      this.tenants.delete(tenantId);
      this.tenants.set(tenantId, snapshot);
    }
    return snapshot;
  }

  private fresh(scope: string, snapshot: FlagSnapshot): boolean {
    if (this.now() - snapshot.loadedAt <= this.maxAgeMs) return true;
    this.onStale?.(scope);
    return false;
  }
}

export class GreenGuardFlagProvider implements Provider {
  readonly metadata = { name: "greenguard-versioned-flags" };
  constructor(private readonly store: VersionedFlagStore) {}
  private resolve<T extends FlagValue>(
    key: string,
    fallback: T,
    context: EvaluationContext,
  ): ResolutionDetails<T> {
    const tenantId = context.tenantId;
    if (typeof tenantId !== "string" || !TENANT_ID.test(tenantId))
      throw new Error("missing verified tenant context");
    const result = this.store.resolve(tenantId, key, typeof fallback);
    if (!result) throw new Error("flag unavailable");
    return {
      value: result.value as T,
      reason: "STATIC",
      flagMetadata: { configVersion: result.version },
    };
  }
  async resolveBooleanEvaluation(
    key: string,
    fallback: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolve(key, fallback, context);
  }
  async resolveStringEvaluation(
    key: string,
    fallback: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    return this.resolve(key, fallback, context);
  }
  async resolveNumberEvaluation(
    key: string,
    fallback: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    return this.resolve(key, fallback, context);
  }
  async resolveObjectEvaluation<T>(): Promise<ResolutionDetails<T>> {
    throw new Error("object flags are unsupported");
  }
}

export function createFlagEvaluator<const D extends FlagDefinitions>(
  definitions: D,
  store: VersionedFlagStore,
) {
  const provider = new GreenGuardFlagProvider(store);
  const domain = `greenguard-flags-${randomUUID()}`;
  OpenFeature.setProvider(domain, provider);
  const client = OpenFeature.getClient(domain);
  return {
    async evaluate<K extends keyof D & string>(
      key: K,
      context: FlagContext,
    ): Promise<FlagDecision<D[K]>> {
      requireContext(context);
      if (!Object.hasOwn(definitions, key)) throw new Error("unknown flag");
      const fallback = definitions[key];
      const evaluationContext = {
        tenantId: context.tenantId,
        ...(context.plan ? { plan: context.plan } : {}),
        ...(context.cell ? { cell: context.cell } : {}),
        ...(context.role ? { role: context.role } : {}),
      };
      const details =
        typeof fallback === "boolean"
          ? await client.getBooleanDetails(key, fallback, evaluationContext)
          : typeof fallback === "string"
            ? await client.getStringDetails(key, fallback, evaluationContext)
            : await client.getNumberDetails(
                key,
                fallback as number,
                evaluationContext,
              );
      const configured =
        details.reason !== "ERROR" &&
        details.reason !== "DEFAULT" &&
        typeof details.value === typeof fallback;
      const version = details.flagMetadata?.configVersion;
      return {
        value: (configured ? details.value : fallback) as D[K],
        reason: configured ? "configured" : "default",
        ...(configured && typeof version === "number"
          ? { configVersion: version }
          : {}),
      };
    },
    async close(): Promise<void> {
      await OpenFeature.close();
    },
  };
}

/** Development fixture provider; production wiring must feed audited control-plane changes. */
export function staticFlagStore(
  flags: Readonly<Record<string, FlagRule>>,
  maxAgeMs = 60_000,
): VersionedFlagStore {
  const store = new VersionedFlagStore(maxAgeMs);
  store.apply({ scope: "global", version: 1, flags });
  return store;
}

export {
  applyDurableFlagEvent,
  applyFlagEvent,
  parseFlagEvent,
} from "./consumer.js";
