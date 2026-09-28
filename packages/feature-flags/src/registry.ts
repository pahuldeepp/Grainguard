/** Declared flag keys. Tenants may only set keys marked tenantSettable; global-only
 * keys (kill switches) are written by the platform credential alone. */
export const FLAG_REGISTRY: Readonly<
  Record<
    string,
    { type: "boolean" | "string" | "number"; tenantSettable: boolean }
  >
> = Object.freeze({
  "notifications.optional_sends": { type: "boolean", tenantSettable: true },
});

export type PoisonReason =
  "schema_invalid" | "key_mismatch" | "unknown_flag_key";

/** A deterministic, never-retryable flag event: quarantine it and move on. */
export class PoisonFlagEventError extends Error {
  constructor(
    readonly reason: PoisonReason,
    message: string,
  ) {
    super(message);
  }
}

type RuleShape = {
  value?: unknown;
  rolloutPercent?: unknown;
  locked?: unknown;
};

/** Shape validation shared by snapshots, the control plane and the consumer. */
export function validateRule(key: string, rule: unknown): void {
  const r = rule as RuleShape | null;
  if (!key || !r || typeof r !== "object") throw new Error("invalid flag rule");
  if (!["boolean", "string", "number"].includes(typeof r.value))
    throw new Error("invalid flag rule");
  if (typeof r.value === "number" && !Number.isFinite(r.value))
    throw new Error("invalid numeric flag");
  if (r.locked !== undefined && typeof r.locked !== "boolean")
    throw new Error("invalid locked marker");
  const p = r.rolloutPercent;
  if (
    p !== undefined &&
    (typeof r.value !== "boolean" ||
      typeof p !== "number" ||
      !Number.isFinite(p) ||
      p < 0 ||
      p > 100)
  )
    throw new Error("invalid rollout percentage");
}

/** Returns a problem description, or undefined when a tenant may set these flags. */
export function checkTenantFlags(
  flags: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const [key, raw] of Object.entries(flags)) {
    const entry = Object.hasOwn(FLAG_REGISTRY, key)
      ? FLAG_REGISTRY[key]
      : undefined;
    if (!entry?.tenantSettable) return `flag ${key} is not tenant-settable`;
    const rule = raw as RuleShape;
    if (typeof rule?.value !== entry.type)
      return `flag ${key} must be ${entry.type}`;
    if (rule.locked !== undefined) return `flag ${key}: locked is global-only`;
  }
  return undefined;
}
