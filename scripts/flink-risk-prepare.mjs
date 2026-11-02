// Prepare only the dedicated integration stack after Compose reports healthy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Kafka, logLevel } from "kafkajs";

assert.ok(
  process.env.STAGE06_ENV_FILE,
  "STAGE06_ENV_FILE must select the isolated environment",
);
process.loadEnvFile(process.env.STAGE06_ENV_FILE);
assert.equal(process.env.STAGE06_KAFKA_BROKER, "127.0.0.1:59112");
const run = (command, args, cwd = ".") => {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    timeout: 240_000,
  });
  assert.equal(result.status, 0, `${command} failed`);
};
run(
  path.resolve(".local/risk-venv/bin/python"),
  ["-m", "risk_engine.migrate"],
  "services/risk-engine",
);
run("npm", ["run", "migrate", "-w", "@greenguard/workflow-alerts"]);
run("go", ["run", "./cmd/migrate"], "services/jobs-worker");
run("npm", ["run", "migrate", "-w", "@greenguard/notification-service"]);
const kafka = new Kafka({
  clientId: "flink-risk-prepare",
  brokers: [process.env.STAGE06_KAFKA_BROKER],
  logLevel: logLevel.ERROR,
});
const admin = kafka.admin();
await admin.connect();
try {
  const topicNames = [
    ...["inventory", "telemetry", "risk", "alerts", "control", "billing"].map(
      (x) => `greenguard.raw.${x}.outbox`,
    ),
    "greenguard.raw.projection.notifications",
    "greenguard.inventory.device.v1",
    "greenguard.inventory.lot.v1",
    "greenguard.inventory.facility.v1",
    "greenguard.inventory.tenant.v1",
    "greenguard.billing.lifecycle.v1",
    "greenguard.platform.config.v1",
    "greenguard.telemetry.recorded.v1",
    "greenguard.telemetry.anomaly.v1",
    "greenguard.telemetry.aggregate.v1",
    "greenguard.stream.dlq.v1",
    "greenguard.risk.assessment.v1",
    "greenguard.risk.assessment_invalidated.v1",
    "greenguard.alerts.lifecycle.v1",
    "greenguard.projection.notification.v1",
    "greenguard.quarantine.v1",
  ];
  await admin.createTopics({
    waitForLeaders: true,
    topics: topicNames.map((topic) => ({
      topic,
      numPartitions: topic.includes(".raw.") ? 1 : 6,
      replicationFactor: 1,
    })),
  });
} finally {
  await admin.disconnect();
}
for (const database of ["risk", "alerts"]) {
  const name = `${database}-outbox`;
  const config = JSON.parse(
    readFileSync(`infra/kafka/connectors/${name}.json`, "utf8"),
  );
  const response = await fetch(
    `http://127.0.0.1:58113/connectors/${name}/config`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.ok(response.ok, `register ${name}: ${response.status}`);
  const deadline = Date.now() + 120_000;
  let running = false;
  while (Date.now() < deadline) {
    const status = await fetch(
      `http://127.0.0.1:58113/connectors/${name}/status`,
      { signal: AbortSignal.timeout(5000) },
    ).then((r) => r.json());
    assert.notEqual(
      status.connector?.state,
      "FAILED",
      `${name} connector failed`,
    );
    assert.ok(
      !status.tasks?.some((t) => t.state === "FAILED"),
      `${name} task failed`,
    );
    if (
      status.connector?.state === "RUNNING" &&
      status.tasks?.length === 1 &&
      status.tasks[0].state === "RUNNING"
    ) {
      running = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(running, `${name} did not start`);
  console.log(`${name}: RUNNING`);
}
