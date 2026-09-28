import { createTokenVerifier, type VerifierOptions } from "@greenguard/tenant-auth";
import type { Principal } from "@greenguard/tenant-auth";

export interface FirstAdminTokenConfig {
  issuer: string;
  jwksUrl: string;
  audience?: string;
  tokenMode: "audience" | "cognito-access";
  clientIds?: string[];
}

// Validate a human access token with the same verifier contract used by BFF
// services. Temporary GreenGuard claims only satisfy Principal's shape; they
// are never persisted. Identity always comes from the verified iss/sub claims.
export async function verifyFirstAdminAccessToken(
  token: string,
  tenantId: string,
  config: FirstAdminTokenConfig,
  keys?: VerifierOptions["keys"],
): Promise<Principal> {
  if (!token || token.length > 16_384 || /\s/.test(token))
    throw new Error("A single OIDC access token is required on stdin");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tenantId))
    throw new Error("ENROLL_TENANT_ID must be a lowercase UUID");
  if (config.tokenMode === "audience" && !config.audience)
    throw new Error("OIDC audience is required for first-admin enrollment");
  if (config.tokenMode === "cognito-access" && !config.clientIds?.length)
    throw new Error("OIDC client ID allowlist is required for first-admin enrollment");

  const verifier = createTokenVerifier({
    issuer: config.issuer,
    audience: config.audience,
    tokenMode: config.tokenMode,
    cognitoClientIds: config.clientIds,
    keys: keys ?? { jwksUrl: config.jwksUrl },
    mapIdentity: (claims) => {
      const isClientCredentials =
        claims.grant_type === "client_credentials" ||
        claims.gty === "client-credentials" ||
        claims.principal_type === "service" ||
        (typeof claims.sub === "string" && claims.sub.endsWith("@clients"));
      return typeof claims.sub === "string" && claims.sub && !isClientCredentials
        ? { ...claims, tenant_id: tenantId, roles: ["admin"] }
        : undefined;
    },
  });
  return verifier.verify(`Bearer ${token}`);
}
