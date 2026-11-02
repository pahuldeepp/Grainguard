// Fresh disposable GitHub runners only. Never adopts a developer's existing stack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { integrationEnvironment } from "./flink-risk-helpers.mjs";

assert.equal(process.env.GITHUB_ACTIONS, "true", "CI fixture only");
const action = process.argv[2];
assert.ok(["up", "down"].includes(action));
const project = "gg-flink-risk";
const marker = ".local/flink-risk-ci-owner";
const compose = [
  "compose",
  "-p",
  project,
  "--env-file",
  ".env",
  "-f",
  "infra/compose/compose.yaml",
  "-f",
  "infra/kafka/compose.yaml",
  "-f",
  "infra/rabbitmq/compose.yaml",
  "-f",
  "infra/flink/compose.yaml",
  "-f",
  "infra/flink/integration.compose.yaml",
  "--profile",
  "flink",
];
function run(command, args, cwd = ".") {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    timeout: 900_000,
  });
  assert.equal(result.status, 0, `${command} failed`);
}
assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/);
const owner = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
if (action === "down") {
  if (existsSync(marker)) {
    assert.equal(readFileSync(marker, "utf8"), owner);
    run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
  }
} else {
  assert.ok(
    !existsSync(".env") && !existsSync(marker),
    "fresh checkout required",
  );
  const inventory = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`],
    { encoding: "utf8" },
  );
  assert.equal(inventory.status, 0);
  assert.equal(
    inventory.stdout.trim(),
    "",
    "refuse existing integration project",
  );
  run("node", ["scripts/bootstrap.mjs"]);
  const env = integrationEnvironment(readFileSync(".env", "utf8"));
  for (const [key, value] of Object.entries({
    STAGE06_KAFKA_BROKER: "127.0.0.1:59112",
    STAGE06_FLINK: "1",
    FLINK_ANOMALY_MIN_SAMPLES: "2",
    FLINK_MAX_OUT_OF_ORDER: "1s",
    FLINK_IDLE_TIMEOUT: "1s",
    FLINK_CHECKPOINT_INTERVAL: "2s",
  }))
    env.set(key, value);
  writeFileSync(
    ".env",
    [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(marker, owner, { mode: 0o600 });
  process.loadEnvFile(".env");
  process.env.STAGE06_ENV_FILE = path.resolve(".env");
  run("make", ["risk-venv"]);
  run("npm", ["run", "build"]);
  run("docker", [
    ...compose,
    "up",
    "-d",
    "--wait",
    "--build",
    "postgres",
    "pgbouncer",
    "kafka",
    "rabbitmq",
  ]);
  for (const topic of [
    "greenguard.connect.configs",
    "greenguard.connect.offsets",
    "greenguard.connect.status",
    "_schemas",
  ]) {
    run("docker", [
      ...compose,
      "exec",
      "-T",
      "kafka",
      "/opt/kafka/bin/kafka-topics.sh",
      "--bootstrap-server",
      "kafka:29092",
      "--create",
      "--if-not-exists",
      "--topic",
      topic,
      "--partitions",
      "1",
      "--replication-factor",
      "1",
      "--config",
      "cleanup.policy=compact",
    ]);
  }
  run("docker", [
    ...compose,
    "up",
    "-d",
    "--wait",
    "--build",
    "schema-registry",
    "connect",
  ]);
  run("node", ["scripts/flink-risk-prepare.mjs"]);
  run("docker", [
    ...compose,
    "up",
    "-d",
    "--build",
    "flink-jobmanager",
    "flink-taskmanager",
  ]);
  run("node", ["scripts/stage06-e2e.mjs"]);
}
