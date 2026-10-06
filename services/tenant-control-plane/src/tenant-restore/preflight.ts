import { createHash } from "node:crypto";

/** Pure evidence gate only. Collectors must obtain these receipts through trusted
 * read-only adapters. Caller assertions are not authenticated capabilities; a
 * successful result never authorizes copying, ownership changes, or activation.
 * A later executor must reverify receipts and lock authority/owner state. */
export const INVENTORY_RESTORE_TABLES = [
  "audit_events",
  "bin_cables",
  "bin_occupancies",
  "bins",
  "cable_sensors",
  "command_receipts",
  "devices",
  "grain_lots",
  "inventory_import_state",
  "inventory_saga_receipts",
  "inventory_saga_result_outbox",
  "outbox_events",
  "sites",
  "tenant_entitlements",
  "tenants",
] as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
type RecordValue = Record<string, unknown>;
function record(value: unknown, keys: string[]): value is RecordValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function text(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function count(value: unknown): value is string {
  return text(value, decimal) && BigInt(value) <= 9223372036854775807n;
}
function epoch(value: unknown): value is string {
  return count(value) && value !== "0";
}
function timestamp(value: unknown): number {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    ? Date.parse(value)
    : NaN;
}
function fresh(value: unknown, now: number, maxAge: number): boolean {
  const time = timestamp(value);
  return Number.isFinite(time) && time <= now && now - time <= maxAge;
}
function identity(value: unknown): value is RecordValue {
  return (
    record(value, ["tenantId", "shardId", "incarnation", "epoch"]) &&
    text(value.tenantId, uuid) &&
    text(value.shardId, /^s[1-4]$/) &&
    text(value.incarnation, uuid) &&
    epoch(value.epoch)
  );
}
function sameIdentity(left: RecordValue, right: RecordValue): boolean {
  return ["tenantId", "shardId", "incarnation", "epoch"].every(
    (key) => left[key] === right[key],
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Local fixture identity scheme used by shards-local; not a substitute for
 * authenticated durable authority. Compare this result to authority explicitly. */
export function deriveLocalShardIncarnation(
  project: string,
  shard: string,
  systemIdentifier: string,
): string {
  if (
    !/^greenguard-sharding(?:-[a-z0-9-]+)?$/.test(project) ||
    !/^s[1-4]$/.test(shard) ||
    !/^[1-9][0-9]{0,19}$/.test(systemIdentifier)
  )
    throw new Error("invalid local physical identity");
  const hex = createHash("sha256")
    .update(`${project}/${shard}/${systemIdentifier}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export type RestoreBlocker =
  | "invalid_manifest"
  | "invalid_human_evidence"
  | "stale_or_changed_authority"
  | "missing_canonical_target"
  | "invalid_snapshot"
  | "destination_not_empty"
  | "source_not_fenced"
  | "source_not_preserved"
  | "cdc_deduplication_unproven";
export interface RestoreDecision {
  status: "blocked" | "ready_for_disposable_proof";
  executionAllowed: false;
  blockers: RestoreBlocker[];
  planSha256?: string;
}

/** Unknown input is intentionally validated at runtime; malformed/extra fields
 * fail closed and no payload, identifier, key, or raw error is returned. */
export function preflightInventoryRestore(
  input: unknown,
  now: number,
): RestoreDecision {
  const blockers: RestoreBlocker[] = [];
  const block = (code: RestoreBlocker) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  const result = (): RestoreDecision => ({
    status: blockers.length ? "blocked" : "ready_for_disposable_proof",
    executionAllowed: false,
    blockers,
    ...(!blockers.length
      ? {
          planSha256: createHash("sha256")
            .update(canonical(input))
            .digest("hex"),
        }
      : {}),
  });
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !record(input, [
      "version",
      "operationId",
      "actor",
      "authorityBefore",
      "authorityAfter",
      "source",
      "destination",
      "snapshot",
      "fence",
      "preservation",
      "effects",
    ]) ||
    input.version !== 1 ||
    !text(input.operationId, uuid)
  ) {
    block("invalid_manifest");
    return result();
  }
  const actor = input.actor;
  if (
    !record(actor, [
      "tenantId",
      "userId",
      "kind",
      "role",
      "membershipObservedAt",
    ]) ||
    !text(actor.tenantId, uuid) ||
    !text(actor.userId, uuid) ||
    actor.kind !== "human" ||
    actor.role !== "admin" ||
    !fresh(actor.membershipObservedAt, now, 2000)
  )
    block("invalid_human_evidence");
  const authority = (value: unknown): value is RecordValue =>
    record(value, ["identity", "state", "observedAt", "expiresAt"]) &&
    identity(value.identity) &&
    value.state === "active" &&
    fresh(value.observedAt, now, 2000) &&
    timestamp(value.expiresAt) > now &&
    timestamp(value.expiresAt) - timestamp(value.observedAt) <= 2000;
  const before = input.authorityBefore,
    after = input.authorityAfter;
  if (
    !authority(before) ||
    !authority(after) ||
    !sameIdentity(
      before.identity as RecordValue,
      after.identity as RecordValue,
    ) ||
    timestamp(after.observedAt) < timestamp(before.observedAt) ||
    !record(actor, [
      "tenantId",
      "userId",
      "kind",
      "role",
      "membershipObservedAt",
    ]) ||
    actor.tenantId !== (after.identity as RecordValue).tenantId
  ) {
    block("stale_or_changed_authority");
    return result();
  }
  for (const evidence of [
    input.destination,
    input.snapshot,
    input.fence,
    input.preservation,
    input.effects,
  ]) {
    if (
      !evidence ||
      typeof evidence !== "object" ||
      Array.isArray(evidence) ||
      timestamp((evidence as RecordValue).observedAt) <
        timestamp(before.observedAt) ||
      timestamp((evidence as RecordValue).observedAt) >
        timestamp(after.observedAt) ||
      !Number.isFinite(timestamp((evidence as RecordValue).observedAt))
    )
      block("stale_or_changed_authority");
  }
  const target = after.identity as RecordValue;
  if (
    !identity(input.source) ||
    input.source.tenantId !== target.tenantId ||
    input.source.shardId !== target.shardId ||
    input.source.epoch !== target.epoch ||
    input.source.incarnation === target.incarnation
  ) {
    block("invalid_manifest");
    return result();
  }
  const destination = input.destination;
  if (
    !record(destination, [
      "identity",
      "physicalSystemIdentifier",
      "physicalShardId",
      "composeProject",
      "observedAt",
      "schemaSha256",
      "ownershipAbsent",
      "tableCounts",
    ]) ||
    !identity(destination.identity) ||
    !sameIdentity(destination.identity, target) ||
    !text(destination.physicalSystemIdentifier, /^[1-9][0-9]{0,19}$/) ||
    destination.physicalShardId !== target.shardId ||
    !text(
      destination.composeProject,
      /^greenguard-sharding(?:-[a-z0-9-]+)?$/,
    ) ||
    !fresh(destination.observedAt, now, 2000) ||
    !text(destination.schemaSha256, digest)
  ) {
    block("missing_canonical_target");
  } else {
    const computed = deriveLocalShardIncarnation(
      destination.composeProject as string,
      destination.physicalShardId as string,
      destination.physicalSystemIdentifier as string,
    );
    if (computed !== target.incarnation) block("missing_canonical_target");
    if (
      destination.ownershipAbsent !== true ||
      !record(destination.tableCounts, [...INVENTORY_RESTORE_TABLES]) ||
      INVENTORY_RESTORE_TABLES.some(
        (table) => (destination.tableCounts as RecordValue)[table] !== "0",
      )
    )
      block("destination_not_empty");
  }
  const snapshot = input.snapshot;
  if (
    !record(snapshot, [
      "identity",
      "schemaSha256",
      "snapshotSha256",
      "observedAt",
      "tables",
    ]) ||
    !identity(snapshot.identity) ||
    !sameIdentity(snapshot.identity, input.source) ||
    !text(snapshot.schemaSha256, digest) ||
    !text(snapshot.snapshotSha256, digest) ||
    !fresh(snapshot.observedAt, now, 2000) ||
    !record(destination, [
      "identity",
      "physicalSystemIdentifier",
      "physicalShardId",
      "composeProject",
      "observedAt",
      "schemaSha256",
      "ownershipAbsent",
      "tableCounts",
    ]) ||
    snapshot.schemaSha256 !== destination.schemaSha256 ||
    !Array.isArray(snapshot.tables) ||
    snapshot.tables.length !== INVENTORY_RESTORE_TABLES.length ||
    snapshot.tables.some(
      (table, index) =>
        !record(table, ["name", "rowCount", "sha256"]) ||
        table.name !== INVENTORY_RESTORE_TABLES[index] ||
        !count(table.rowCount) ||
        !text(table.sha256, digest),
    )
  )
    block("invalid_snapshot");
  const bound = (value: unknown, fields: string[]) =>
    record(value, ["identity", "operationId", "observedAt", ...fields]) &&
    identity(value.identity) &&
    sameIdentity(value.identity, input.source as RecordValue) &&
    value.operationId === input.operationId &&
    fresh(value.observedAt, now, 2000);
  if (
    !bound(input.fence, ["state", "receiptSha256"]) ||
    (input.fence as RecordValue).state !== "fenced" ||
    !text((input.fence as RecordValue).receiptSha256, digest) ||
    !record(snapshot, [
      "identity",
      "schemaSha256",
      "snapshotSha256",
      "observedAt",
      "tables",
    ]) ||
    timestamp((input.fence as RecordValue).observedAt) >
      timestamp(snapshot.observedAt)
  )
    block("source_not_fenced");
  if (
    !bound(input.preservation, [
      "sourceRetained",
      "backupSha256",
      "snapshotSha256",
    ]) ||
    (input.preservation as RecordValue).sourceRetained !== true ||
    !text((input.preservation as RecordValue).backupSha256, digest) ||
    !record(snapshot, [
      "identity",
      "schemaSha256",
      "snapshotSha256",
      "observedAt",
      "tables",
    ]) ||
    (input.preservation as RecordValue).snapshotSha256 !==
      snapshot.snapshotSha256 ||
    timestamp((input.preservation as RecordValue).observedAt) <
      timestamp(snapshot.observedAt)
  )
    block("source_not_preserved");
  const effects = input.effects;
  if (
    !bound(effects, [
      "historyRows",
      "pendingSagaRows",
      "sourcePublishersFenced",
      "frontierSha256",
      "deduplicationReceiptSha256",
    ]) ||
    !count((effects as RecordValue).historyRows) ||
    (effects as RecordValue).pendingSagaRows !== "0" ||
    (effects as RecordValue).sourcePublishersFenced !== true ||
    !text((effects as RecordValue).frontierSha256, digest) ||
    !text((effects as RecordValue).deduplicationReceiptSha256, digest) ||
    !record(snapshot, [
      "identity",
      "schemaSha256",
      "snapshotSha256",
      "observedAt",
      "tables",
    ]) ||
    !Array.isArray(snapshot.tables) ||
    (effects as RecordValue).historyRows !==
      snapshot.tables.find(
        (table: RecordValue) => table?.name === "outbox_events",
      )?.rowCount
  )
    block("cdc_deduplication_unproven");
  return result();
}
