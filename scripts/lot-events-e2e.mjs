import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { composeArgs, broker } from "./events-lib.mjs";
import {
  context,
  pooledDb,
  seedTenant,
} from "../services/device-service/dist/testing/fixtures.js";
import { placeGrainLot } from "../services/device-service/dist/inventory/repository.js";

process.loadEnvFile(".env");
const temp = mkdtempSync(path.join(tmpdir(), "greenguard-lot-e2e-"));
const binary = path.join(temp, "cdc-transformer");
const build = spawnSync("go", ["build", "-o", binary, "."], {
  cwd: "services/cdc-transformer",
  encoding: "utf8",
  timeout: 120_000,
});
assert.equal(build.status, 0, build.stderr || "transformer build failed");

const db = pooledDb(4);
const transformer = spawn(binary, [], {
  env: {
    ...process.env,
    KAFKA_BROKERS: "127.0.0.1:59092",
    KAFKA_GROUP_ID: "greenguard-cdc-transformer-v1",
    EVENT_SCHEMA_DIR: path.resolve("contracts/events"),
    HTTP_ADDR: "127.0.0.1:18083",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let transformerError = "";
transformer.stderr.on("data", (chunk) => {
  transformerError += chunk.toString();
});
const consumer = spawn(
  "docker",
  [
    ...composeArgs,
    "exec",
    "-T",
    "kafka",
    "/opt/kafka/bin/kafka-console-consumer.sh",
    "--bootstrap-server",
    broker,
    "--topic",
    "greenguard.inventory.lot.v1",
    "--from-beginning",
    "--timeout-ms",
    "90000",
    "--property",
    "print.key=true",
    "--property",
    "key.separator=|",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let consumerError = "";
consumer.stderr.on("data", (chunk) => {
  consumerError += chunk.toString();
});
const seen = new Map();
const lines = createInterface({ input: consumer.stdout });
lines.on("line", (line) => {
  const separator = line.indexOf("|");
  if (separator < 0) return;
  try {
    const event = JSON.parse(line.slice(separator + 1));
    seen.set(event.event_id, { key: line.slice(0, separator), event });
  } catch {
    // Other records are irrelevant to this tenant; malformed matching data
    // cannot satisfy the event-ID assertion below.
  }
});

async function ready() {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (transformer.exitCode !== null)
      throw new Error(
        `transformer stopped before ready: ${transformerError.slice(-1000)}`,
      );
    const response = await fetch("http://127.0.0.1:18083/readyz", {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (response?.ok) return;
    await delay(500);
  }
  throw new Error("transformer did not become ready");
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await Promise.race([finished, delay(5000).then(() => child.kill("SIGKILL"))]);
}

try {
  await ready();
  const tenant = await seedTenant(db);
  const wheat = await placeGrainLot(db, context(tenant.tenantId), {
    binId: tenant.binId,
    lotId: randomUUID(),
    grainType: "wheat",
    effectiveFrom: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  });
  const canola = await placeGrainLot(db, context(tenant.tenantId), {
    binId: tenant.binId,
    lotId: randomUUID(),
    grainType: "canola",
    effectiveFrom: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const deadline = Date.now() + 90_000;
  while (
    Date.now() < deadline &&
    (!seen.has(wheat.eventId) || !seen.has(canola.eventId))
  ) {
    if (transformer.exitCode !== null || consumer.exitCode !== null)
      throw new Error(
        `transport stopped: transformer=${transformerError.slice(-1000)} consumer=${consumerError.slice(-1000)}`,
      );
    await delay(250);
  }
  for (const [placed, version, previous] of [
    [wheat, "1", null],
    [canola, "2", wheat.lotId],
  ]) {
    const received = seen.get(placed.eventId);
    assert.ok(received, `canonical lot event ${version} not received`);
    assert.equal(received.key, `${tenant.tenantId}:${tenant.binId}`);
    assert.equal(received.event.aggregate_version, version);
    assert.equal(received.event.payload.occupancy_version, version);
    assert.equal(received.event.payload.lot_id, placed.lotId);
    assert.equal(received.event.payload.previous_lot_id, previous);
  }
  console.log(
    "PASS: placement transaction → inventory outbox → Debezium → transformer → dedicated lot topic, versions 1 and 2",
  );
} finally {
  await stop(consumer);
  lines.close();
  await stop(transformer);
  await db.$disconnect();
  rmSync(temp, { recursive: true, force: true });
}
