import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";

/**
 * Required owner-local evidence boundaries for one tenant move. These are
 * deliberately capabilities, rather than booleans: a production adapter must
 * implement each operation against its own database/broker and return the
 * corresponding operation-bound receipt. A drain probe or shared-database
 * receipt is not an implementation of this contract.
 */
export const TENANT_MOVE_BOUNDARIES = [
  "quiesce_and_drain",
  "fence_source",
  "copy_and_verify",
  "prepare_target",
  "activate_target",
  "verify_replica_freshness",
  "recover_or_abort",
] as const;

export type TenantMoveBoundary = (typeof TENANT_MOVE_BOUNDARIES)[number];

export interface TenantMoveOwnerAdapter {
  readonly owner: (typeof SHARDED_MOVE_OWNERS)[number];
  readonly boundaries: ReadonlySet<TenantMoveBoundary>;
  /** Adapter code is owned by the service that owns this tenant data. */
  readonly ownerLocal: true;
}

export interface MoveAdapterPreflight {
  readonly adapters: ReadonlyMap<
    (typeof SHARDED_MOVE_OWNERS)[number],
    TenantMoveOwnerAdapter
  >;
}

export class TenantMoveAdaptersUnavailableError extends Error {
  readonly missingOwners: readonly string[];
  readonly incomplete: Readonly<Record<string, readonly string[]>>;

  constructor(
    missingOwners: readonly string[],
    incomplete: Readonly<Record<string, readonly string[]>>,
  ) {
    const details = [
      missingOwners.length ? `missing owners: ${missingOwners.join(", ")}` : "",
      ...Object.entries(incomplete).map(
        ([owner, boundaries]) =>
          `${owner} missing boundaries: ${boundaries.join(", ")}`,
      ),
    ].filter(Boolean);
    super(`tenant move rejected before side effects (${details.join("; ")})`);
    this.name = "TenantMoveAdaptersUnavailableError";
    this.missingOwners = missingOwners;
    this.incomplete = incomplete;
  }
}

/**
 * Validate the entire deployed owner roster before a caller quiesces a tenant,
 * acquires migration locks, or invokes any owner adapter. This is intentionally
 * only a preflight gate today: the repository does not yet have adapters for all
 * nine owners, so no all-owner execution path can be safely enabled.
 */
export function preflightTenantMoveAdapters(
  candidates: readonly TenantMoveOwnerAdapter[],
): MoveAdapterPreflight {
  const expected = new Set<string>(SHARDED_MOVE_OWNERS);
  const grouped = new Map<string, TenantMoveOwnerAdapter[]>();
  const unexpected: Record<string, readonly string[]> = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.owner !== "string") {
      unexpected["<invalid>"] = ["invalid adapter registration"];
      continue;
    }
    if (!expected.has(candidate.owner)) {
      unexpected[candidate.owner] = ["unexpected owner adapter"];
      continue;
    }
    const list = grouped.get(candidate.owner) ?? [];
    list.push(candidate);
    grouped.set(candidate.owner, list);
  }

  const missingOwners = SHARDED_MOVE_OWNERS.filter(
    (owner) => !grouped.has(owner),
  );
  const incomplete: Record<string, readonly string[]> = { ...unexpected };
  for (const owner of SHARDED_MOVE_OWNERS) {
    const matches = grouped.get(owner);
    if (!matches || matches.length !== 1) {
      if (matches && matches.length > 1)
        incomplete[owner] = ["duplicate adapter registration"];
      continue;
    }
    const adapter = matches[0];
    if (adapter.ownerLocal !== true) {
      incomplete[owner] = ["adapter is not owner-local"];
      continue;
    }
    const absent = TENANT_MOVE_BOUNDARIES.filter(
      (boundary) => !adapter.boundaries.has(boundary),
    );
    if (absent.length) incomplete[owner] = absent;
  }
  if (missingOwners.length || Object.keys(incomplete).length)
    throw new TenantMoveAdaptersUnavailableError(missingOwners, incomplete);

  return {
    adapters: new Map(
      SHARDED_MOVE_OWNERS.map((owner) => [owner, grouped.get(owner)![0]]),
    ),
  };
}
