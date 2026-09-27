import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import {
  ServiceAuthError,
  type ClientBinding,
  type ServicePrincipalContext,
} from "@greenguard/tenant-auth/service-principals";
import type { ApiRequest } from "../api/http.js";

export const IMPORT_VERIFIER = "IMPORT_VERIFIER";
export interface ImportVerifier {
  verify(
    authorization: string | undefined,
    scopes: readonly string[],
  ): Promise<ServicePrincipalContext>;
}
export type ImportRequest = ApiRequest & {
  importPrincipal?: ServicePrincipalContext;
};

@Injectable()
export class ImportGuard implements CanActivate {
  constructor(
    @Inject(IMPORT_VERIFIER) private readonly verifier: ImportVerifier,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ImportRequest>();
    const principal = await this.verifier.verify(req.headers.authorization, [
      "inventory:import",
    ]);
    if (
      principal.principal_type !== "service" ||
      !principal.scopes.includes("inventory:import")
    )
      throw new ServiceAuthError(403, "insufficient_scope");
    req.importPrincipal = principal;
    return true;
  }
}

export function controlClientLookup(
  endpoint: string,
  lookupToken: string,
  fetcher: typeof fetch = fetch,
): (
  issuer: string,
  clientId: string,
  tenantHint?: string,
) => Promise<ClientBinding | undefined> {
  const url = new URL("/v1/internal/credentials/oauth-client/lookup", endpoint);
  return async (issuer, clientId, tenantHint) => {
    // The control plane requires a tenant hint to disambiguate clients. This
    // claim comes from the signed client-credentials token, never request JSON.
    if (!tenantHint) return undefined;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${lookupToken}`,
        },
        body: JSON.stringify({ issuer, clientId, tenantId: tenantHint }),
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
    } catch {
      throw new ServiceAuthError(503, "auth_unavailable");
    }
    if (response.status === 401 || response.status === 404) return undefined;
    if (!response.ok) throw new ServiceAuthError(503, "auth_unavailable");
    try {
      return (await response.json()) as ClientBinding;
    } catch {
      throw new ServiceAuthError(503, "auth_unavailable");
    }
  };
}
