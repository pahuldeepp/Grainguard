import { SeatLimitError, ApiKeyLimitError } from "../domain/entitlements.js";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import { AuthError } from "@greenguard/tenant-auth";
import { ResourceLockedError } from "../db/session.js";
import {
  AmbiguousMembershipError,
  DomainConflictError,
  IdempotencyConflictError,
  InvalidInputError,
  InvitationEmailMismatchError,
  InvitationUnusableError,
  LastAdminError,
  NotFoundError,
  RoleForbiddenError,
  VersionConflictError,
} from "../domain/errors.js";
import { type ControlRequest, PreconditionRequiredError } from "./http.js";
import { FlagPolicyError } from "../flags/store.js";
import { RateLimitedError } from "./rate-limited.js";
import { PlacementUnavailableError } from "../domain/placement.js";

export interface Problem {
  status: number;
  code: string;
  headers: Record<string, string>;
}

type ErrorClass = abstract new (...args: never[]) => Error;

const STATUS = new Map<ErrorClass, [number, string]>([
  [InvalidInputError, [400, "invalid_request"]],
  [PlacementUnavailableError, [503, "placement_unavailable"]],
  [DomainConflictError, [409, "resource_conflict"]],
  [FlagPolicyError, [422, "flag_not_allowed"]],
  [SeatLimitError, [409, "seat_limit"]],
  [ApiKeyLimitError, [403, "entitlement_exceeded"]],
  [RoleForbiddenError, [403, "insufficient_role"]],
  [NotFoundError, [404, "not_found"]],
  [IdempotencyConflictError, [409, "idempotency_conflict"]],
  [LastAdminError, [409, "last_admin"]],
  [AmbiguousMembershipError, [409, "ambiguous_membership"]],
  [ResourceLockedError, [409, "resource_locked"]],
  [InvitationEmailMismatchError, [403, "invitation_email_mismatch"]],
  [InvitationUnusableError, [410, "invitation_unusable"]],
  [RateLimitedError, [429, "rate_limited"]],
  [VersionConflictError, [412, "version_conflict"]],
  [PreconditionRequiredError, [428, "precondition_required"]],
]);

function extraHeaders(error: unknown): Record<string, string> {
  if (error instanceof VersionConflictError)
    return { ETag: `"${error.currentVersion}"` };
  if (error instanceof ResourceLockedError) return { "Retry-After": "1" };
  if (error instanceof RateLimitedError)
    return { "Retry-After": String(error.retryAfter) };
  if (error instanceof AuthError && error.status === 401)
    return { "WWW-Authenticate": "Bearer" };
  return {};
}

export function problemFor(error: unknown): Problem {
  const headers = extraHeaders(error);
  if (error instanceof AuthError)
    return { status: error.status, code: error.code, headers };
  for (const [type, [status, code]] of STATUS)
    if (error instanceof type) return { status, code, headers };
  if (error instanceof HttpException)
    return { status: error.getStatus(), code: "http_error", headers };
  return { status: 500, code: "internal_error", headers };
}

// RFC 9457 problem+json for every failure; details never echo identity values.
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const req = host.switchToHttp().getRequest<ControlRequest>();
    const res = host.switchToHttp().getResponse<ServerResponse>();
    const problem = problemFor(error);
    if (problem.status === 500)
      console.error("tenant-control-plane: unhandled", (error as Error)?.name);
    res.writeHead(problem.status, {
      ...problem.headers,
      "Content-Type": "application/problem+json",
    });
    const detail =
      problem.status < 500 && error instanceof Error
        ? error.message
        : undefined;
    res.end(
      JSON.stringify({
        type: "about:blank",
        status: problem.status,
        code: problem.code,
        detail,
        correlation_id: req.correlationId,
      }),
    );
  }
}
