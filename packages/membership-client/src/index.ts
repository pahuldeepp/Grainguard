import {
  createTokenVerifier,
  createTokenVerifierFromEnv,
  type Principal,
  type VerifierOptions,
} from "@greenguard/tenant-auth";
import {
  createMembershipCache,
  LookupRequired,
  type LookupResult,
  type MembershipCache,
  type MembershipFetcher,
} from "./cache.js";
import type { MembershipVersionStore } from "./redis-versions.js";
export {
  createPlacementResolver,
  httpPlacementFetcher,
  validateTenantRoute,
  placementEpoch,
  PlacementError,
  MAX_ROUTE_TTL_MS,
  type TenantRoute,
} from "./placement.js";
export {
  suggestInitialShard,
  type InitialPlacementRing,
} from "./placement-ring.js";

export {
  createMembershipCache,
  type CacheOptions,
  type LookupResult,
  type MembershipCache,
  type MembershipChange,
  type MembershipFetcher,
} from "./cache.js";
export { identityKey, nameId } from "./ids.js";
export { startMembershipRuntime } from "./consumer.js";
export {
  createRedisMembershipVersionStore,
  type RedisVersionClient,
  type MembershipVersionStore,
} from "./redis-versions.js";

type Verify = (authorization: string | undefined) => Promise<Principal>;

// Verification order is unchanged (ADR-0014): @greenguard/tenant-auth checks the
// signature and claims before mapIdentity runs, so an unverified token never reaches
// the membership store.
export function createMembershipVerifier(
  options: Omit<VerifierOptions, "mapIdentity">,
  cache: MembershipCache,
): { verify: Verify } {
  const strict = createTokenVerifier({
    ...options,
    mapIdentity: cache.mapIdentity,
  });
  const afterLookup = createTokenVerifier({
    ...options,
    mapIdentity: cache.mapAfterLookup,
  });
  return {
    async verify(authorization) {
      try {
        return await strict.verify(authorization);
      } catch (error) {
        if (!(error instanceof LookupRequired)) throw error;
        await cache.load(error.issuer, error.subject);
        return afterLookup.verify(authorization);
      }
    },
  };
}

// Hook for a membership.changed consumer. Each verifier replica runs its own
// consumer group (broadcast), because the cache is per process (ADR-0017).
export function membershipChangedHandler(cache: MembershipCache) {
  return async (event: {
    event_type: string;
    tenant_id?: unknown;
    payload: Record<string, unknown>;
  }) => {
    if (
      !event ||
      typeof event !== "object" ||
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    )
      return;
    const { identity_id: identityId, membership_version: version } =
      event.payload;
    if (
      event.event_type !== "membership.changed" ||
      typeof event.tenant_id !== "string" ||
      !UUID.test(event.tenant_id)
    )
      return;
    if (
      typeof identityId !== "string" ||
      !UUID.test(identityId) ||
      typeof version !== "string" ||
      !/^[1-9]\d{0,18}$/.test(version) ||
      BigInt(version) > 9223372036854775807n
    )
      return;
    await cache.apply({
      tenantId: event.tenant_id,
      identityId,
      version: BigInt(version),
    });
  };
}

const ROLES = new Set(["viewer", "operator", "admin"]);
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

function parseLookup(body: unknown): LookupResult {
  const { tenantId, roles, version, state } = (body ?? {}) as Record<
    string,
    unknown
  >;
  const rolesOk =
    Array.isArray(roles) && roles.every((r) => ROLES.has(r as string));
  const shapeOk =
    state === "active"
      ? rolesOk && roles.length > 0
      : state === "revoked" && rolesOk && roles.length === 0;
  const idsOk =
    typeof tenantId === "string" &&
    UUID.test(tenantId) &&
    typeof version === "string" &&
    /^[1-9]\d{0,18}$/.test(version);
  if (!shapeOk || !idsOk) throw new Error("malformed membership response");
  return { tenantId, roles, version, state } as LookupResult;
}

export function httpMembershipFetcher(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): MembershipFetcher {
  const doFetch = options.fetch ?? fetch;
  return async (issuer, subject) => {
    const url = new URL("/v1/internal/memberships", options.baseUrl);
    url.search = new URLSearchParams({ issuer, subject }).toString();
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
    });
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`membership lookup answered ${res.status}`);
    return parseLookup(await res.json());
  };
}

type Getenv = (key: string) => string | undefined;

const need = (getenv: Getenv, key: string): string => {
  const value = getenv(key);
  if (!value)
    throw new Error(`${key} is required for the control-plane source`);
  return value;
};

// AUTH_MEMBERSHIP_SOURCE: "file" (default, unchanged behaviour) or "control-plane".
export function createVerifierFromEnv(
  getenv: Getenv,
  readFile: (path: string) => string,
  versionStore?: MembershipVersionStore,
): {
  verify: Verify;
  close(): void;
  onMembershipChanged?: ReturnType<typeof membershipChangedHandler>;
} {
  const source = getenv("AUTH_MEMBERSHIP_SOURCE") || "file";
  if (source === "file") return createTokenVerifierFromEnv(getenv, readFile);
  if (source !== "control-plane")
    throw new Error("AUTH_MEMBERSHIP_SOURCE must be file or control-plane");
  const rawTokenMode = getenv("AUTH_TOKEN_MODE") || "audience";
  if (rawTokenMode !== "audience" && rawTokenMode !== "cognito-access")
    throw new Error("AUTH_TOKEN_MODE must be audience or cognito-access");
  const cognitoClientIds = (getenv("AUTH_COGNITO_CLIENT_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (rawTokenMode === "cognito-access" && !cognitoClientIds.length)
    throw new Error("AUTH_COGNITO_CLIENT_IDS is required for cognito-access");
  const cache = createMembershipCache({
    versionStore,
    fetch: httpMembershipFetcher({
      baseUrl: need(getenv, "CONTROL_PLANE_URL"),
      token: need(getenv, "CONTROL_LOOKUP_TOKEN"),
    }),
  });
  const verifier = createMembershipVerifier(
    {
      issuer: need(getenv, "AUTH_ISSUER"),
      audience:
        rawTokenMode === "audience"
          ? need(getenv, "AUTH_AUDIENCE")
          : getenv("AUTH_AUDIENCE") || undefined,
      tokenMode: rawTokenMode,
      cognitoClientIds:
        rawTokenMode === "cognito-access" ? cognitoClientIds : undefined,
      keys: { jwksUrl: need(getenv, "AUTH_JWKS_URL") },
    },
    cache,
  );
  return {
    verify: verifier.verify,
    close: cache.clear,
    onMembershipChanged: membershipChangedHandler(cache),
  };
}
export {
  READ_BUDGET_HEADER,
  WATERMARK_REQUEST_HEADER,
  WATERMARK_RESPONSE_HEADER,
  WatermarkError,
  parseWatermark,
  serializeWatermark,
  type ProjectionWatermark,
} from "./watermark.js";
export {
  httpReadLeaseAuthority,
  type ReadAdmissionLease,
  type ReadLeaseAuthority,
  type ReadAdmissionOptions,
} from "./read-leases.js";
