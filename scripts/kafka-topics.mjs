import assert from "node:assert/strict";
import { kafka } from "./events-lib.mjs";

const domainTopics = [
  ["greenguard.raw.inventory.outbox", 1],
  ["greenguard.raw.telemetry.outbox", 1],
  ["greenguard.raw.risk.outbox", 1],
  ["greenguard.raw.alerts.outbox", 1],
  ["greenguard.inventory.device.v1", 6],
  ["greenguard.inventory.facility.v1", 6],
  ["greenguard.inventory.lot.v1", 6],
  ["greenguard.telemetry.recorded.v1", 6],
  ["greenguard.risk.assessment.v1", 6],
  ["greenguard.risk.assessment_invalidated.v1", 6],
  ["greenguard.alerts.lifecycle.v1", 6],
  ["greenguard.quarantine.v1", 1],
];
// Infrastructure storage is separate from the domain topics.
const internalTopics = [
  ["greenguard.connect.configs", 1],
  ["greenguard.connect.offsets", 1],
  ["greenguard.connect.status", 1],
  ["_schemas", 1],
  // Debezium writes its own heartbeat record here on every heartbeat.interval.ms
  // (inventory only). Auto-creation is off, so without it the task blocks forever.
  ["__debezium-heartbeat.greenguard_inventory", 1],
];
function provision([name, partitions], cleanup) {
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
  console.log(`${name}: ${partitions} partitions, RF1, ${cleanup}`);
}
for (const topic of domainTopics) provision(topic, "delete");
for (const topic of internalTopics) provision(topic, "compact");
