import type { JWTPayload } from "jose";
import { AuthError, type Role } from "@greenguard/tenant-auth";
import { identityKey } from "./ids.js";
import type { MembershipVersionStore } from "./redis-versions.js";

// What the control plane answers for one identity: its single active membership, or
// the latest revoked one (so a revoked member gets 403, never a stale role).
export type LookupResult =
  | { tenantId: string; roles: Role[]; version: string; state: "active" }
  | { tenantId: string; roles: []; version: string; state: "revoked" };

export type MembershipFetcher = (
  issuer: string,
  subject: string,
) => Promise<LookupResult | null>;

export interface CacheOptions {
  fetch: MembershipFetcher;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxStaleMs?: number;
  now?: () => number;
  versionStore?: MembershipVersionStore;
}

export interface MembershipChange {
  tenantId: string;
  identityId: string;
  version: bigint;
}

interface Entry {
  result: LookupResult | null;
  fetchedAt: number;
}

// Thrown from the synchronous mapIdentity hook after the token is verified; the
// verifier loads the entry asynchronously and maps again.
export class LookupRequired extends Error {
  constructor(
    readonly issuer: string,
    readonly subject: string,
  ) {
    super("membership lookup required");
  }
}

function claimsFor(
  payload: JWTPayload,
  result: LookupResult | null,
): JWTPayload | undefined {
  if (!result) return undefined;
  if (result.state === "revoked") throw new AuthError(403, "insufficient_role");
  return { ...payload, tenant_id: result.tenantId, roles: result.roles };
}

export type MembershipCache = ReturnType<typeof createMembershipCache>;

// Per-process cache (ADR-0017): positive entries 30 s, negative 5 s, last good entry
// usable for 5 minutes of lookup failures, then deny. membership.changed events drop
// entries early; versions are monotonic per (tenant, identity), so a duplicate or
// older event is a no-op and an in-flight lookup older than a seen event is refused.
export function createMembershipCache(options: CacheOptions) {
  const positiveTtl = options.positiveTtlMs ?? 30_000;
  const negativeTtl = options.negativeTtlMs ?? 5_000;
  const maxStale = options.maxStaleMs ?? 300_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const pending = new Set<string>();
  const floors = new Map<string, Map<string, bigint>>();

  const floorOf = (key: string, tenantId: string) =>
    floors.get(key)?.get(tenantId) ?? 0n;
  const ttl = (entry: Entry) =>
    entry.result?.state === "active" ? positiveTtl : negativeTtl;
  const entryFor = (payload: JWTPayload) =>
    entries.get(identityKey(String(payload.iss), String(payload.sub)));

  async function store(
    key: string,
    result: LookupResult | null,
  ): Promise<void> {
    if (result) {
      const localFloor = floorOf(key, result.tenantId);
      const sharedFloor = options.versionStore
        ? await options.versionStore.floor(key, result.tenantId)
        : 0n;
      if (
        BigInt(result.version) < localFloor ||
        BigInt(result.version) < sharedFloor
      )
        throw new Error("lookup is older than an applied membership event");
    }
    entries.set(key, { result, fetchedAt: now() });
  }

  return {
    mapIdentity(payload: JWTPayload): JWTPayload | undefined {
      const entry = entryFor(payload);
      if (!entry || now() - entry.fetchedAt >= ttl(entry))
        throw new LookupRequired(String(payload.iss), String(payload.sub));
      return claimsFor(payload, entry.result);
    },
    mapAfterLookup(payload: JWTPayload): JWTPayload | undefined {
      const entry = entryFor(payload);
      if (!entry || now() - entry.fetchedAt >= maxStale) return undefined;
      return claimsFor(payload, entry.result);
    },
    async load(issuer: string, subject: string): Promise<void> {
      const key = identityKey(issuer, subject);
      pending.add(key);
      try {
        await store(key, await options.fetch(issuer, subject));
      } catch {
        // Never log identity identifiers; the stale bound decides access.
        console.error(
          "membership lookup failed or was stale; bounded last good entry applies",
        );
      } finally {
        pending.delete(key);
      }
    },
    async apply(change: MembershipChange): Promise<void> {
      // Local invalidation is immediate. Redis stores a monotonic floor for replicas
      // that miss the event and for delayed HTTP responses already in flight.
      const entry = entries.get(change.identityId);
      if (!entry && !pending.has(change.identityId)) {
        await options.versionStore?.advance(change);
        return;
      }
      const cached = entry?.result;
      if (
        change.version <= floorOf(change.identityId, change.tenantId) ||
        (cached?.tenantId === change.tenantId &&
          BigInt(cached.version) >= change.version)
      ) {
        await options.versionStore?.advance(change);
        return;
      }
      // A second tenant grant can make this identity ambiguous. The control
      // plane must resolve the whole identity again even when the cached
      // membership belonged to another tenant.
      entries.delete(change.identityId);
      const byTenant =
        floors.get(change.identityId) ?? new Map<string, bigint>();
      if (change.version > (byTenant.get(change.tenantId) ?? 0n))
        byTenant.set(change.tenantId, change.version);
      floors.set(change.identityId, byTenant);
      await options.versionStore?.advance(change);
    },
    size: () => entries.size,
    clear(): void {
      entries.clear();
      floors.clear();
    },
  };
}
