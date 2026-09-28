import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { copyTenantSnapshot, type OwnerIdentity } from "./pg-owner.js";

const tenantId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const source: OwnerIdentity = {
  shardId: "s1",
  incarnation: "11111111-1111-4111-8111-111111111111",
  epoch: "5",
};
const target: OwnerIdentity = {
  shardId: "s2",
  incarnation: "22222222-2222-4222-8222-222222222222",
  epoch: "6",
};

class CopyClient {
  readonly events: string[];
  readonly endpoint: "source" | "target";
  pending: QueryResultRow[] = [];
  committed = false;

  constructor(endpoint: "source" | "target", events: string[]) {
    this.endpoint = endpoint;
    this.events = events;
  }

  async query(sql: string): Promise<any> {
    const normalized = sql.trim().replace(/\s+/g, " ");
    this.events.push(`${this.endpoint}:${normalized}`);
    if (normalized.startsWith("SELECT shard_id"))
      return {
        rows: [
          {
            shard_id:
              this.endpoint === "source" ? source.shardId : target.shardId,
            incarnation:
              this.endpoint === "source"
                ? source.incarnation
                : target.incarnation,
            epoch: this.endpoint === "source" ? source.epoch : target.epoch,
            state: this.endpoint === "source" ? "fenced" : "prepared",
          },
        ],
      };
    if (normalized.startsWith("SELECT c.relname AS table_name"))
      return {
        rows: [
          {
            table_name: "tenant_rows",
            column_name: "id",
            data_type: "uuid",
            is_primary_key: true,
          },
          {
            table_name: "tenant_rows",
            column_name: "tenant_id",
            data_type: "uuid",
            is_primary_key: false,
          },
        ],
      };
    if (normalized.startsWith("SELECT child.relname AS table_name"))
      return { rows: [] };
    if (
      normalized.startsWith('SELECT "id","tenant_id" FROM public."tenant_rows"')
    ) {
      if (this.endpoint === "source")
        return {
          rows: [
            { id: "55555555-5555-4555-8555-555555555555", tenant_id: tenantId },
          ],
        };
      return { rows: [...this.pending] };
    }
    if (normalized.startsWith('SELECT 1 FROM public."tenant_rows"'))
      return { rows: [], rowCount: 0 };
    if (normalized.startsWith('INSERT INTO public."tenant_rows"')) {
      this.pending.push({
        id: "55555555-5555-4555-8555-555555555555",
        tenant_id: tenantId,
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized === "COMMIT") {
      this.committed = true;
      return { rows: [], rowCount: null };
    }
    if (normalized === "ROLLBACK") {
      this.pending = [];
      return { rows: [], rowCount: null };
    }
    return { rows: [], rowCount: null };
  }

  release() {}
}

function pools() {
  const events: string[] = [];
  const sourceClient = new CopyClient("source", events);
  const targetClient = new CopyClient("target", events);
  const sourcePool = {
    connect: async () => sourceClient,
  } as unknown as Pool;
  const targetPool = {
    connect: async () => targetClient,
  } as unknown as Pool;
  return { events, sourceClient, targetClient, sourcePool, targetPool };
}

test("copy receipt hook runs before target commit and failure rolls back imported rows", async () => {
  const value = pools();
  await assert.rejects(
    copyTenantSnapshot(
      value.sourcePool,
      value.targetPool,
      tenantId,
      operationId,
      source,
      target,
      async () => {
        value.events.push("owner-receipt:failed");
        throw new Error("receipt persistence failed");
      },
    ),
    /receipt persistence failed/,
  );
  assert.equal(value.targetClient.committed, false);
  assert.deepEqual(value.targetClient.pending, []);
  assert.ok(value.events.indexOf("owner-receipt:failed") >= 0);
  assert.equal(value.events.includes("target:COMMIT"), false);
  assert.ok(value.events.includes("target:ROLLBACK"));
  assert.ok(value.events.includes("source:ROLLBACK"));
});

test("source ownership is checked before snapshot selection and held through target commit", async () => {
  const value = pools();
  let hookCalled = false;
  const evidence = await copyTenantSnapshot(
    value.sourcePool,
    value.targetPool,
    tenantId,
    operationId,
    source,
    target,
    async (_targetClient, copyEvidence) => {
      hookCalled = true;
      assert.equal(copyEvidence.sourceSha256, copyEvidence.targetSha256);
      assert.ok(value.events.includes("source:COMMIT") === false);
    },
  );
  assert.equal(hookCalled, true);
  assert.equal(value.targetClient.committed, true);
  assert.equal(evidence.rowCount, "1");
  assert.ok(
    value.events.findIndex((event) =>
      event.startsWith("source:SELECT shard_id"),
    ) <
      value.events.findIndex((event) =>
        event.startsWith('source:SELECT "id","tenant_id"'),
      ),
  );
  assert.ok(
    value.events.indexOf("target:COMMIT") <
      value.events.indexOf("source:COMMIT"),
  );
});
