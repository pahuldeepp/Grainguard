import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";

export interface ServicePrincipalContext {
  tenant_id: string;
  principal_id: string;
  principal_type: "service";
  scopes: string[];
}
export interface ClientBinding {
  tenant_id: string;
  principal_id: string;
  scopes: string[];
}
export type ClientLookup = (
  issuer: string,
  clientId: string,
  tenantHint?: string,
) => Promise<ClientBinding | undefined>;
export interface ClientCredentialsOptions {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  getKey?: JWTVerifyGetKey;
  lookup: ClientLookup;
  /**
   * Optional claim naming the tenant the IdP minted this client's token for. When
   * set, the claim must be a UUID, it is passed to `lookup` as the tenant hint,
   * and the returned binding must be for that tenant (ADR-0020).
   */
  tenantClaim?: string;
  maxTokenAgeSeconds?: number;
  now?: () => Date;
}
export class ServiceAuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code: "invalid_token" | "insufficient_scope" | "auth_unavailable",
  ) {
    super(code);
  }
}
const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const SCOPE = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;
function tenantHintOf(
  payload: Record<string, unknown>,
  claim: string | undefined,
): string | undefined {
  if (!claim) return undefined;
  const value = payload[claim];
  if (typeof value !== "string" || !UUID.test(value))
    throw new ServiceAuthError(401, "invalid_token");
  return value;
}

function assertValidTokenClaims(
  payload: JWTPayload,
  now: number,
  maxAge: number,
): asserts payload is JWTPayload & { exp: number; iat: number; sub: string } {
  if (
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.iat > now + 30 ||
    payload.exp - payload.iat > maxAge ||
    payload.exp <= now ||
    typeof payload.sub !== "string" ||
    !payload.sub
  )
    throw new ServiceAuthError(401, "invalid_token");
}

function clientIdOf(payload: JWTPayload & { sub: string }): string {
  const clientId =
    typeof payload.azp === "string" && payload.azp ? payload.azp : payload.sub;
  const grant = payload.gty ?? payload.grant_type;
  if (
    (grant !== "client-credentials" && grant !== "client_credentials") ||
    (payload.sub !== clientId && payload.sub !== `${clientId}@clients`)
  )
    throw new ServiceAuthError(401, "invalid_token");
  return clientId;
}

function tokenScopesOf(payload: JWTPayload): string[] {
  const tokenScopes =
    typeof payload.scope === "string"
      ? payload.scope.split(" ").filter(Boolean)
      : [];
  if (
    !tokenScopes.length ||
    tokenScopes.some((scope) => !SCOPE.test(scope)) ||
    new Set(tokenScopes).size !== tokenScopes.length
  )
    throw new ServiceAuthError(401, "invalid_token");
  return tokenScopes;
}

function assertBinding(
  binding: ClientBinding | undefined,
  tenantClaim: string | undefined,
  tenantHint: string | undefined,
): asserts binding is ClientBinding {
  if (
    !binding ||
    !UUID.test(binding.tenant_id) ||
    !UUID.test(binding.principal_id) ||
    !Array.isArray(binding.scopes) ||
    (tenantClaim && binding.tenant_id !== tenantHint)
  )
    throw new ServiceAuthError(401, "invalid_token");
}

function assertAuthorizedScopes(
  tokenScopes: string[],
  binding: ClientBinding,
  requiredScopes: readonly string[],
): void {
  if (tokenScopes.some((scope) => !binding.scopes.includes(scope)))
    throw new ServiceAuthError(403, "insufficient_scope");
  if (requiredScopes.some((scope) => !tokenScopes.includes(scope)))
    throw new ServiceAuthError(403, "insufficient_scope");
}

export function createClientCredentialsVerifier(
  options: ClientCredentialsOptions,
) {
  if (
    !options.issuer ||
    !options.audience ||
    (!options.getKey && !options.jwksUrl)
  )
    throw new Error("issuer, audience and JWKS are required");
  const key =
    options.getKey ??
    createRemoteJWKSet(new URL(options.jwksUrl!), {
      timeoutDuration: 5000,
      cacheMaxAge: 600000,
      cooldownDuration: 30000,
    });
  const maxAge = options.maxTokenAgeSeconds ?? 900;
  if (maxAge < 1 || maxAge > 3600)
    throw new Error("max token age must be 1-3600 seconds");
  return {
    async verify(
      authorization: string | undefined,
      requiredScopes: readonly string[] = [],
    ): Promise<ServicePrincipalContext> {
      const token = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1];
      if (!token) throw new ServiceAuthError(401, "invalid_token");
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub"],
          currentDate: options.now?.(),
        }));
      } catch (error) {
        if (
          error instanceof errors.JWKSTimeout ||
          !(error instanceof errors.JOSEError) ||
          error.code === "ERR_JOSE_GENERIC"
        )
          throw new ServiceAuthError(503, "auth_unavailable");
        throw new ServiceAuthError(401, "invalid_token");
      }
      const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
      assertValidTokenClaims(payload, now, maxAge);
      // Auth0 client credentials uses sub=client_id@clients; azp is client_id.
      // A configured IdP may omit azp, in which case the exact subject is mapped.
      const clientId = clientIdOf(payload);
      const tokenScopes = tokenScopesOf(payload);
      const tenantHint = tenantHintOf(payload, options.tenantClaim);
      let binding;
      try {
        binding = await options.lookup(options.issuer, clientId, tenantHint);
      } catch {
        throw new ServiceAuthError(503, "auth_unavailable");
      }
      assertBinding(binding, options.tenantClaim, tenantHint);
      assertAuthorizedScopes(tokenScopes, binding, requiredScopes);
      return {
        tenant_id: binding.tenant_id,
        principal_id: binding.principal_id,
        principal_type: "service",
        scopes: tokenScopes,
      };
    },
  };
}
export function requireServiceScope(
  context: ServicePrincipalContext,
  scope: string,
  deviceId?: string,
): void {
  if (
    !context.scopes.includes(scope) ||
    (deviceId && "device_id" in context && context.device_id !== deviceId)
  )
    throw new ServiceAuthError(403, "insufficient_scope");
}
