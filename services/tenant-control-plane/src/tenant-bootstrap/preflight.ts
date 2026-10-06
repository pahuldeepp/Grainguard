import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";

/**
 * Repository-owned bootstrap contract inventory. The database names are the
 * operational owner databases from infra/gitops/disposable/owner-migration-
 * inventory.json. The ownership SQL contract version is a capability marker,
 * not a service migration fingerprint. Null service ledger fingerprint / adapter
 * means the owner still lacks a reviewed readiness verifier. The adapter and
 * migration fingerprint are verified at runtime from repository-owned SQL and
 * migration-ledger probes, never from a request or caller-supplied assertion.
 */
export const TENANT_BOOTSTRAP_OWNER_CONTRACTS = Object.freeze({
  telemetry: Object.freeze({
    database: "greenguard_telemetry",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  projection: Object.freeze({
    database: "greenguard_read",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  jobs: Object.freeze({
    database: "greenguard_jobs",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  saga: Object.freeze({
    database: "greenguard_sagas",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  hardware: Object.freeze({
    database: "greenguard_hardware",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  inventory: Object.freeze({
    database: "greenguard_inventory",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  alerts: Object.freeze({
    database: "greenguard_alerts",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  risk: Object.freeze({
    database: "greenguard_risk",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
  notifications: Object.freeze({
    database: "greenguard_notifications",
    ownershipContractVersion: "tenant-ownership-bootstrap-v2",
    adapter: "repository-direct-sql",
  }),
} as const);

const CONTRACT_OWNERS = Object.keys(TENANT_BOOTSTRAP_OWNER_CONTRACTS).sort();
if (
  CONTRACT_OWNERS.length !== SHARDED_MOVE_OWNERS.length ||
  SHARDED_MOVE_OWNERS.some(
    (owner) => !(owner in TENANT_BOOTSTRAP_OWNER_CONTRACTS),
  )
)
  throw new Error(
    "tenant bootstrap owner contracts do not match the sharded owner roster",
  );

export type TenantBootstrapOwner =
  keyof typeof TENANT_BOOTSTRAP_OWNER_CONTRACTS;

/** Names owners that lack repository-reviewed, concrete DB verifiers. */
export function unavailableTenantBootstrapOwners(): readonly TenantBootstrapOwner[] {
  return SHARDED_MOVE_OWNERS.filter((owner) => {
    const contract = TENANT_BOOTSTRAP_OWNER_CONTRACTS[owner];
    return contract.adapter === null;
  });
}

/** Runtime identity for a greenfield tenant and its selected operational shard. */
export interface TenantBootstrapPlacement {
  tenantId: string;
  shardId: string;
  shardIncarnation: string;
  placementEpoch: string;
}

export interface TenantBootstrapOwnerAdapter {
  owner: (typeof SHARDED_MOVE_OWNERS)[number];
  prepareTenantOwnership: (
    placement: TenantBootstrapPlacement,
  ) => Promise<unknown>;
  verifyTenantOwnership: (
    placement: TenantBootstrapPlacement,
    phase?: "prepared" | "active",
  ) => Promise<TenantBootstrapOwnerProof>;
  activateTenantOwnership: (
    placement: TenantBootstrapPlacement,
  ) => Promise<unknown>;
}

export interface TenantBootstrapOwnerReadiness {
  owner: (typeof SHARDED_MOVE_OWNERS)[number];
  shardId: string;
  shardIncarnation: string;
  status: "ready";
  ownershipContractVersion: string;
  /** Must come from the owner's actual migration ledger verifier. */
  serviceMigrationFingerprint: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
export const TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION =
  "tenant-ownership-bootstrap-v2" as const;
const SHARD = /^s[1-4]$/;
const TENANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EPOCH = /^[1-9][0-9]{0,18}$/;

function validPlacement(placement: TenantBootstrapPlacement): boolean {
  if (
    !placement ||
    !TENANT_ID.test(placement.tenantId) ||
    !SHARD.test(placement.shardId) ||
    !UUID.test(placement.shardIncarnation) ||
    !EPOCH.test(placement.placementEpoch)
  )
    return false;
  return BigInt(placement.placementEpoch) <= 9223372036854775807n;
}

export class TenantBootstrapPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantBootstrapPreflightError";
  }
}

/** Validate adapter shape and exact owner coverage without invoking adapters. */
export function requireCompleteBootstrapAdapters(
  adapters: readonly TenantBootstrapOwnerAdapter[],
): ReadonlyMap<
  TenantBootstrapOwnerAdapter["owner"],
  TenantBootstrapOwnerAdapter
> {
  if (
    !Array.isArray(adapters) ||
    adapters.length !== SHARDED_MOVE_OWNERS.length
  )
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap requires exactly one adapter for every sharded owner",
    );

  const byOwner = new Map<
    TenantBootstrapOwnerAdapter["owner"],
    TenantBootstrapOwnerAdapter
  >();
  for (const adapter of adapters) {
    if (
      !adapter ||
      !SHARDED_MOVE_OWNERS.includes(adapter.owner) ||
      byOwner.has(adapter.owner) ||
      typeof adapter.prepareTenantOwnership !== "function" ||
      typeof adapter.verifyTenantOwnership !== "function" ||
      typeof adapter.activateTenantOwnership !== "function"
    )
      throw new TenantBootstrapPreflightError(
        "tenant bootstrap adapter roster is duplicate, unknown, or incomplete",
      );
    byOwner.set(adapter.owner, adapter);
  }
  if (SHARDED_MOVE_OWNERS.some((owner) => !byOwner.has(owner)))
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap owner adapter is missing",
    );
  return byOwner;
}

/**
 * Validate shape and owner-specific contract identity. This is structural
 * validation only: readiness objects supplied by a caller are not trusted
 * probes and cannot authorize tenant activation.
 */
export function requireReadyShardOwners(
  placement: TenantBootstrapPlacement,
  readiness: readonly TenantBootstrapOwnerReadiness[],
): void {
  if (!validPlacement(placement))
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap placement identity is invalid",
    );
  if (
    !Array.isArray(readiness) ||
    readiness.length !== SHARDED_MOVE_OWNERS.length
  )
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap requires direct readiness proof from every owner",
    );

  const byOwner = new Map<string, TenantBootstrapOwnerReadiness>();
  for (const proof of readiness) {
    if (
      !proof ||
      !SHARDED_MOVE_OWNERS.includes(proof.owner) ||
      byOwner.has(proof.owner) ||
      proof.status !== "ready" ||
      proof.shardId !== placement.shardId ||
      proof.shardIncarnation !== placement.shardIncarnation ||
      proof.ownershipContractVersion !==
        TENANT_BOOTSTRAP_OWNER_CONTRACTS[proof.owner as TenantBootstrapOwner]
          .ownershipContractVersion ||
      proof.ownershipContractVersion !==
        TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION ||
      !SHA256.test(proof.serviceMigrationFingerprint)
    )
      throw new TenantBootstrapPreflightError(
        "tenant bootstrap shard readiness proof is invalid or stale",
      );
    byOwner.set(proof.owner, proof);
  }
  if (SHARDED_MOVE_OWNERS.some((owner) => !byOwner.has(owner)))
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap owner readiness proof is missing",
    );
}

export interface TenantBootstrapOwnerProof extends TenantBootstrapPlacement {
  owner: (typeof SHARDED_MOVE_OWNERS)[number];
  receiptVersion: typeof TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION;
  observedAt: string;
  state: "prepared" | "active";
}

/**
 * Validate the shape of caller-supplied ownership assertions against the
 * repository owner contract. A matching contract string remains forgeable;
 * this helper is structural only and never authorizes routing activation.
 */
export function requireCompleteBootstrapProofs(
  placement: TenantBootstrapPlacement,
  phase: TenantBootstrapOwnerProof["state"],
  proofs: readonly TenantBootstrapOwnerProof[],
): void {
  if (!validPlacement(placement))
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap placement identity is invalid",
    );
  if (!Array.isArray(proofs) || proofs.length !== SHARDED_MOVE_OWNERS.length)
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap cannot activate without an exact owner proof set",
    );
  const byOwner = new Map<string, TenantBootstrapOwnerProof>();
  const receiptKeys = [
    "owner",
    "receiptVersion",
    "tenantId",
    "shardId",
    "shardIncarnation",
    "placementEpoch",
    "state",
    "observedAt",
  ].sort();
  for (const proof of proofs) {
    if (
      !proof ||
      !SHARDED_MOVE_OWNERS.includes(proof.owner) ||
      byOwner.has(proof.owner) ||
      proof.tenantId !== placement.tenantId ||
      proof.shardId !== placement.shardId ||
      proof.shardIncarnation !== placement.shardIncarnation ||
      proof.placementEpoch !== placement.placementEpoch ||
      proof.state !== phase ||
      proof.receiptVersion !==
        TENANT_BOOTSTRAP_OWNER_CONTRACTS[proof.owner as TenantBootstrapOwner]
          .ownershipContractVersion ||
      proof.receiptVersion !== TENANT_OWNERSHIP_BOOTSTRAP_CONTRACT_VERSION ||
      typeof proof.observedAt !== "string" ||
      Number.isNaN(Date.parse(proof.observedAt)) ||
      Object.keys(proof).sort().join("\0") !== receiptKeys.join("\0")
    )
      throw new TenantBootstrapPreflightError(
        "tenant bootstrap owner read-back proof does not match the placement",
      );
    byOwner.set(proof.owner, proof);
  }
  if (SHARDED_MOVE_OWNERS.some((owner) => !byOwner.has(owner)))
    throw new TenantBootstrapPreflightError(
      "tenant bootstrap owner read-back proof is missing",
    );
}
