import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const composeArgs = [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "infra/compose/compose.yaml",
  "-f",
  "infra/kafka/compose.yaml",
];
export const databases = ["inventory", "telemetry"];
export const broker = "kafka:29092";
export const connectURL = "http://127.0.0.1:58083";
export const rawTopic = (database) => `greenguard.raw.${database}.outbox`;
export const connectorName = (database) => `${database}-outbox`;

export function compose(args, options = {}) {
  const result = spawnSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    timeout: 180_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    // Never echo environment/configuration/SQL: these may contain credentials.
    throw new Error(
      `Events compose ${args[0]} failed (exit ${result.status ?? "unknown"})`,
    );
  }
  return result.stdout;
}

export function kafka(command, args) {
  return compose([
    "exec",
    "-T",
    "kafka",
    `/opt/kafka/bin/kafka-${command}.sh`,
    "--bootstrap-server",
    broker,
    ...args,
  ]);
}

export function connectorConfig(database) {
  return JSON.parse(
    readFileSync(`infra/kafka/connectors/${database}-outbox.json`, "utf8"),
  );
}

export function allConnectorConfigs() {
  return Object.fromEntries(
    readdirSync("infra/kafka/connectors")
      .filter((file) => file.endsWith(".json"))
      .map((file) => [
        file.slice(0, -".json".length),
        JSON.parse(readFileSync(`infra/kafka/connectors/${file}`, "utf8")),
      ]),
  );
}

export function validateSharedDatabaseHeartbeatConfigs(configs) {
  const byDatabase = new Map();
  for (const [name, config] of Object.entries(configs)) {
    const database = config["database.dbname"];
    if (!database) throw new Error(`Connector ${name} has no database.dbname`);
    const group = byDatabase.get(database) ?? [];
    group.push({ name, config });
    byDatabase.set(database, group);
  }

  for (const [database, connectors] of byDatabase) {
    const heartbeatConnectors = connectors.filter(
      ({ config }) =>
        Number(config["heartbeat.interval.ms"] ?? 0) > 0 ||
        config["heartbeat.action.query"],
    );
    if (heartbeatConnectors.length === 0) continue;
    for (const { name, config } of connectors) {
      if (heartbeatConnectors.some((heartbeat) => heartbeat.name === name))
        continue;
      if (!config["message.prefix.exclude.list"]) {
        throw new Error(
          `Connector ${name} shares ${database} with a heartbeat connector but has no message.prefix.exclude.list`,
        );
      }
    }
  }
}

export async function connectRequest(path, method = "GET", body) {
  let response;
  try {
    response = await fetch(`${connectURL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error(`Connect ${method} ${path} timed out after 10s`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    const error = new Error(
      `Connect ${method} ${path}: HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return;
  return response.json();
}

export async function waitRunning(name) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    // Right after a PUT the status can 404 until the worker rebalance settles.
    const status = await connectRequest(`/connectors/${name}/status`).catch(
      (error) => {
        if (error.status === 404) return undefined;
        throw error;
      },
    );
    if (status === undefined) {
      await delay(1000);
      continue;
    }
    const states = [
      status.connector.state,
      ...status.tasks.map((task) => task.state),
    ];
    if (states.includes("FAILED"))
      throw new Error(`Connector ${name} failed; inspect Connect logs`);
    if (
      status.tasks.length === 1 &&
      states.every((state) => state === "RUNNING")
    )
      return;
    await delay(1000);
  }
  throw new Error(`Connector ${name} did not become RUNNING within 120s`);
}

export async function registerConnector(name, config) {
  // PUT is create-or-update. Rebalances can temporarily reject a valid update.
  for (let attempt = 0; ; attempt++) {
    try {
      await connectRequest(`/connectors/${name}/config`, "PUT", config);
      break;
    } catch (error) {
      if (error.status !== 409 || attempt >= 20) throw error;
      await delay(1000);
    }
  }
  await waitRunning(name);
}
