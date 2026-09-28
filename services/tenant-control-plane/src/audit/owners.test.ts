import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { AuditSources } from "./owners.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const incarnation = "22222222-2222-4222-8222-222222222222";

test("audit inventory pages admit only the resolved owner and restart exports after a move", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gg-audit-owner-test-"));
  let shardId = "s2",
    epoch = "5",
    state = "active",
    rejectAdmission = false;
  const calls: { endpoint: string; statements: string[] }[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer internal-test-token");
    assert.equal(request.url, `/v1/internal/placements/${tenantId}`);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        tenantId,
        shardId,
        shardIncarnation: incarnation,
        placementEpoch: epoch,
        state,
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connectionMock = mock.method(
    pg.Pool.prototype,
    "connect",
    async function (this: pg.Pool) {
      const call = {
        endpoint: this.options.connectionString!,
        statements: [] as string[],
      };
      calls.push(call);
      return {
        query: async (sql: string) => {
          call.statements.push(sql);
          if (rejectAdmission && sql.includes("admit_tenant_placement"))
            throw new Error("fenced owner");
          return { rows: [] };
        },
        release: () => {},
      } as unknown as pg.PoolClient;
    } as pg.Pool["connect"],
  );
  let sources: AuditSources | undefined;
  try {
    const registry = join(directory, "registry.json");
    await writeFile(
      registry,
      JSON.stringify({
        formatVersion: 1,
        service: "device-service",
        database: "greenguard_inventory",
        shards: Object.fromEntries(
          ["s1", "s2", "s3", "s4"].map((id, index) => [
            id,
            {
              incarnation,
              primaryUrl: `postgres://inventory_app:test@127.0.0.1:${5441 + index}/greenguard_inventory?sslmode=disable`,
              replicaUrls: [],
            },
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    sources = new AuditSources(
      "",
      "postgres://billing_app:test@127.0.0.1/greenguard_billing",
      {
        INVENTORY_SHARD_REGISTRY_FILE: registry,
        SHARD_LOCAL_LOOPBACK: "true",
        CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
        CONTROL_LOOKUP_TOKEN: "internal-test-token",
      },
    );
    const session = await sources.session(tenantId);
    const from = new Date("2026-01-01"),
      to = new Date("2026-12-01");
    await session.read("inventory", tenantId, from, to, null, 10);
    assert.ok(calls[0].endpoint.includes(":5442/"));
    assert.ok(
      calls[0].statements.findIndex((sql) =>
        sql.includes("admit_tenant_placement"),
      ) <
        calls[0].statements.findIndex((sql) =>
          sql.includes("FROM audit_events"),
        ),
    );
    assert.equal(calls[0].statements.at(-1), "COMMIT");
    await assert.rejects(
      session.read("inventory", incarnation, from, to, null, 10),
      /tenant mismatch/,
    );
    rejectAdmission = true;
    await assert.rejects(
      sources.read("inventory", tenantId, from, to, null, 10),
      /owner_admission_denied/,
    );
    assert.equal(calls[1].statements.at(-1), "ROLLBACK");
    assert.ok(
      !calls[1].statements.some((sql) => sql.includes("FROM audit_events")),
    );
    rejectAdmission = false;
    shardId = "s4";
    epoch = "6";
    await assert.rejects(
      session.read("inventory", tenantId, from, to, null, 10),
      /placement changed/,
    );
    assert.equal(calls.length, 2);
    const retry = await sources.session(tenantId);
    await retry.read("inventory", tenantId, from, to, null, 10);
    assert.ok(calls[2].endpoint.includes(":5444/"));
    state = "quiescing";
    await assert.rejects(
      sources.read("inventory", tenantId, from, to, null, 10),
      /tenant_quiescing/,
    );
    assert.equal(calls.length, 3);
    // Billing remains central and unaffected by the inventory route.
    await sources.read("billing", tenantId, from, to, null, 10);
    assert.ok(calls[3].endpoint.includes("greenguard_billing"));
    assert.ok(
      !calls[3].statements.some((sql) =>
        sql.includes("admit_tenant_placement"),
      ),
    );
  } finally {
    connectionMock.mock.restore();
    await sources?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
