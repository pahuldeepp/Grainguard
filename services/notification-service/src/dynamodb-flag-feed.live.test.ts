import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import kafkaJs from "kafkajs";
import { createDynamoFlagSnapshotStore } from "@greenguard/feature-flags";
import { startDynamoFlagFeed } from "./dynamodb-flag-feed.js";

const live = process.env.STAGE10B_KAFKA_LIVE === "1";
const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:28000";
const brokers = (process.env.KAFKA_BROKERS ?? "127.0.0.1:59092")
  .split(",")
  .map((broker) => broker.trim())
  .filter(Boolean);
const tableName = `gg-stage10b-${process.pid}`;
const region = "us-east-1";
const credentials = { accessKeyId: "local", secretAccessKey: "local" };
const dynamo = new DynamoDBClient({ endpoint, region, credentials });
const store = createDynamoFlagSnapshotStore({
  tableName,
  endpoint,
  region,
  credentials,
});
const { Kafka } = kafkaJs;
const kafka = new Kafka({ clientId: "greenguard-stage10b-live-test", brokers });
const producer = kafka.producer();
let stopFeed: (() => Promise<void>) | undefined;

after(async () => {
  await stopFeed?.();
  await producer.disconnect().catch(() => {});
  if (live) {
    await dynamo
      .send(new DeleteTableCommand({ TableName: tableName }))
      .catch(() => {});
    dynamo.destroy();
  }
  store.close();
});

async function waitForDynamo(): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await dynamo.send(new ListTablesCommand({}));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("DynamoDB Local did not become ready", { cause: lastError });
}

test(
  "10b Kafka config events durably project into tenant-isolated DynamoDB snapshots",
  { skip: !live },
  async () => {
    await waitForDynamo();
    await dynamo.send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: [{ AttributeName: "scope_key", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "scope_key", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    await producer.connect();
    stopFeed = startDynamoFlagFeed(store, brokers, {
      groupId: `greenguard-stage10b-${process.pid}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tenantId = "10101010-0000-4000-8000-000000000010";
    const event = {
      event_id: `stage10b-${process.pid}`,
      event_type: "flag.configuration_changed",
      schema_version: 1,
      tenant_id: tenantId,
      aggregate_version: "1",
      payload: {
        scope: "tenant",
        config_version: "1",
        flags: { "stage10.dynamodb.live": { value: true } },
      },
    };
    await producer.send({
      topic: "greenguard.platform.config.v1",
      messages: [{ key: `${tenantId}:1`, value: JSON.stringify(event) }],
    });

    const deadline = Date.now() + 15_000;
    let snapshot;
    while (Date.now() < deadline) {
      snapshot = await store.get({ tenantId });
      if (snapshot?.version === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(snapshot, {
      scope: "tenant",
      tenantId,
      version: 1,
      flags: { "stage10.dynamodb.live": { value: true } },
    });
  },
);
