import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import { createDynamoFlagSnapshotStore } from "./dynamodb.js";

const live = process.env.DYNAMODB_LIVE === "1";
const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:28000";
const region = "us-east-1";
const credentials = { accessKeyId: "local", secretAccessKey: "local" };
const tableName = `greenguard-flags-${process.pid}`;
const client = new DynamoDBClient({ endpoint, region, credentials });
const store = createDynamoFlagSnapshotStore({
  tableName,
  endpoint,
  region,
  credentials,
});

after(async () => {
  if (live) {
    await client
      .send(new DeleteTableCommand({ TableName: tableName }))
      .catch(() => {});
    client.destroy();
  }
  store.close();
});

async function waitForDynamoDB(): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("DynamoDB Local did not become ready", { cause: lastError });
}

test(
  "10b DynamoDB snapshot adapter is tenant-scoped, monotonic and safe under races",
  { skip: !live },
  async () => {
    await waitForDynamoDB();
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        KeySchema: [{ AttributeName: "scope_key", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "scope_key", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );

    const tenantA = "0a0a0a0a-0000-4000-8000-00000000000a";
    const tenantB = "0b0b0b0b-0000-4000-8000-00000000000b";
    const flags = { "notifications.optional_sends": { value: true } };
    assert.equal(
      await store.apply({
        scope: "tenant",
        tenantId: tenantA,
        version: 3,
        flags,
      }),
      true,
    );
    assert.equal(
      await store.apply({
        scope: "tenant",
        tenantId: tenantA,
        version: 2,
        flags: {},
      }),
      false,
    );
    assert.equal(
      await store.apply({
        scope: "tenant",
        tenantId: tenantA,
        version: 3,
        flags: {},
      }),
      false,
    );
    assert.deepEqual(await store.get({ tenantId: tenantA }), {
      scope: "tenant",
      tenantId: tenantA,
      version: 3,
      flags,
    });
    assert.equal(await store.get({ tenantId: tenantB }), undefined);

    await store.apply({
      scope: "tenant",
      tenantId: tenantB,
      version: 1,
      flags: {},
    });
    await store.apply({
      scope: "global",
      version: 7,
      flags: { "maintenance.mode": { value: false } },
    });
    assert.equal((await store.get({ tenantId: tenantB }))?.version, 1);
    assert.deepEqual(await store.get({ global: true }), {
      scope: "global",
      version: 7,
      flags: { "maintenance.mode": { value: false } },
    });

    await Promise.all([
      store.apply({ scope: "tenant", tenantId: tenantA, version: 4, flags }),
      store.apply({ scope: "tenant", tenantId: tenantA, version: 5, flags }),
    ]);
    assert.equal((await store.get({ tenantId: tenantA }))?.version, 5);

    await assert.rejects(
      store.apply({
        scope: "tenant",
        tenantId: tenantB,
        version: 6,
        flags: {
          unsafe: { value: true, rolloutPercent: 101 },
        },
      }),
      /rollout/,
    );
  },
);
