import { createHash, timingSafeEqual } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import { AuthError } from "@greenguard/tenant-auth";
import { type ControlRequest, correlationOf } from "./http.js";
import type { IdentityVerifier } from "./identity.js";

export const IDENTITY_VERIFIER = "CONTROL_IDENTITY_VERIFIER";
export const LOOKUP_TOKEN = "CONTROL_LOOKUP_TOKEN";

const requestOf = (context: ExecutionContext) =>
  context.switchToHttp().getRequest<ControlRequest>();

// End users: the verified IdP identity only; its memberships are read from the store.
@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    @Inject(IDENTITY_VERIFIER) private readonly verifier: IdentityVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = requestOf(context);
    req.correlationId = correlationOf(req);
    req.actor = await this.verifier.verify(req.headers.authorization);
    return true;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

// Services calling the membership lookup present a shared credential (mTLS and
// per-service identities arrive with Stage 12; ADR-0017). Constant-time compare.
@Injectable()
export class LookupGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(@Inject(LOOKUP_TOKEN) token: string) {
    this.expected = digest(token);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = requestOf(context);
    req.correlationId = correlationOf(req);
    const presented = /^Bearer (\S+)$/.exec(
      req.headers.authorization ?? "",
    )?.[1];
    if (!presented || !timingSafeEqual(digest(presented), this.expected))
      throw new AuthError(401, "invalid_token");
    return true;
  }
}
