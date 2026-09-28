import { createHmac, timingSafeEqual } from "node:crypto";
import { InvalidInputError } from "../alerts/errors.js";
import { isUuid } from "../db/tenant.js";
import { secret } from "./identity.js";

export const HISTORY_CURSOR = "ALERTS_HISTORY_CURSOR";
export type Include = "lifecycle" | "all";
export interface Position {
  version: string;
  occurredAt: string;
  transitionId: string;
}
interface Cursor extends Position {
  codec: 1;
  tenantId: string;
  alertId: string;
  include: Include;
}
const invalid = () => new InvalidInputError("invalid history cursor");

export class HistoryCursor {
  constructor(private readonly key: string) {
    secret(key, "ALERTS_HISTORY_CURSOR_KEY");
  }
  private sign(body: string) {
    return createHmac("sha256", this.key)
      .update(`greenguard.alerts.history.v1:${body}`)
      .digest();
  }
  encode(
    tenantId: string,
    alertId: string,
    include: Include,
    position: Position,
  ): string {
    const body = Buffer.from(
      JSON.stringify({ codec: 1, tenantId, alertId, include, ...position }),
    ).toString("base64url");
    return `${body}.${this.sign(body).toString("base64url")}`;
  }
  decode(
    value: string,
    tenantId: string,
    alertId: string,
    include: Include,
  ): Position {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)
    )
      throw invalid();
    const [body, signature] = value.split(".");
    if (!timingSafeEqual(this.sign(body), Buffer.from(signature, "base64url")))
      throw invalid();
    let parsed: Cursor;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw invalid();
    }
    if (
      !parsed ||
      parsed.codec !== 1 ||
      parsed.tenantId !== tenantId ||
      parsed.alertId !== alertId ||
      parsed.include !== include ||
      typeof parsed.version !== "string" ||
      !/^[1-9]\d{0,18}$/.test(parsed.version) ||
      BigInt(parsed.version) > 9223372036854775807n ||
      typeof parsed.occurredAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.occurredAt) ||
      !Number.isFinite(Date.parse(parsed.occurredAt)) ||
      !isUuid(parsed.transitionId)
    )
      throw invalid();
    return {
      version: parsed.version,
      occurredAt: parsed.occurredAt,
      transitionId: parsed.transitionId,
    };
  }
}

export function historyPage(limit?: string, include?: string) {
  const size = limit === undefined ? 50 : Number(limit);
  if (
    (limit !== undefined && !/^\d+$/.test(limit)) ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100
  )
    throw new InvalidInputError("limit must be an integer from 1 to 100");
  if (include !== undefined && include !== "lifecycle" && include !== "all")
    throw new InvalidInputError("include must be lifecycle or all");
  return { limit: size, include: (include ?? "lifecycle") as Include };
}

export function ruleIds(value?: string): string[] {
  const ids = typeof value === "string" ? value.split(",") : [];
  if (!ids.length || ids.length > 50 || ids.some((id) => !isUuid(id)))
    throw new InvalidInputError("ids must contain 1-50 lowercase UUIDs");
  return [...new Set(ids)];
}
