import { PlacementError } from "@greenguard/membership-client";
import { ArgumentsHost, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { AuthError } from "@greenguard/tenant-auth";
import { ServiceAuthError } from "@greenguard/tenant-auth/service-principals";
import { LockNotAvailableError } from "../db/errors.js";
import {
  EntitlementExceededError,
  TenantProjectionUnavailableError,
} from "../inventory/entitlements.js";
import {
  DeviceNotFoundError,
  DeviceLookupAmbiguousError,
  DuplicateBinError,
  DuplicateSerialError,
  IdempotencyConflictError,
  InvalidInputError,
  InvalidReferenceError,
  VersionConflictError,
} from "../inventory/errors.js";
import { PreconditionRequiredError } from "./errors.js";
import { ImportConflictError } from "../import/admission.js";
import { CableNotFoundError } from "../inventory/cables.js";
import type { ApiRequest, ApiResponse } from "./http.js";

export interface Problem {
  status: number;
  code: string;
  title: string;
  detail?: string;
  headers?: Record<string, string>;
}

const AUTH_TITLES = {
  401: "Unauthorized",
  403: "Forbidden",
  503: "Service unavailable",
};
const AUTH_HEADERS: Record<number, Record<string, string>> = {
  401: { "WWW-Authenticate": "Bearer" },
  403: {},
  503: { "Retry-After": "5" },
};

export function classify(error: unknown): Problem {
  if (error instanceof PlacementError)
    return {
      status: 503,
      code: error.code,
      title: "Service unavailable",
      headers: { "Retry-After": "1" },
    };
  if (error instanceof ServiceAuthError) {
    return {
      status: error.status,
      code: error.code,
      title: AUTH_TITLES[error.status],
      headers: AUTH_HEADERS[error.status],
    };
  }
  if (error instanceof DeviceLookupAmbiguousError)
    return { status: 409, code: "device_lookup_ambiguous", title: "Conflict" };
  if (error instanceof AuthError) {
    return {
      status: error.status,
      code: error.code,
      title: AUTH_TITLES[error.status],
      headers: AUTH_HEADERS[error.status],
    };
  }
  if (error instanceof EntitlementExceededError)
    return {
      status: 403,
      code: "entitlement_exceeded",
      title: "Forbidden",
      detail: error.message,
    };
  if (error instanceof TenantProjectionUnavailableError)
    return {
      status: 503,
      code: error.code,
      title: "Service unavailable",
      headers: { "Retry-After": "5" },
    };
  if (error instanceof InvalidInputError)
    return {
      status: 400,
      code: "invalid_request",
      title: "Invalid request",
      detail: error.message,
    };
  if (error instanceof PreconditionRequiredError)
    return {
      status: 428,
      code: "precondition_required",
      title: "Precondition required",
      detail: error.message,
    };
  if (error instanceof VersionConflictError)
    return {
      status: 412,
      code: "version_conflict",
      title: "Precondition failed",
      detail: error.message,
      headers: { ETag: `"${error.currentVersion}"` },
    };
  if (error instanceof IdempotencyConflictError)
    return {
      status: 409,
      code: "idempotency_conflict",
      title: "Conflict",
      detail: error.message,
    };
  if (error instanceof ImportConflictError)
    return {
      status: 409,
      code: "import_conflict",
      title: "Conflict",
      detail: error.message,
    };
  if (
    error instanceof DuplicateSerialError ||
    error instanceof DuplicateBinError
  )
    return {
      status: 409,
      code: "duplicate_resource",
      title: "Conflict",
      detail: error.message,
    };
  if (error instanceof LockNotAvailableError)
    return {
      status: 409,
      code: "resource_locked",
      title: "Conflict",
      detail: "The resource is busy; retry shortly.",
      headers: { "Retry-After": "1" },
    };
  if (error instanceof InvalidReferenceError)
    return {
      status: 422,
      code: "invalid_reference",
      title: "Unprocessable request",
      detail: error.message,
    };
  if (
    error instanceof DeviceNotFoundError ||
    error instanceof CableNotFoundError
  )
    return { status: 404, code: "not_found", title: "Not found" };
  if (error instanceof HttpException)
    return {
      status: error.getStatus(),
      code: "http_error",
      title: "Request failed",
    };
  return { status: 500, code: "internal_error", title: "Internal error" };
}

// Only /v1 responses use problem+json; health probes keep their own bodies.
export class ProblemFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<ApiRequest>();
    if (!req.url?.startsWith("/v1")) return super.catch(exception, host);
    const problem = classify(exception);
    if (problem.status === 500)
      console.error(
        "device-service: unhandled request error",
        exception instanceof Error ? exception.name : typeof exception,
      );
    const res = http.getResponse<ApiResponse>();
    res.statusCode = problem.status;
    res.setHeader("Content-Type", "application/problem+json");
    for (const [name, value] of Object.entries(problem.headers ?? {}))
      res.setHeader(name, value);
    res.end(
      JSON.stringify({
        type: "about:blank",
        title: problem.title,
        status: problem.status,
        code: problem.code,
        ...(problem.detail && { detail: problem.detail }),
        correlation_id: req.correlationId,
      }),
    );
  }
}
