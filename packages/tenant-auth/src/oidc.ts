import type { JWTPayload } from "jose";
import { createTokenVerifier, type Role } from "./index.js";

// ADR-0014 (R4): the IdP authenticates; GreenGuard owns membership. A membership is
// keyed by `${iss}|${sub}` so the same subject at another issuer never matches.
export interface Membership {
  tenantId: string;
  roles: Role[];
}

const tenantPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseMemberships(json: string): Map<string, Membership> {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error("memberships must be an array");
  const result = new Map<string, Membership>();
  const entryIndexes = new Map<string, number>();
  for (const [index, entry] of parsed.entries()) {
    const { issuer, subject, tenantId, roles } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    if (
      typeof issuer !== "string" ||
      typeof subject !== "string" ||
      typeof tenantId !== "string" ||
      !Array.isArray(roles)
    ) {
      throw new TypeError(
        `membership entry ${index} needs issuer, subject, tenantId and roles`,
      );
    }
    if (tenantId.length !== 36 || !tenantPattern.test(tenantId)) {
      throw new TypeError(
        `membership entry ${index} needs a canonical lower-case UUID tenantId`,
      );
    }
    const validRoles = roles.map((role: unknown): Role => {
      if (
        role === "viewer" ||
        role === "operator" ||
        role === "admin" ||
        role === "device"
      )
        return role;
      throw new TypeError(`membership entry ${index} has an invalid role`);
    });
    const key = `${issuer}|${subject}`;
    const previousIndex = entryIndexes.get(key);
    if (previousIndex !== undefined) {
      throw new Error(
        `duplicate membership identity at entries ${previousIndex} and ${index}`,
      );
    }
    entryIndexes.set(key, index);
    result.set(key, { tenantId, roles: validRoles });
  }
  return result;
}

export function membershipMapper(memberships: Map<string, Membership>) {
  return (payload: JWTPayload): JWTPayload | undefined => {
    const membership = memberships.get(`${payload.iss}|${payload.sub}`);
    if (!membership) return undefined;
    // Any tenant_id or roles asserted by the IdP are overwritten, never trusted.
    return {
      ...payload,
      tenant_id: membership.tenantId,
      roles: membership.roles,
    };
  };
}

type Getenv = (key: string) => string | undefined;

function optionalNumber(getenv: Getenv, key: string): number | undefined {
  const raw = getenv(key);
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

function required(getenv: Getenv, key: string): string {
  const value = getenv(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

// Parse a complete replacement before publishing it; failed reads never mutate the map.
export function refreshableMemberships(
  read: () => string,
  refreshMs = 30_000,
  maxStaleMs = 300_000,
) {
  let mapper = membershipMapper(parseMemberships(read()));
  let lastSuccess = Date.now();
  let failed = false;
  const refresh = () => {
    try {
      const replacement = membershipMapper(parseMemberships(read()));
      mapper = replacement;
      lastSuccess = Date.now();
      failed = false;
    } catch {
      failed = true;
      // Do not log file contents or identity identifiers from parser errors.
      console.error(
        "membership refresh failed; last good map has bounded validity",
      );
    }
  };
  const timer = refreshMs > 0 ? setInterval(refresh, refreshMs) : undefined;
  timer?.unref();
  return {
    mapIdentity(payload: JWTPayload) {
      if (failed && Date.now() - lastSuccess >= maxStaleMs) {
        console.error(
          "membership map exceeded max stale; denying membership lookup",
        );
        return undefined;
      }
      return mapper(payload);
    },
    close() {
      clearInterval(timer);
    },
  };
}

export function createTokenVerifierFromEnv(
  getenv: Getenv,
  readFile: (path: string) => string,
) {
  const membershipFile = getenv("AUTH_MEMBERSHIP_FILE");
  const refreshMs =
    optionalNumber(getenv, "AUTH_MEMBERSHIP_REFRESH_MS") ?? 30_000;
  const maxStaleMs =
    optionalNumber(getenv, "AUTH_MEMBERSHIP_MAX_STALE_MS") ?? 300_000;
  if (refreshMs > 2_147_483_647 || (refreshMs > 0 && refreshMs < 1)) {
    throw new Error(
      "AUTH_MEMBERSHIP_REFRESH_MS must be 0 or between 1 and 2147483647",
    );
  }
  // Validate verifier configuration before starting a refresh timer.
  const verifierOptions = {
    issuer: required(getenv, "AUTH_ISSUER"),
    audience: required(getenv, "AUTH_AUDIENCE"),
    keys: {
      jwksUrl: required(getenv, "AUTH_JWKS_URL"),
      cacheMaxAgeMs: optionalNumber(getenv, "AUTH_JWKS_CACHE_MS"),
      cooldownMs: optionalNumber(getenv, "AUTH_JWKS_COOLDOWN_MS"),
    },
    clockToleranceSec: optionalNumber(getenv, "AUTH_CLOCK_TOLERANCE_SEC"),
  };
  const memberships = membershipFile
    ? refreshableMemberships(
        () => readFile(membershipFile),
        refreshMs,
        maxStaleMs,
      )
    : undefined;
  try {
    const verifier = createTokenVerifier({
      ...verifierOptions,
      mapIdentity: memberships?.mapIdentity,
    });
    return {
      ...verifier,
      close() {
        memberships?.close();
      },
    };
  } catch (error) {
    memberships?.close();
    throw error;
  }
}
