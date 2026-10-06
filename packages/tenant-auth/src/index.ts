import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export type Role = "viewer" | "operator" | "admin" | "device";

export interface Principal {
  issuer?: string;
  subject: string;
  tenantId: string;
  roles: Role[];
  expiresAt: Date;
  principalType?: "service";
  scopes?: string[];
  keyId?: string;
  deviceId?: string;
  email?: string;
  emailVerified?: boolean;
}

export type AuthErrorCode =
  | "missing_token"
  | "malformed_header"
  | "invalid_token"
  | "expired_token"
  | "invalid_claims"
  | "insufficient_role"
  | "auth_unavailable";

export class AuthError extends Error {
  readonly status: 401 | 403 | 503;
  readonly code: AuthErrorCode;

  constructor(status: 401 | 403 | 503, code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export interface VerifierOptions {
  issuer: string;
  audience?: string;
  // Cognito access tokens normally identify the public app in client_id rather
  // than aud. This opt-in mode is only for mapped human identities.
  tokenMode?: "audience" | "cognito-access";
  cognitoClientIds?: string[];
  keys:
    | {
        jwksUrl: string;
        cacheMaxAgeMs?: number;
        cooldownMs?: number;
        timeoutMs?: number;
      }
    | { getKey: JWTVerifyGetKey };
  clockToleranceSec?: number;
  now?: () => Date;
  // ADR-0014: when set, the IdP token proves identity only and this maps the
  // verified payload to GreenGuard claims (tenant_id, roles). Return undefined
  // for an identity with no membership.
  mapIdentity?: (payload: JWTPayload) => JWTPayload | undefined;
}

const DEFAULT_TIMEOUT_MS = 5000;

// A key server that is down, slow or answering non-200 says nothing about the token,
// so it must not look like a bad credential. Token faults are specific JOSE errors.
function isKeyServiceFailure(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    !(error instanceof errors.JOSEError) ||
    error.code === "ERR_JOSE_GENERIC"
  );
}

const ROLES: ReadonlySet<string> = new Set([
  "viewer",
  "operator",
  "admin",
  "device",
]);
const TENANT_ID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const BEARER = /^bearer (\S+)$/i;
const DEFAULT_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;
const DEFAULT_TOLERANCE_SEC = 30;

function extractToken(header: string | undefined): string {
  if (!header) {
    throw new AuthError(401, "missing_token");
  }
  const match = BEARER.exec(header);
  if (!match) {
    throw new AuthError(401, "malformed_header");
  }
  return match[1];
}

function toPrincipal(payload: JWTPayload): Principal {
  const {
    sub,
    tenant_id: tenantId,
    roles,
  } = payload as Record<string, unknown>;
  const validRoles =
    Array.isArray(roles) &&
    roles.length > 0 &&
    roles.every((r) => ROLES.has(r as string));
  const validTenant = typeof tenantId === "string" && TENANT_ID.test(tenantId);
  if (typeof sub !== "string" || sub === "" || !validTenant || !validRoles) {
    throw new AuthError(401, "invalid_claims");
  }
  return {
    subject: sub,
    tenantId,
    roles: [...new Set(roles as Role[])],
    expiresAt: new Date(Number(payload.exp) * 1000),
    email: typeof payload.email === "string" ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
  };
}

export function createTokenVerifier(options: VerifierOptions): {
  verify(authorizationHeader: string | undefined): Promise<Principal>;
} {
  const tokenMode = options.tokenMode ?? "audience";
  if (tokenMode === "audience" && !options.audience)
    throw new Error("audience is required for audience token mode");
  if (
    tokenMode === "cognito-access" &&
    (!options.mapIdentity ||
      !options.cognitoClientIds?.length ||
      options.cognitoClientIds.some((id) => !id || id.trim() !== id))
  )
    throw new Error("cognito-access requires mapped identity and client IDs");
  const { keys } = options;
  const getKey =
    "getKey" in keys
      ? keys.getKey
      : createRemoteJWKSet(new URL(keys.jwksUrl), {
          cacheMaxAge: keys.cacheMaxAgeMs ?? DEFAULT_CACHE_MS,
          cooldownDuration: keys.cooldownMs ?? DEFAULT_COOLDOWN_MS,
          timeoutDuration: keys.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
  const now = options.now ?? (() => new Date());

  return {
    async verify(authorizationHeader) {
      const token = extractToken(authorizationHeader);
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          algorithms: ["RS256"],
          issuer: options.issuer,
          audience: tokenMode === "audience" ? options.audience : undefined,
          clockTolerance: options.clockToleranceSec ?? DEFAULT_TOLERANCE_SEC,
          currentDate: now(),
          requiredClaims: ["exp"],
        }));
      } catch (error) {
        if (isKeyServiceFailure(error))
          throw new AuthError(503, "auth_unavailable");
        throw new AuthError(
          401,
          error instanceof errors.JWTExpired
            ? "expired_token"
            : "invalid_token",
        );
      }
      if (
        tokenMode === "cognito-access" &&
        (payload.token_use !== "access" ||
          typeof payload.client_id !== "string" ||
          !options.cognitoClientIds!.includes(payload.client_id) ||
          typeof payload.username !== "string" ||
          !payload.username ||
          typeof payload.auth_time !== "number" ||
          !Number.isFinite(payload.auth_time) ||
          payload.sub === payload.client_id ||
          payload.grant_type === "client_credentials" ||
          payload.gty === "client_credentials")
      )
        throw new AuthError(401, "invalid_token");
      if (tokenMode === "cognito-access" && payload.aud !== undefined) {
        const audiences = Array.isArray(payload.aud)
          ? payload.aud
          : [payload.aud];
        if (!options.audience || !audiences.includes(options.audience))
          throw new AuthError(401, "invalid_token");
      } else if (tokenMode === "cognito-access" && options.audience) {
        throw new AuthError(401, "invalid_token");
      }
      const claims = options.mapIdentity
        ? options.mapIdentity(payload)
        : payload;
      if (!claims) throw new AuthError(401, "invalid_claims");
      return { ...toPrincipal(claims), issuer: payload.iss };
    },
  };
}

export function requireRole(principal: Principal, ...allowed: Role[]): void {
  if (
    principal.principalType === "service" ||
    !principal.roles.some((role) => allowed.includes(role))
  ) {
    throw new AuthError(403, "insufficient_role");
  }
}

export {
  createTokenVerifierFromEnv,
  membershipMapper,
  parseMemberships,
  type Membership,
} from "./oidc.js";
