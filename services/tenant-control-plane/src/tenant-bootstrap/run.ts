import type { Db } from "../db/client.js";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  claimTenantBootstrapJob,
  persistTenantBootstrapProofs,
  retryTenantBootstrap,
  renewTenantBootstrapClaim,
  type TenantBootstrapFailureCode,
} from "./jobs.js";
import { finalizeTenantBootstrap } from "./activation.js";
import {
  requireCompleteBootstrapAdapters,
  requireCompleteBootstrapProofs,
  requireReadyShardOwners,
  unavailableTenantBootstrapOwners,
  type TenantBootstrapOwnerAdapter,
  type TenantBootstrapOwnerProof,
  type TenantBootstrapOwnerReadiness,
  type TenantBootstrapPlacement,
} from "./preflight.js";

export interface TenantBootstrapRuntimeAdapter extends TenantBootstrapOwnerAdapter {
  /** Directly authenticated owner DB identity and service migration-ledger probe. */
  probeReadiness(
    placement: TenantBootstrapPlacement,
  ): Promise<TenantBootstrapOwnerReadiness>;
  /** One-tenant, idempotent SQL calls; never the legacy full-snapshot seeder. */
  prepareTenantOwnership(placement: TenantBootstrapPlacement): Promise<void>;
}

export class TenantBootstrapPhaseError extends Error {
  constructor(
    readonly phase: "readiness" | "preparation" | "activation",
    readonly failedOwners: readonly TenantBootstrapOwnerAdapter["owner"][],
  ) {
    super(
      `tenant bootstrap ${phase} failed for owners: ${failedOwners.join(", ")}`,
    );
    this.name = "TenantBootstrapPhaseError";
  }
}

export class TenantBootstrapUnavailableError extends Error {
  constructor(readonly owners: readonly string[]) {
    super(
      `tenant bootstrap owner contract is unavailable for: ${owners.join(", ")}`,
    );
    this.name = "TenantBootstrapUnavailableError";
  }
}

async function runOwnerPhase<T>(
  phase: TenantBootstrapPhaseError["phase"],
  adapters: readonly TenantBootstrapRuntimeAdapter[],
  operation: (adapter: TenantBootstrapRuntimeAdapter) => Promise<T>,
): Promise<T[]> {
  const results = await Promise.allSettled(adapters.map(operation));
  const failedOwners = results.flatMap((result, index) =>
    result.status === "rejected" ? [adapters[index]!.owner] : [],
  );
  if (failedOwners.length)
    throw new TenantBootstrapPhaseError(phase, failedOwners);
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export interface TenantBootstrapExecutionHooks {
  persistProofs(
    phase: "prepared" | "active",
    proofs: readonly TenantBootstrapOwnerProof[],
  ): Promise<void>;
  activateControlPlane(): Promise<void>;
}

export interface TenantBootstrapResumeState {
  preparedProofs?: unknown;
  activeProofs?: unknown;
}

function resumedProofs(
  placement: TenantBootstrapPlacement,
  phase: "prepared" | "active",
  value: unknown,
): TenantBootstrapOwnerProof[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  requireCompleteBootstrapProofs(
    placement,
    phase,
    value as TenantBootstrapOwnerProof[],
  );
  return value as TenantBootstrapOwnerProof[];
}

/**
 * Testable orchestration core. It is not exposed through an HTTP route.
 */
export async function executeTenantBootstrap(
  placement: TenantBootstrapPlacement,
  adapters: readonly TenantBootstrapRuntimeAdapter[],
  hooks: TenantBootstrapExecutionHooks,
  resume: TenantBootstrapResumeState = {},
): Promise<void> {
  const byOwner = requireCompleteBootstrapAdapters(adapters);
  const ordered = [...byOwner.values()] as TenantBootstrapRuntimeAdapter[];

  const readiness = await runOwnerPhase("readiness", ordered, (adapter) =>
    adapter.probeReadiness(placement),
  );
  requireReadyShardOwners(placement, readiness);

  const storedPrepared = resumedProofs(
    placement,
    "prepared",
    resume.preparedProofs,
  );
  const prepared =
    storedPrepared ??
    (await runOwnerPhase("preparation", ordered, async (adapter) => {
      await adapter.prepareTenantOwnership(placement);
      return adapter.verifyTenantOwnership(placement, "prepared");
    }));
  requireCompleteBootstrapProofs(placement, "prepared", prepared);
  if (!storedPrepared) await hooks.persistProofs("prepared", prepared);

  const storedActive = resumedProofs(placement, "active", resume.activeProofs);
  const active = storedActive
    ? await runOwnerPhase("activation", ordered, (adapter) =>
        adapter.verifyTenantOwnership(placement, "active"),
      )
    : await runOwnerPhase("activation", ordered, async (adapter) => {
        await adapter.activateTenantOwnership(placement);
        return adapter.verifyTenantOwnership(placement, "active");
      });
  requireCompleteBootstrapProofs(placement, "active", active);
  await hooks.persistProofs("active", active);
  await hooks.activateControlPlane();
}

function safeFailureCode(error: unknown): TenantBootstrapFailureCode {
  if (error instanceof TenantBootstrapUnavailableError)
    return "owner_contract_unavailable";
  if (error instanceof TenantBootstrapPhaseError && error.phase === "readiness")
    return "owner_unavailable";
  if (error instanceof Error && error.name === "TenantBootstrapClaimLostError")
    return "lease_lost";
  return "retryable_failure";
}

/** Build a private polling closure from the repository-owned adapter factory. */
export function createTenantBootstrapProcessor(
  adapters: readonly TenantBootstrapRuntimeAdapter[],
): (db: Db) => Promise<boolean> {
  const byOwner = requireCompleteBootstrapAdapters(adapters);
  const ordered = [...byOwner.values()] as TenantBootstrapRuntimeAdapter[];
  return (db) => processNextTenantBootstrapWithAdapters(db, ordered);
}

/** Claim, run, and durably retry one onboarding job. */
export async function processNextTenantBootstrap(db: Db): Promise<boolean> {
  return processNextTenantBootstrapWithAdapters(db, []);
}

async function processNextTenantBootstrapWithAdapters(
  db: Db,
  trustedAdapters: readonly TenantBootstrapRuntimeAdapter[],
): Promise<boolean> {
  const job = await claimTenantBootstrapJob(db);
  if (!job) return false;
  const unavailableOwners = unavailableTenantBootstrapOwners();
  const registeredOwners = new Set(trustedAdapters.map(({ owner }) => owner));
  const missing = SHARDED_MOVE_OWNERS.filter(
    (owner) =>
      unavailableOwners.includes(owner) || !registeredOwners.has(owner),
  );
  if (missing.length) {
    await retryTenantBootstrap(db, job, "owner_contract_unavailable");
    return true;
  }

  let leaseError: unknown;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(() => renewTenantBootstrapClaim(db, job))
      .catch((e: unknown) => {
        leaseError = e;
      });
  }, 30_000);
  timer.unref();
  const assertLease = async () => {
    await heartbeat;
    if (leaseError) throw leaseError;
    await renewTenantBootstrapClaim(db, job);
  };
  try {
    await executeTenantBootstrap(
      job,
      trustedAdapters,
      {
        persistProofs: async (phase, proofs) => {
          await assertLease();
          await persistTenantBootstrapProofs(db, job, phase, proofs);
        },
        activateControlPlane: async () => {
          await assertLease();
          await finalizeTenantBootstrap(db, job);
        },
      },
      {
        preparedProofs: job.preparedReceipts,
        activeProofs: job.activeReceipts,
      },
    );
  } catch (error) {
    await retryTenantBootstrap(db, job, safeFailureCode(error)).catch(
      () => undefined,
    );
    throw error;
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
  return true;
}
