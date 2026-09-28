import { createHash } from "node:crypto";
import { PlacementError, placementEpoch } from "./placement.js";

export interface InitialPlacementRing {
  version: string;
  algorithm: "sha256-v1";
  virtualNodes: number;
  shardIds: string[];
}
const hash = (input: string) =>
  createHash("sha256").update(input, "utf8").digest("hex");
const positionCache = new Map<
  string,
  { shardId: string; position: string }[]
>();

/** ONLY an onboarding suggestion. Never call this to route an existing tenant. */
export function suggestInitialShard(
  tenantId: string,
  ring: InitialPlacementRing,
): string {
  placementEpoch(ring.version);
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(
      tenantId,
    ) ||
    ring.algorithm !== "sha256-v1" ||
    !Number.isInteger(ring.virtualNodes) ||
    ring.virtualNodes < 1 ||
    ring.virtualNodes > 1024 ||
    !Array.isArray(ring.shardIds) ||
    ring.shardIds.length < 1 ||
    ring.shardIds.length > 64 ||
    new Set(ring.shardIds).size !== ring.shardIds.length ||
    ring.shardIds.some((id) => !/^[a-z][a-z0-9-]{0,63}$/.test(id))
  )
    throw new PlacementError("invalid_initial_placement_ring");
  const cacheKey = JSON.stringify([
    ring.algorithm,
    ring.virtualNodes,
    [...ring.shardIds].sort(),
  ]);
  let positions = positionCache.get(cacheKey);
  if (!positions) {
    positions = ring.shardIds
      .flatMap((shardId) =>
        Array.from({ length: ring.virtualNodes }, (_, node) => ({
          shardId,
          position: hash(
            `greenguard-placement-sha256-v1:shard:${shardId}:vnode:${node}`,
          ),
        })),
      )
      .sort((a, b) =>
        a.position < b.position
          ? -1
          : a.position > b.position
            ? 1
            : a.shardId < b.shardId
              ? -1
              : a.shardId > b.shardId
                ? 1
                : 0,
      );
    positionCache.set(cacheKey, positions);
    while (positionCache.size > 4)
      positionCache.delete(positionCache.keys().next().value!);
  }
  const position = hash(`greenguard-placement-sha256-v1:tenant:${tenantId}`);
  let low = 0,
    high = positions.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (positions[mid]!.position < position) low = mid + 1;
    else high = mid;
  }
  return positions[low === positions.length ? 0 : low]!.shardId;
}
