import { ArgumentsHost, Catch, HttpException } from "@nestjs/common";
import type { ServerResponse } from "node:http";
import { AuthError } from "@greenguard/tenant-auth";
import {
  AlertNotFoundError,
  IdempotencyConflictError,
  InvalidInputError,
  InvalidStateError,
  VersionConflictError,
} from "../alerts/errors.js";
import { InvalidTenantError, LockTimeoutError } from "../db/tenant.js";
import type { AlertRequest } from "./auth.js";
import { etag, PreconditionRequiredError } from "./parse.js";

export interface ProblemDetail {
  status: number;
  code: string;
  detail?: string;
  headers?: Record<string, string>;
}

type Rule = [new (...args: never[]) => Error, (e: Error) => ProblemDetail];

const fixed =
  (status: number, code: string, headers?: Record<string, string>) =>
  (e: Error): ProblemDetail => ({ status, code, detail: e.message, headers });

const RULES: Rule[] = [
  [
    AuthError,
    (e) => ({
      status: (e as AuthError).status,
      code: (e as AuthError).code,
      headers:
        (e as AuthError).status === 401
          ? { "WWW-Authenticate": "Bearer" }
          : undefined,
    }),
  ],
  [InvalidInputError, fixed(400, "invalid_request")],
  [InvalidTenantError, fixed(400, "invalid_request")],
  [AlertNotFoundError, fixed(404, "not_found")],
  [IdempotencyConflictError, fixed(409, "idempotency_conflict")],
  [InvalidStateError, fixed(409, "invalid_state")],
  [LockTimeoutError, fixed(409, "resource_locked", { "Retry-After": "1" })],
  [
    VersionConflictError,
    (e) => ({
      status: 412,
      code: "version_conflict",
      detail: e.message,
      headers: { ETag: etag((e as VersionConflictError).currentVersion) },
    }),
  ],
  [PreconditionRequiredError, fixed(428, "precondition_required")],
];

export function toProblem(error: unknown): ProblemDetail {
  const rule = RULES.find(([type]) => error instanceof type);
  if (rule) return rule[1](error as Error);
  if (error instanceof HttpException)
    return { status: error.getStatus(), code: "http_error" };
  return { status: 500, code: "internal_error" };
}

// Every response of this service is application/problem+json on failure.
@Catch()
export class ProblemJsonFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AlertRequest>();
    const res = http.getResponse<ServerResponse>();
    const problem = toProblem(error);
    if (problem.status === 500)
      console.error("workflow-alerts: unhandled error", (error as Error)?.name);
    res.statusCode = problem.status;
    res.setHeader("Content-Type", "application/problem+json");
    for (const [name, value] of Object.entries(problem.headers ?? {}))
      res.setHeader(name, value);
    res.end(
      JSON.stringify({
        type: "about:blank",
        status: problem.status,
        code: problem.code,
        ...(problem.detail && { detail: problem.detail }),
        correlation_id: req.correlationId,
      }),
    );
  }
}
