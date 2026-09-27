import { AuthError, type Principal } from "./index.js";

const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

function principalFromOwnerResponse(
  value: unknown,
  requiredScope: string,
): Principal {
  if (!value || typeof value !== "object")
    throw new AuthError(503, "auth_unavailable");
  const context = value as Record<string, unknown>;
  if (
    context.principal_type !== "service" ||
    typeof context.tenant_id !== "string" ||
    !UUID.test(context.tenant_id) ||
    typeof context.principal_id !== "string" ||
    !UUID.test(context.principal_id) ||
    !Array.isArray(context.scopes) ||
    !context.scopes.every((scope) => typeof scope === "string")
  )
    throw new AuthError(503, "auth_unavailable");
  const scopes = context.scopes as string[];
  if (!scopes.includes(requiredScope))
    throw new AuthError(403, "insufficient_role");
  if (
    context.key_id !== undefined &&
    (typeof context.key_id !== "string" || !UUID.test(context.key_id))
  )
    throw new AuthError(503, "auth_unavailable");
  if (
    context.device_id !== undefined &&
    (typeof context.device_id !== "string" || !UUID.test(context.device_id))
  )
    throw new AuthError(503, "auth_unavailable");
  return {
    subject: context.principal_id,
    tenantId: context.tenant_id,
    roles: [],
    expiresAt: new Date(Date.now() + 60_000),
    principalType: "service",
    scopes,
    ...(context.key_id && { keyId: context.key_id as string }),
    ...(context.device_id && { deviceId: context.device_id as string }),
  };
}

export interface MachineVerifierOptions {
  endpoint: string;
  lookupToken: string;
  fetcher?: typeof fetch;
}

// Claims are inspected only to select a verifier. The control plane verifies
// the signature, issuer, audience, grant, scope and first-party binding.
export function isMachineCredential(
  authorization: string | undefined,
): boolean {
  const token = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return false;
  if (token.startsWith("gg_")) return true;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1]!.length > 5464) return false;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    );
    return (
      !!claims &&
      typeof claims === "object" &&
      ("gty" in claims || "grant_type" in claims)
    );
  } catch {
    return false;
  }
}

export function createMachineControlPlaneVerifier(
  options: MachineVerifierOptions,
) {
  const endpoint = new URL(options.endpoint);
  if (
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      )) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    !options.lookupToken
  ) {
    throw new Error("invalid machine verifier configuration");
  }
  const fetcher = options.fetcher ?? fetch;
  return {
    async verify(
      authorization: string | undefined,
      requiredScope: string,
    ): Promise<Principal> {
      const token = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1];
      if (!token || !isMachineCredential(authorization))
        throw new AuthError(401, "invalid_token");
      const apiKey = token.startsWith("gg_");
      const path = apiKey
        ? "/v1/internal/credentials/api-key/verify"
        : "/v1/internal/credentials/oauth-token/verify";
      let response: Response;
      try {
        response = await fetcher(new URL(path, endpoint), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.lookupToken}`,
          },
          body: JSON.stringify(
            apiKey ? { key: token } : { token, requiredScope },
          ),
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        throw new AuthError(503, "auth_unavailable");
      }
      if (response.status === 401) throw new AuthError(401, "invalid_token");
      if (response.status === 403)
        throw new AuthError(403, "insufficient_role");
      if (!response.ok) throw new AuthError(503, "auth_unavailable");
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new AuthError(503, "auth_unavailable");
      }
      return principalFromOwnerResponse(value, requiredScope);
    },
  };
}

export function machineAwareVerifier(
  human: (authorization: string | undefined) => Promise<Principal>,
  machine: ReturnType<typeof createMachineControlPlaneVerifier> | undefined,
  requiredScope: string,
): (authorization: string | undefined) => Promise<Principal> {
  return async (authorization) => {
    if (!isMachineCredential(authorization)) return human(authorization);
    if (!machine) throw new AuthError(503, "auth_unavailable");
    return machine.verify(authorization, requiredScope);
  };
}
