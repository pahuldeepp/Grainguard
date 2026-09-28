import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";

/**
 * Offline contract for a future greenfield ownership provisioner.
 *
 * This module deliberately has no database writes and cannot activate tenants.
 * A deployed provisioner must first supply one least-privilege adapter for every
 * sharded owner, prove every selected-shard owner is ready, seed and read back
 * ownership on each owner database, and only then activate the control-plane
 * placement. No current event consumer performs that workflow.
 */
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
  ) => Promise<unknown>;
  activateTenantOwnership: (
    placement: TenantBootstrapPlacement,
  ) => Promise<unknown>;
}

export interface TenantBootstrapOwnerReadiness {
  owner: (typeof SHARDED_MOVE_OWNERS)[number];
  shardId: string;
  shardIncarnation: string;
  status: "ready";
  migrationVersion: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
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
 * Validate the shape and cross-owner consistency of readiness assertions.
 * This function does not authenticate probe results or compare them with an
 * expected per-owner migration manifest. It is not sufficient to authorize
 * tenant activation.
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
      !proof.migrationVersion ||
      !SHA256.test(proof.migrationVersion)
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
  phase: "prepared" | "active";
  state: "prepared" | "active";
  verified: true;
}

/**
 * Validate the shape of caller-supplied ownership assertions. This does not
 * authenticate their provenance and must not authorize routing activation.
 */
export function requireCompleteBootstrapProofs(
  placement: TenantBootstrapPlacement,
  phase: TenantBootstrapOwnerProof["phase"],
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
  for (const proof of proofs) {
    if (
      !proof ||
      !SHARDED_MOVE_OWNERS.includes(proof.owner) ||
      byOwner.has(proof.owner) ||
      proof.tenantId !== placement.tenantId ||
      proof.shardId !== placement.shardId ||
      proof.shardIncarnation !== placement.shardIncarnation ||
      proof.placementEpoch !== placement.placementEpoch ||
      proof.phase !== phase ||
      proof.state !== phase ||
      proof.verified !== true
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
