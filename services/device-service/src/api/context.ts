import { randomBytes, randomUUID } from "node:crypto";
import { isUuid } from "../db/tenant.js";
import {
  header,
  type ApiRequest,
  type ApiResponse,
  type NextFunction,
} from "./http.js";
import type { CommandContext } from "../inventory/repository.js";

const TRACEPARENT =
  /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-([0-9a-f]{2})$/;

const newTraceparent = () =>
  `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;

// Event contracts carry only the sampled bit, so other trace flags are dropped.
function sampledOnly(match: RegExpExecArray): string {
  const sampled = Number.parseInt(match[3], 16) & 1;
  return `00-${match[1]}-${match[2]}-${sampled ? "01" : "00"}`;
}

// A caller-supplied correlation ID or traceparent is kept only if well formed;
// otherwise a fresh one is generated so logs and outbox events always carry valid IDs.
export function correlationMiddleware(
  req: ApiRequest,
  res: ApiResponse,
  next: NextFunction,
): void {
  const supplied = header(req, "x-correlation-id");
  req.correlationId = supplied && isUuid(supplied) ? supplied : randomUUID();
  const match = TRACEPARENT.exec(header(req, "traceparent") ?? "");
  req.traceparent = match ? sampledOnly(match) : newTraceparent();
  res.setHeader("X-Correlation-Id", req.correlationId);
  next();
}

export function commandContext(
  req: Required<
    Pick<ApiRequest, "principal" | "correlationId" | "traceparent">
  >,
  idempotencyKey: string,
): CommandContext {
  return {
    tenantId: req.principal.tenantId,
    actorType: "user",
    actorId: req.principal.subject,
    correlationId: req.correlationId,
    traceparent: req.traceparent,
    idempotencyKey,
  };
}
