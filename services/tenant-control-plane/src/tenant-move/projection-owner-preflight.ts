/**
 * Projection-builder does not yet have a safe cross-shard move protocol.
 * This guard is deliberately not a MoveReceipt producer: callers must refuse
 * to advance placement while any projection owner is not independently ready.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PROJECTION_MOVE_BLOCKERS = [
  "reading_history is daily range-partitioned and retention can drop old partitions; no partition-aware copy plus retention/Cassandra reconciliation receipt exists",
  "consumer_inbox, projection_event_completions, projection_watermarks, stream state, latest/views, and gaps must move as one verified owner snapshot",
  "projection_checkpoints represent tenant rows but Kafka consumer offsets are shared by topic partition; no pause/drain/frontier handoff protocol proves the moved tenant is complete without loss or replay",
  "projection outbox notifications are Debezium-published CDC effects; no source/target connector frontier and downstream deduplication receipt is coordinated",
  "schema promotion and replay can write projection state independently of the normal consumer; no move fence coordinates replay, writer leases, and promotion",
] as const;

/**
 * Fail closed before a caller prepares placement or emits any owner receipt.
 * This remains blocked even when a tenant currently has no rows: the Kafka
 * frontier and owner-level CDC protocol are not tenant-row properties.
 */
export function assertProjectionMovePreflight(tenantId: string): never {
  if (!UUID.test(tenantId)) throw new Error("invalid projection move tenant id");
  throw new Error(
    `projection tenant move blocked: ${PROJECTION_MOVE_BLOCKERS.join("; ")}`,
  );
}
