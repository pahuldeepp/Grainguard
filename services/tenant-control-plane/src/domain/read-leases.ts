import { randomUUID } from "node:crypto";
import type { TenantRoute } from "@greenguard/membership-client";
import type { Db } from "../db/client.js";
import { inScope, UUID } from "../db/session.js";
import { InvalidInputError, NotFoundError } from "./errors.js";
import {
  PlacementConflictError,
  PlacementUnavailableError,
} from "./placement.js";

export interface ReadAdmissionLease {
  leaseId: string;
  expiresAt: string;
  route: TenantRoute;
}

/** Parent lock first, then lease rows: the same order as a placement move.
 * Each lease is bounded by the database clock and cannot be renewed.
 */
export async function acquireReadLease(
  db: Db,
  tenantId: string,
): Promise<ReadAdmissionLease> {
  return inScope(db, { tenantId }, async (tx) => {
    const [row] = await tx.$queryRaw<
      {
        shard_id: string;
        shard_incarnation: string;
        routing_epoch: bigint;
        placement_state: TenantRoute["state"];
        shard_state: string;
        expires_at: Date;
      }[]
    >`SELECT o.shard_id,s.shard_incarnation::text,o.routing_epoch,o.placement_state,
      s.state AS shard_state,clock_timestamp()+interval '5 seconds' AS expires_at
      FROM organizations o JOIN shard_registry s USING(shard_id)
      WHERE o.tenant_id=${tenantId}::uuid AND o.state='active' FOR UPDATE OF o`;
    if (!row) throw new NotFoundError();
    if (row.placement_state !== "active" || row.shard_state === "offline")
      throw new PlacementUnavailableError();
    await tx.$executeRaw`DELETE FROM placement_read_leases WHERE tenant_id=${tenantId}::uuid AND expires_at<=clock_timestamp()`;
    const [{ count }] = await tx.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM placement_read_leases WHERE tenant_id=${tenantId}::uuid`;
    if (count >= 100n) throw new PlacementUnavailableError();
    const leaseId = randomUUID();
    await tx.$executeRaw`INSERT INTO placement_read_leases(tenant_id,lease_id,shard_id,shard_incarnation,placement_epoch,expires_at)
      VALUES(${tenantId}::uuid,${leaseId}::uuid,${row.shard_id},${row.shard_incarnation}::uuid,${row.routing_epoch},${row.expires_at})`;
    return {
      leaseId,
      expiresAt: row.expires_at.toISOString(),
      route: {
        tenantId,
        shardId: row.shard_id,
        shardIncarnation: row.shard_incarnation,
        placementEpoch: row.routing_epoch.toString(),
        state: "active",
        // Route cache may trust only this short TTL; the durable lease lasts longer.
        expiresAt: new Date(row.expires_at.getTime() - 4000).toISOString(),
      },
    };
  });
}

/** This is the response admission linearization point. An admitted response can
 * finish transport after cutover; a lost or expired lease cannot admit another.
 */
export async function admitReadLease(
  db: Db,
  tenantId: string,
  leaseId: string,
): Promise<void> {
  if (!UUID.test(leaseId)) throw new InvalidInputError("invalid read lease");
  await inScope(db, { tenantId }, async (tx) => {
    // Lock organization before testing the lease. Never certify a replaced shard.
    const org = await tx.$queryRaw<unknown[]>`SELECT 1 FROM organizations
      WHERE tenant_id=${tenantId}::uuid AND state='active' FOR SHARE`;
    if (!org.length) throw new NotFoundError();
    const rows = await tx.$queryRaw<
      unknown[]
    >`SELECT 1 FROM placement_read_leases l
      JOIN organizations o ON o.tenant_id=l.tenant_id JOIN shard_registry s ON s.shard_id=o.shard_id
      WHERE l.tenant_id=${tenantId}::uuid AND l.lease_id=${leaseId}::uuid
      AND l.expires_at>clock_timestamp() AND l.shard_id=o.shard_id
      AND l.shard_incarnation=s.shard_incarnation AND l.placement_epoch=o.routing_epoch
      AND o.placement_state IN ('active','quiescing') AND s.state<>'offline'`;
    if (!rows.length)
      throw new PlacementConflictError(
        "read lease expired or placement changed",
      );
  });
}

export async function releaseReadLease(
  db: Db,
  tenantId: string,
  leaseId: string,
): Promise<void> {
  if (!UUID.test(leaseId)) throw new InvalidInputError("invalid read lease");
  await inScope(db, { tenantId }, async (tx) => {
    await tx.$executeRaw`DELETE FROM placement_read_leases WHERE tenant_id=${tenantId}::uuid AND lease_id=${leaseId}::uuid`;
  });
}
