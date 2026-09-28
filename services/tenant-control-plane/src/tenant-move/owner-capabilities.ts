import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";

/**
 * Protocol gaps for owners which do not yet have an owner-local move receipt
 * adapter. This is an acceptance guard/diagnostic inventory, not proof that a
 * global move coordinator exists. Keep each entry concrete so adding an owner
 * to the sharded roster cannot silently imply it is migratable.
 */
export const UNSUPPORTED_OWNER_MOVE_EFFECTS = {
  projection: [
    "daily reading_history partitions and retention drops have no partition-aware copy or Cassandra reconciliation receipt",
    "Kafka topic-partition offsets are shared across tenants; no pause/drain/frontier handoff proves this tenant complete",
    "Debezium projection outbox publication and downstream deduplication have no coordinated source/target receipt",
    "replay, schema promotion, consumer state, watermarks, inbox, gaps and views have no common writer fence and verified snapshot",
  ],
  jobs: [
    "notification_intents, inbox, intent_redrives, dispatch_outbox and dead_letter_outbox have no source/target snapshot copy and checksum receipt",
    "RabbitMQ dispatches and dead-letter work need broker drain/redelivery or deduplication evidence; the current drain probe only checks that pending counts are zero",
    "no target prepare, activate, abort, source reactivation, or crash-recovery receipt protocol exists",
  ],
  saga: [
    "provisioning_sagas, saga_audit, saga_command_outbox and saga_result_inbox need an atomic owner snapshot and verified target receipt",
    "shared Kafka command/result partition frontiers and unpublished outbox effects are not paused, drained, or acknowledged per tenant",
    "active saga leases, fencing tokens, and in-flight hardware participant/MQTT outcomes have no coordinated transfer protocol",
    "no target prepare, activate, abort, source reactivation, or partial-cutover recovery adapter exists",
  ],
  hardware: [
    "hardware registry, command receipts, result outbox and MQTT acknowledgement state have no owner-local source/target copy receipt",
    "pending MQTT device commands and late acknowledgements cannot be proven drained or safely redirected during a move",
    "Kafka result publication and saga command consumer frontiers are shared and lack per-tenant handoff receipts",
    "no target prepare, activate, abort, source reactivation, or crash-recovery adapter exists",
  ],
  alerts: [
    "alert_episodes, rules, transitions, command_receipts, consumer_inbox, risk_stream_positions and outbox_events have no copy/verification/activation receipt adapter",
    "historical Debezium CDC outbox effects are not acknowledged/deduplicated with Jobs and Notifications during cutover",
    "risk-stream consumer position and downstream notification effects have no coordinated tenant frontier receipt",
    "the current preflight only rejects schema drift and tenants with CDC outbox rows; it does not migrate data",
  ],
  notifications: [
    "deliveries, delivery_attempts and notification_preferences have no source/target snapshot, hash, or activation receipts",
    "in-flight provider requests and provider-side delivery idempotency cannot be transferred or reconciled by the current read-only drain probe",
    "delivery task broker acknowledgements/retries and tenant-specific consumer progress have no cutover frontier receipt",
    "the current probe checks for zero live deliveries only; no target prepare, activate, abort, or recovery adapter exists",
  ],
} as const satisfies Partial<
  Record<(typeof SHARDED_MOVE_OWNERS)[number], readonly string[]>
>;

export type UnsupportedMoveOwner = keyof typeof UNSUPPORTED_OWNER_MOVE_EFFECTS;

export const UNSUPPORTED_MOVE_OWNERS = Object.keys(
  UNSUPPORTED_OWNER_MOVE_EFFECTS,
) as UnsupportedMoveOwner[];

/** Fail closed before any owner-specific move side effect is attempted. */
export function assertOwnerMoveProtocolAvailable(
  owner: (typeof SHARDED_MOVE_OWNERS)[number],
): void {
  const effects = UNSUPPORTED_OWNER_MOVE_EFFECTS[
    owner as UnsupportedMoveOwner
  ] as readonly string[] | undefined;
  if (effects)
    throw new Error(`${owner} tenant move unsupported: ${effects.join("; ")}`);
}
