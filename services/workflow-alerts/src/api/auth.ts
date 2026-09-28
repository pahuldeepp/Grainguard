import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { IncomingMessage } from "node:http";
import { annotateActiveSpan } from "@greenguard/otel";
import {
  AuthError,
  requireRole,
  type Principal,
  type Role,
} from "@greenguard/tenant-auth";

export const VERIFIER = "ALERTS_TOKEN_VERIFIER";

export type AlertPrincipal = Principal & { issuer: string };

export interface Verifier {
  verify(authorization: string | undefined): Promise<AlertPrincipal>;
  close?(): void;
}

export type AlertRequest = IncomingMessage & {
  principal?: AlertPrincipal;
  correlationId?: string;
  traceparent?: string;
};

// The tenant is taken from the verified token only; no header, path or body
// field can choose it.
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(VERIFIER) private readonly verifier: Verifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AlertRequest>();
    req.principal = await this.verifier.verify(req.headers.authorization);
    if (!req.principal.issuer) throw new AuthError(503, "auth_unavailable");
    // These claims are inspected only after signature/audience/issuer verification.
    // The shared user verifier omits grant metadata from Principal, so deny signed
    // machine grants here as well as principals explicitly marked as services.
    let claims: Record<string, unknown>;
    try {
      const token = req.headers.authorization!.split(" ")[1];
      claims = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
      );
      if (!claims || typeof claims !== "object" || Array.isArray(claims))
        throw new Error("invalid claims");
    } catch {
      throw new AuthError(401, "invalid_token");
    }
    const grant = claims.gty ?? claims.grant_type;
    if (
      grant === "client-credentials" ||
      grant === "client_credentials" ||
      claims.device_id
    )
      throw new AuthError(403, "insufficient_role");
    context
      .switchToHttp()
      .getResponse()
      .setHeader("Cache-Control", "private, no-store");
    annotateActiveSpan({ "greenguard.tenant_id": req.principal.tenantId });
    return true;
  }
}

export const READERS: Role[] = ["viewer", "operator", "admin"];
export const RESPONDERS: Role[] = ["operator", "admin"];

export function principalWith(
  req: AlertRequest,
  roles: Role[],
): AlertPrincipal {
  const principal = req.principal as AlertPrincipal;
  if (principal.deviceId || principal.roles.includes("device"))
    throw new AuthError(403, "insufficient_role");
  requireRole(principal, ...roles);
  return principal;
}
