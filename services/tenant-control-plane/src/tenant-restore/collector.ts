import { createHash } from "node:crypto";
import type { Principal } from "@greenguard/tenant-auth";
import {
  validateTenantRoute,
  type TenantRoute,
} from "@greenguard/membership-client";
import { INVENTORY_RESTORE_TABLES } from "./preflight.js";
export interface TableObservation {
  name: string;
  rowCount: string;
  sha256: string;
}
export interface StorageObservation {
  label: "legacy" | "s1" | "s2" | "s3" | "s4";
  physicalShardId: string | null;
  physicalIncarnation: string | null;
  ownership: {
    shardId: string;
    incarnation: string;
    epoch: string;
    state: string;
  } | null;
  schemaSha256: string;
  migrationChecksumsVerified: boolean;
  forceRlsVerified: boolean;
  tables: TableObservation[];
  snapshotSha256: string;
  pendingSagaRows: string;
}
/** Trusted runtime adapters, not caller-submitted evidence. verifyFresh must
 * instantiate/clear the membership cache and use authenticated control authority.
 * readStorage must use an explicit tenant filter inside a read-only transaction.
 * No function on this contract may copy, fence, activate, or change authority. */
export interface RestoreEvidenceAdapters {
  membershipSource: "control-plane";
  verifyFresh(): Promise<Principal>;
  resolveAuthority(tenantId: string): Promise<TenantRoute>;
  readStorage(tenantId: string): Promise<StorageObservation[]>;
  now(): number;
}
export interface CollectedRestoreEvidence {
  version: 1;
  status: "blocked";
  executionAllowed: false;
  blockers: string[];
  freshControlPlaneMembershipVerified: boolean;
  authorityStable: boolean;
  manifestSha256?: string;
  storage: {
    label: StorageObservation["label"];
    canonicalTarget: boolean;
    ownershipMatchesAuthority: boolean;
    ownershipState: string | null;
    schemaSha256: string;
    snapshotSha256: string;
    tables: TableObservation[];
    pendingSagaRows: string;
    migrationChecksumsVerified: boolean;
    forceRlsVerified: boolean;
  }[];
  unmeasured: readonly string[];
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const count = /^(0|[1-9][0-9]{0,18})$/;
function human(p: Principal, now: number) {
  return (
    uuid.test(p.tenantId) &&
    !!p.issuer &&
    !!p.subject &&
    p.principalType !== "service" &&
    !p.deviceId &&
    !p.roles.includes("device") &&
    p.roles.includes("admin") &&
    p.expiresAt instanceof Date &&
    p.expiresAt.getTime() > now
  );
}
function sameHuman(a: Principal, b: Principal) {
  return (
    a.tenantId === b.tenantId &&
    a.issuer === b.issuer &&
    a.subject === b.subject
  );
}
function sameRoute(a: TenantRoute, b: TenantRoute) {
  return (
    a.tenantId === b.tenantId &&
    a.shardId === b.shardId &&
    a.shardIncarnation === b.shardIncarnation &&
    a.placementEpoch === b.placementEpoch &&
    a.state === b.state
  );
}
function validStorage(s: StorageObservation) {
  return (
    ["legacy", "s1", "s2", "s3", "s4"].includes(s.label) &&
    sha.test(s.schemaSha256) &&
    sha.test(s.snapshotSha256) &&
    count.test(s.pendingSagaRows) &&
    (!s.ownership ||
      ["active", "quiescing", "fenced", "prepared"].includes(
        s.ownership.state,
      )) &&
    s.tables.length === INVENTORY_RESTORE_TABLES.length &&
    s.tables.every(
      (t, i) =>
        t.name === INVENTORY_RESTORE_TABLES[i] &&
        count.test(t.rowCount) &&
        sha.test(t.sha256),
    )
  );
}
/** Metadata-only collector. Success still reports blocked because current
 * adapters do not measure signed fencing, retained backups or Kafka frontiers. */
export async function collectRestoreEvidence(
  adapters: RestoreEvidenceAdapters,
): Promise<CollectedRestoreEvidence> {
  const result: CollectedRestoreEvidence = {
    version: 1,
    status: "blocked",
    executionAllowed: false,
    blockers: [],
    freshControlPlaneMembershipVerified: false,
    authorityStable: false,
    storage: [],
    unmeasured: [
      "source_publisher_fence",
      "retained_backup",
      "kafka_cdc_frontier",
      "deduplication_restore_receipt",
      "production_restore_capability",
    ],
  };
  try {
    if (adapters.membershipSource !== "control-plane")
      throw new Error("trusted membership required");
    const beforeHuman = await adapters.verifyFresh();
    if (!human(beforeHuman, adapters.now()))
      throw new Error("verified human admin required");
    const before = validateTenantRoute(
      await adapters.resolveAuthority(beforeHuman.tenantId),
      beforeHuman.tenantId,
      adapters.now(),
    );
    if (before.state !== "active") throw new Error("active authority required");
    const storage = await adapters.readStorage(beforeHuman.tenantId);
    if (
      storage.length !== 5 ||
      new Set(storage.map((s) => s.label)).size !== 5 ||
      storage.some((s) => !validStorage(s))
    )
      throw new Error("invalid storage evidence");
    const afterHuman = await adapters.verifyFresh();
    if (
      !human(afterHuman, adapters.now()) ||
      !sameHuman(beforeHuman, afterHuman)
    )
      throw new Error("membership changed");
    const after = validateTenantRoute(
      await adapters.resolveAuthority(afterHuman.tenantId),
      afterHuman.tenantId,
      adapters.now(),
    );
    result.freshControlPlaneMembershipVerified = true;
    result.authorityStable =
      sameRoute(before, after) && after.state === "active";
    if (!result.authorityStable) {
      result.blockers.push("stale_or_changed_authority");
      return result;
    }
    result.storage = storage.map((s) => ({
      label: s.label,
      canonicalTarget:
        s.label !== "legacy" &&
        s.physicalShardId === after.shardId &&
        s.physicalIncarnation === after.shardIncarnation,
      ownershipMatchesAuthority:
        !!s.ownership &&
        s.ownership.shardId === after.shardId &&
        s.ownership.incarnation === after.shardIncarnation &&
        s.ownership.epoch === after.placementEpoch,
      ownershipState: s.ownership?.state ?? null,
      schemaSha256: s.schemaSha256,
      snapshotSha256: s.snapshotSha256,
      tables: s.tables.map((t) => ({
        name: t.name,
        rowCount: t.rowCount,
        sha256: t.sha256,
      })),
      pendingSagaRows: s.pendingSagaRows,
      migrationChecksumsVerified: s.migrationChecksumsVerified,
      forceRlsVerified: s.forceRlsVerified,
    }));
    if (!result.storage.some((s) => s.canonicalTarget))
      result.blockers.push("missing_canonical_target");
    if (
      result.storage.some(
        (s) => !s.migrationChecksumsVerified || !s.forceRlsVerified,
      )
    )
      result.blockers.push("owner_schema_not_verified");
    result.blockers.push("restore_prerequisites_unmeasured");
    // Identity is bound to the manifest privately through a one-way digest. No
    // tokens, principal identifiers, physical IDs or tenant payloads are returned.
    result.manifestSha256 = hash({
      tenantId: afterHuman.tenantId,
      issuer: afterHuman.issuer,
      subject: afterHuman.subject,
      route: after,
      storage: result.storage,
    });
  } catch {
    result.storage = [];
    result.blockers = ["trusted_collection_failed"];
  }
  return result;
}
