import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { annotateActiveSpan } from "@greenguard/otel";
import type { Principal } from "@greenguard/tenant-auth";
import type { ApiRequest } from "./http.js";

export const TOKEN_VERIFIER = "TOKEN_VERIFIER";

export interface TokenVerifier {
  verify(authorizationHeader: string | undefined): Promise<Principal>;
}

// The tenant comes only from the verified token; no header or body field can select one.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    req.principal = await this.verifier.verify(req.headers.authorization);
    annotateActiveSpan({ "greenguard.tenant_id": req.principal.tenantId });
    return true;
  }
}
