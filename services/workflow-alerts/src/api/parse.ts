import { randomUUID } from "node:crypto";
import { InvalidInputError } from "../alerts/errors.js";
import type { Episode, EpisodeState } from "../alerts/policy.js";
import { currentTraceparent } from "../alerts/trace.js";
import { isUuid } from "../db/tenant.js";
import type { ActorDisplay } from "./identity.js";
import type { AlertRequest } from "./auth.js";

export class PreconditionRequiredError extends Error {
  constructor() {
    super("If-Match with the current alert version is required");
  }
}

const header = (req: AlertRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function idempotencyKey(req: AlertRequest): string {
  const key = header(req, "idempotency-key");
  if (!key || !/^[\x21-\x7e]{1,200}$/.test(key))
    throw new InvalidInputError(
      "Idempotency-Key must be 1-200 visible ASCII characters",
    );
  return key;
}

export function expectedVersion(req: AlertRequest): bigint {
  const value = header(req, "if-match");
  if (value === undefined) throw new PreconditionRequiredError();
  const match = /^"([1-9]\d{0,18})"$/.exec(value);
  if (!match) throw new InvalidInputError('If-Match must look like "3"');
  return BigInt(match[1]);
}

const STATES = new Set(["open", "acknowledged", "resolved"]);

export function page(limit?: string, after?: string, state?: string) {
  const size = limit === undefined ? 50 : Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > 200)
    throw new InvalidInputError("limit must be an integer from 1 to 200");
  if (after !== undefined && !isUuid(after))
    throw new InvalidInputError("after must be a lowercase UUID");
  if (state !== undefined && !STATES.has(state))
    throw new InvalidInputError("state must be open, acknowledged or resolved");
  return { limit: size, after, state: state as EpisodeState | undefined };
}

// Correlation and trace context for commands; malformed caller values are replaced.
export function correlate(req: AlertRequest): void {
  const supplied = header(req, "x-correlation-id");
  req.correlationId = isUuid(supplied) ? supplied : randomUUID();
  req.traceparent = currentTraceparent();
}

export const etag = (version: bigint | string) => `"${version}"`;

export const toAlertDto = (e: Episode, actor: ActorDisplay) => ({
  alertId: e.episodeId,
  ruleId: e.ruleId,
  binId: e.resourceId,
  state: e.state,
  severity: e.severity,
  score: e.score,
  version: e.version.toString(),
  openWindowStart: e.openWindowStart.toISOString(),
  openedAt: e.openedAt.toISOString(),
  acknowledgedAt: e.acknowledgedAt?.toISOString() ?? null,
  acknowledgedBy: !e.acknowledgedBy
    ? null
    : actor.isYou
      ? "you"
      : actor.handle
        ? `member-${actor.handle}`
        : "team-member",
  actor,
  escalatedAt: e.escalatedAt?.toISOString() ?? null,
  resolvedAt: e.resolvedAt?.toISOString() ?? null,
  escalationLevel: e.escalationLevel,
});
