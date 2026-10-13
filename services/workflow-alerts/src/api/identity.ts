import { createHmac } from "node:crypto";
import type { AlertPrincipal } from "./auth.js";

export interface ActorDisplay {
  kind: "system" | "user";
  isYou: boolean;
  handle: string | null;
}
export const IDENTITY = "ALERTS_IDENTITY";

export function secret(value: string | undefined, name: string): string {
  if (!value || Buffer.byteLength(value) < 32)
    throw new Error(`${name} requires at least 32 bytes`);
  return value;
}

export class IdentityDisplay {
  constructor(private readonly key: string) {
    secret(key, "ALERTS_ACTOR_HMAC_KEY");
  }
  private digest(
    purpose: string,
    tenant: string,
    issuer: string,
    subject: string,
  ) {
    return createHmac("sha256", this.key)
      .update(JSON.stringify([purpose, tenant, issuer, subject]))
      .digest("hex");
  }
  audit(tenant: string, issuer: string, subject: string) {
    return this.digest("greenguard.alerts.audit.v1", tenant, issuer, subject);
  }
  actor(
    principal: AlertPrincipal,
    kind: "system" | "user",
    subject: string | null,
    issuer?: string | null,
  ): ActorDisplay {
    if (kind === "system") return { kind, isYou: false, handle: null };
    if (!subject || !issuer) return { kind, isYou: false, handle: null };
    return {
      kind,
      isYou: principal.issuer === issuer && principal.subject === subject,
      handle: this.digest(
        "greenguard.alerts.display.v1",
        principal.tenantId,
        issuer,
        subject,
      ).slice(0, 12),
    };
  }
}
