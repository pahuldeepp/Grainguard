import assert from "node:assert/strict";
import { kafka } from "./events-lib.mjs";

const domainTopics = [
  ["greenguard.raw.inventory.outbox", 1],
  ["greenguard.raw.control.outbox", 1],
  ["greenguard.raw.billing.outbox", 1],
  ["greenguard.raw.telemetry.outbox", 1],
  ["greenguard.raw.risk.outbox", 1],
  ["greenguard.raw.alerts.outbox", 1],
  ["greenguard.raw.projection.notifications", 1],
  ["greenguard.inventory.device.v1", 6],
  ["greenguard.inventory.tenant.v1", 6],
  ["greenguard.inventory.tenant.dlq.v1", 6],
  ["greenguard.billing.lifecycle.v1", 6],
  ["greenguard.billing.entitlements.dlq.v1", 6],
  ["greenguard.platform.config.v1", 6],
  ["greenguard.inventory.facility.v1", 6],
  ["greenguard.inventory.lot.v1", 6],
  ["greenguard.telemetry.recorded.v1", 6],
  ["greenguard.telemetry.recorded.v2", 6],
  ["greenguard.inventory.sensor-layout.v1", 6],
  ["greenguard.risk.assessment.v1", 6],
  ["greenguard.risk.assessment.v2", 6],
  ["greenguard.risk.policy.v1", 6],
  ["greenguard.risk.assessment_invalidated.v1", 6],
  ["greenguard.alerts.lifecycle.v1", 6],
  // Contains contact PII; production Kafka ACLs/TLS and encryption at rest are mandatory.
  ["greenguard.notifications.contacts.cdc.v1", 6, "compact"],
  ["greenguard.notifications.contacts.heartbeat.v2", 1],
  // Recoverable source envelopes contain PII; short ACL-restricted retention is mandatory.
  ["greenguard.notifications.contacts.cdc.dlq.v1", 1, "delete", "604800000"],
  ["greenguard.projection.notification.v1", 6],
  ["greenguard.saga.commands.v1", 6],
  ["greenguard.saga.results.v1", 6],
  ["greenguard.saga.results.dlq.v1", 6],
  ["greenguard.saga.commands.dlq.v1", 6],
  ["greenguard.quarantine.v1", 1],
];
// Infrastructure storage is separate from the domain topics.
const internalTopics = [
  ["greenguard.connect.configs", 1],
  ["greenguard.connect.offsets", 1],
  ["greenguard.connect.status", 1],
  ["_schemas", 1],
  // Debezium writes its own heartbeat record here on every heartbeat.interval.ms.
  // Auto-creation is off, so each connector heartbeat topic must be provisioned.
  ["__debezium-heartbeat.greenguard_inventory", 1],
  ["__debezium-heartbeat.greenguard_control", 1],
  ["__debezium-heartbeat.greenguard_control_contacts", 1],
];
function provision(
  [name, partitions, requestedCleanup, retentionMs],
  defaultCleanup,
) {
  const cleanup = requestedCleanup ?? defaultCleanup;
  kafka("topics", [
    "--create",
    "--if-not-exists",
    "--topic",
    name,
    "--partitions",
    String(partitions),
    "--replication-factor",
    "1",
    "--config",
    `cleanup.policy=${cleanup}`,
    "--config",
    "min.insync.replicas=1",
    ...(retentionMs ? ["--config", `retention.ms=${retentionMs}`] : []),
  ]);
  kafka("configs", [
    "--alter",
    "--entity-type",
    "topics",
    "--entity-name",
    name,
    "--add-config",
    [
      `cleanup.policy=${cleanup}`,
      "min.insync.replicas=1",
      ...(retentionMs ? [`retention.ms=${retentionMs}`] : []),
    ].join(","),
  ]);
  const description = kafka("topics", ["--describe", "--topic", name]);
  assert.match(
    description,
    new RegExp(`PartitionCount:\\s*${partitions}\\b`),
    `${name}: partition drift`,
  );
  assert.match(
    description,
    /ReplicationFactor:\s*1\b/,
    `${name}: replication drift`,
  );
  assert.match(
    description,
    new RegExp(`cleanup.policy=${cleanup}\\b`),
    `${name}: retention policy drift`,
  );
  assert.match(description, /min.insync.replicas=1\b/, `${name}: minISR drift`);
  if (retentionMs)
    assert.match(
      description,
      new RegExp(`retention.ms=${retentionMs}\\b`),
      `${name}: retention drift`,
    );
  console.log(`${name}: ${partitions} partitions, RF1, ${cleanup}`);
}
for (const topic of domainTopics) provision(topic, "delete");
for (const topic of internalTopics) provision(topic, "compact");
