import type { VersionedFlagStore, FlagChange, FlagRule } from "./index.js";
import {
  checkTenantFlags,
  FLAG_REGISTRY,
  PoisonFlagEventError,
  validateRule,
} from "./registry.js";
const GLOBAL_TENANT = "00000000-0000-4000-8000-000000000001";

/** Parses the CDC outbox envelope. Only complete tenant snapshots with valid versions
 * reach the cache; Kafka offsets must be committed after this call returns. */
export function applyFlagEvent(
  store: VersionedFlagStore,
  input: unknown,
  registry?: typeof FLAG_REGISTRY,
): boolean {
  const change = parseFlagEvent(input, registry);
  return change ? store.apply(change) : false;
}

const poison = (
  reason: PoisonFlagEventError["reason"],
  message: string,
): never => {
  throw new PoisonFlagEventError(reason, message);
};

function checkKeys(
  scope: "global" | "tenant",
  flags: Record<string, unknown>,
  registry: typeof FLAG_REGISTRY,
): void {
  for (const [key, rule] of Object.entries(flags)) {
    if (!Object.hasOwn(registry, key))
      poison("unknown_flag_key", `unknown flag ${key}`);
    try {
      validateRule(key, rule);
    } catch (error) {
      poison("schema_invalid", (error as Error).message);
    }
  }
  const problem = scope === "tenant" ? checkTenantFlags(flags) : undefined;
  if (problem) poison("unknown_flag_key", problem);
}

/** Parse and validate the canonical outbox envelope before persistence. Deterministic
 * defects throw PoisonFlagEventError (quarantine and commit past); other event types
 * return undefined. With a registry, unknown or non-tenant-settable keys are poison. */
export function parseFlagEvent(
  input: unknown,
  registry?: typeof FLAG_REGISTRY,
): FlagChange | undefined {
  const event = input as Record<string, unknown>;
  if (
    !event ||
    typeof event !== "object" ||
    event.event_type !== "flag.configuration_changed" ||
    event.schema_version !== 1
  )
    return undefined;
  const payload = event.payload as Record<string, unknown>;
  if (
    !payload ||
    (payload.scope !== "tenant" && payload.scope !== "global") ||
    typeof event.tenant_id !== "string" ||
    typeof payload.flags !== "object" ||
    payload.flags === null ||
    Array.isArray(payload.flags)
  )
    poison("schema_invalid", "invalid flag event");
  if ((payload.scope === "global") !== (event.tenant_id === GLOBAL_TENANT))
    poison("key_mismatch", "invalid global flag scope");
  const version = Number(payload.config_version);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    String(version) !== payload.config_version ||
    String(event.aggregate_version) !== payload.config_version
  )
    poison("schema_invalid", "invalid flag version");
  const flags = payload.flags as Record<string, FlagRule>;
  if (registry)
    checkKeys(payload.scope as "global" | "tenant", flags, registry);
  return payload.scope === "global"
    ? { scope: "global", version, flags }
    : { scope: "tenant", tenantId: event.tenant_id as string, version, flags };
}

/** Await durable projection before KafkaJS may commit the message offset. */
export async function applyDurableFlagEvent(
  store:
    | Pick<VersionedFlagStore, "apply">
    | { apply(change: FlagChange): Promise<boolean> },
  input: unknown,
): Promise<boolean> {
  const change = parseFlagEvent(input);
  return change ? await store.apply(change) : false;
}
