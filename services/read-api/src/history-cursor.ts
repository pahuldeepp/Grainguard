import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CURSOR_LENGTH = 2048;

export function requireHistoryCursorSecret(value: string | undefined): string {
  if (!value || Buffer.byteLength(value, "utf8") < 32)
    throw new Error(
      "READ_HISTORY_CURSOR_SECRET must contain at least 32 bytes",
    );
  return value;
}

export interface HistoryCursorContext {
  tenantId: string;
  deviceId: string;
  from: Date;
  to: Date;
  limit: number;
  hotStart: Date;
  placement?: {
    shardId: string;
    shardIncarnation: string;
    placementEpoch: string;
  };
}

export interface HistoryCursor extends HistoryCursorContext {
  after: { observedAt: Date; readingId: string };
  expiresAt: number;
}

function placementKey(value: HistoryCursorContext["placement"]): string | null {
  return value
    ? `${value.shardId}:${value.shardIncarnation}:${value.placementEpoch}`
    : null;
}

export function encodeHistoryCursor(
  context: HistoryCursorContext,
  after: { observedAt: Date; readingId: string },
  secret: string,
  now = Date.now(),
): string {
  const payload = {
    v: 1,
    tenantId: context.tenantId,
    deviceId: context.deviceId,
    from: context.from.toISOString(),
    to: context.to.toISOString(),
    limit: context.limit,
    hotStart: context.hotStart.toISOString(),
    placement: placementKey(context.placement),
    observedAt: after.observedAt.toISOString(),
    readingId: after.readingId,
    expiresAt: now + 15 * 60_000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function decodeHistoryCursor(
  token: string,
  expected: Omit<HistoryCursorContext, "hotStart">,
  secret: string,
  now = Date.now(),
): HistoryCursor {
  if (!token || token.length > MAX_CURSOR_LENGTH)
    throw new Error("invalid_cursor");
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    throw new Error("invalid_cursor");
  const [encoded, suppliedSignature] = parts as [string, string];
  const expectedSignature = createHmac("sha256", secret)
    .update(encoded)
    .digest();
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new Error("invalid_cursor");
  }
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  )
    throw new Error("invalid_cursor");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new Error("invalid_cursor");
  }
  const observedAt = new Date(String(value.observedAt));
  const from = new Date(String(value.from));
  const to = new Date(String(value.to));
  const hotStart = new Date(String(value.hotStart));
  const expiresAt = value.expiresAt;
  if (
    value.v !== 1 ||
    value.tenantId !== expected.tenantId ||
    value.deviceId !== expected.deviceId ||
    value.from !== expected.from.toISOString() ||
    value.to !== expected.to.toISOString() ||
    value.limit !== expected.limit ||
    value.placement !== placementKey(expected.placement) ||
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= now ||
    Number.isNaN(observedAt.getTime()) ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    Number.isNaN(hotStart.getTime()) ||
    observedAt < from ||
    observedAt >= to ||
    !UUID.test(String(value.readingId))
  )
    throw new Error("invalid_cursor");
  return {
    ...expected,
    from,
    to,
    hotStart,
    after: { observedAt, readingId: String(value.readingId) },
    expiresAt: expiresAt as number,
  };
}
