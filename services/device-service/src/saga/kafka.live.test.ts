import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import kafkaJs from "kafkajs";
import { createDb } from "../db/client.js";
import { withTenant } from "../db/tenant.js";
import { createTenant } from "../testing/fixtures.js";
import { type InventoryCommand, type InventoryResult } from "./inventory.js";
import {
  COMMAND_DLQ_TOPIC,
  COMMAND_TOPIC,
  RESULT_TOPIC,
  startInventorySagaWorker,
} from "./worker.js";

const { Kafka, logLevel } = kafkaJs;

test("live Kafka inventory command reaches durable result outbox and result topic", async (t) => {
  const debug = (message: string) => {
    if (process.env.INVENTORY_SAGA_DEBUG) console.error(message);
  };
  if (process.env.INVENTORY_SAGA_KAFKA_LIVE !== "1") {
    t.skip("INVENTORY_SAGA_KAFKA_LIVE=1 enables broker test");
    return;
  }
  const url = process.env.INVENTORY_DATABASE_URL;
  const broker = process.env.KAFKA_BROKERS;
  if (!url || !broker) {
    t.skip("inventory DB and Kafka are required");
    return;
  }
  const db = createDb(url);
  t.after(() => db.$disconnect());
  const tenant = randomUUID(),
    site = randomUUID(),
    device = randomUUID(),
    asset = randomUUID(),
    saga = randomUUID();
  await createTenant(db, tenant, "saga kafka test");
  await withTenant(db, tenant, async (tx) => {
    await tx.$executeRaw`INSERT INTO sites(tenant_id,site_id,name) VALUES(${tenant}::uuid,${site}::uuid,'saga kafka site')`;
    await tx.$executeRaw`INSERT INTO devices(tenant_id,device_id,site_id,serial_number,status,asset_id)
      VALUES(${tenant}::uuid,${device}::uuid,${site}::uuid,${`saga-kafka-${device}`},'provisioning',${asset}::uuid)`;
  });
  const kafka = new Kafka({
    clientId: `inventory-saga-test-${randomUUID()}`,
    brokers: [broker],
    logLevel: logLevel.ERROR,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const results = kafka.consumer({
    groupId: `inventory-saga-test-results-${randomUUID()}`,
    allowAutoTopicCreation: false,
  });
  const deadLetters = kafka.consumer({
    groupId: `inventory-saga-test-dlq-${randomUUID()}`,
    allowAutoTopicCreation: false,
  });
  await producer.connect();
  debug("producer connected");
  t.after(() => producer.disconnect());
  await results.connect();
  debug("results connected");
  t.after(() => results.disconnect());
  await deadLetters.connect();
  t.after(() => deadLetters.disconnect());
  await results.subscribe({ topic: RESULT_TOPIC, fromBeginning: true });
  await deadLetters.subscribe({
    topic: COMMAND_DLQ_TOPIC,
    fromBeginning: true,
  });
  const poisonKey = `poison:${randomUUID()}`;
  let resolveDeadLetter!: (value: {
    key_base64: string;
    value_base64: string;
  }) => void;
  const deadLetter = new Promise<{ key_base64: string; value_base64: string }>(
    (resolve) => {
      resolveDeadLetter = resolve;
    },
  );
  await deadLetters.run({
    autoCommit: false,
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const value = JSON.parse(message.value.toString()) as {
        key_base64: string;
        value_base64: string;
      };
      if (Buffer.from(value.key_base64, "base64").toString() === poisonKey)
        resolveDeadLetter(value);
    },
  });
  let resolveResult!: (value: InventoryResult) => void;
  const observed = new Promise<InventoryResult>((resolve) => {
    resolveResult = resolve;
  });
  await results.run({
    autoCommit: false,
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      let result: InventoryResult;
      try {
        result = JSON.parse(message.value.toString()) as InventoryResult;
      } catch {
        return;
      }
      if (result.saga_id === saga) resolveResult(result);
    },
  });
  debug("results running");
  let fatal: Error | undefined;
  const stop = await startInventorySagaWorker(
    db,
    [broker],
    `inventory-saga-test-${randomUUID()}`,
    (error) => {
      fatal = error;
    },
  );
  debug("worker running");
  t.after(stop);
  const command: InventoryCommand = {
    tenant_id: tenant,
    saga_id: saga,
    command_id: randomUUID(),
    step: "inventory.activate",
    saga_version: 3,
    fencing_token: 1,
    payload: { device_id: device, asset_id: asset },
  };
  const key = `${tenant}:${saga}`;
  await producer.send({
    topic: COMMAND_TOPIC,
    acks: -1,
    messages: [
      { key, value: JSON.stringify(command) },
      { key, value: JSON.stringify(command) },
    ],
  });
  debug("commands sent");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    observed,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`result timeout: ${fatal?.message ?? "no worker error"}`),
          ),
        20_000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  debug("result observed");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.command_id, command.command_id);
  await producer.send({
    topic: COMMAND_TOPIC,
    acks: -1,
    messages: [{ key: poisonKey, value: "{" }],
  });
  let deadLetterTimer: ReturnType<typeof setTimeout> | undefined;
  const quarantined = await Promise.race([
    deadLetter,
    new Promise<never>((_, reject) => {
      deadLetterTimer = setTimeout(
        () => reject(new Error("inventory command DLQ timeout")),
        20_000,
      );
    }),
  ]).finally(() => clearTimeout(deadLetterTimer));
  assert.equal(Buffer.from(quarantined.value_base64, "base64").toString(), "{");
  await withTenant(db, tenant, async (tx) => {
    const receipts = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM inventory_saga_receipts WHERE tenant_id=${tenant}::uuid AND command_id=${command.command_id}::uuid`;
    assert.equal(receipts[0]?.count, 1n);
  });
});
