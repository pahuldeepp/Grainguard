import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { IncomingMessage } from "node:http";
import { annotateActiveSpan } from "@greenguard/otel";
import {
  requireRole,
  type Principal,
  type Role,
} from "@greenguard/tenant-auth";

export const VERIFIER = "ALERTS_TOKEN_VERIFIER";

export interface Verifier {
  verify(authorization: string | undefined): Promise<Principal>;
  close?(): void;
}

export type AlertRequest = IncomingMessage & {
  principal?: Principal;
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
    annotateActiveSpan({ "greenguard.tenant_id": req.principal.tenantId });
    return true;
  }
}

export const READERS: Role[] = ["viewer", "operator", "admin"];
export const RESPONDERS: Role[] = ["operator", "admin"];

export function principalWith(req: AlertRequest, roles: Role[]): Principal {
  const principal = req.principal as Principal;
  requireRole(principal, ...roles);
  return principal;
}
