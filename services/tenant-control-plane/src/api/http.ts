import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { UUID } from "../db/session.js";
import { InvalidInputError } from "../domain/errors.js";
import type { Actor, Command, HumanRole } from "../domain/store.js";
import { currentTraceparent } from "../trace.js";

export type ControlRequest = IncomingMessage & {
  actor?: Actor;
  correlationId?: string;
};

export class PreconditionRequiredError extends Error {
  constructor() {
    super(
      'If-Match with the current membership version is required, for example "3"',
    );
  }
}

function single(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return typeof raw === "string" ? raw : raw?.[0];
}

export function commandFrom(req: ControlRequest): Command {
  const key = single(req, "idempotency-key") ?? "";
  if (!/^[\x21-\x7e]{1,200}$/.test(key))
    throw new InvalidInputError(
      "Idempotency-Key header of 1-200 visible ASCII characters is required",
    );
  const correlationId = req.correlationId ?? randomUUID();
  return {
    idempotencyKey: key,
    correlationId,
    traceparent: currentTraceparent(),
  };
}

export function ifMatch(req: IncomingMessage): bigint {
  const value = single(req, "if-match");
  if (value === undefined) throw new PreconditionRequiredError();
  const version = /^"([1-9]\d{0,18})"$/.exec(value)?.[1];
  if (!version)
    throw new InvalidInputError(
      'If-Match must be a quoted version such as "3"',
    );
  return BigInt(version);
}

export function correlationOf(req: IncomingMessage): string {
  const supplied = single(req, "x-correlation-id");
  return supplied && UUID.test(supplied) ? supplied : randomUUID();
}

type Check = (value: unknown) => boolean;

// Bodies are closed: an unknown field (for example a smuggled tenant id) is a 400,
// so the tenant can only come from the verified identity and the path.
export function strictBody<T>(body: unknown, fields: Record<string, Check>): T {
  const input = (body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new InvalidInputError("body must be a JSON object");
  const unknown = Object.keys(input).filter((k) => !Object.hasOwn(fields, k));
  if (unknown.length > 0)
    throw new InvalidInputError(`unknown field(s): ${unknown.join(", ")}`);
  for (const [name, check] of Object.entries(fields))
    if (!check(input[name]))
      throw new InvalidInputError(`${name} is missing or invalid`);
  return input as T;
}

export const text =
  (max: number): Check =>
  (v) =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;
export const email: Check = (v) =>
  text(254)(v) && /^[^\s@]+@[^\s@]+$/.test(v as string);
export const humanRole: Check = (v) =>
  v === "viewer" || v === "operator" || v === "admin";
export type RoleBody = { role: HumanRole };
