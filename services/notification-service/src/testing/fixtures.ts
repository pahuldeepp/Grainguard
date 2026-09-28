import { createOwnerDatabase } from "@greenguard/membership-client/owner-db";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { LocalTestAdapter } from "../adapters.js";
import type { Broker, IncomingTask, Publish } from "../broker.js";
import { Metrics } from "../metrics.js";
import { Semaphore } from "../pool.js";
import type { Task } from "../task.js";
import type { Deps, Policy } from "../worker.js";

export class FakeBroker implements Broker {
  readonly published: Publish[] = [];
  failWith: Error | null = null;

  async publish(message: Publish): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.published.push(message);
  }

  keys(): string[] {
    return this.published.map((p) => p.key);
  }
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    intent_id: randomUUID(),
    tenant_id: randomUUID(),
    channel: "email",
    transition: "alert.opened",
    severity: "warning",
    alert_id: randomUUID(),
    episode_id: randomUUID(),
    transition_version: 1,
    delivery_generation: 0,
    correlation_id: randomUUID(),
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    ...overrides,
  };
}

export function incoming(task: Task, attempt = 0): IncomingTask {
  return {
    body: Buffer.from(JSON.stringify(task)),
    messageId: task.intent_id,
    headers: { "x-attempt": attempt },
    timestamp: Math.floor(Date.now() / 1000),
  };
}

export const testPolicy: Policy = {
  maxAttempts: 3,
  maxReconciles: 2,
  baseBackoffMs: 10,
  maxBackoffMs: 40,
  providerTimeoutMs: 50,
};

export function makeDeps(pool: pg.Pool, adapter = new LocalTestAdapter()) {
  const broker = new FakeBroker();
  const deps: Deps = {
    pool,
    broker,
    adapter: () => adapter,
    providers: new Semaphore(2),
    policy: testPolicy,
    metrics: new Metrics(),
  };
  return { deps, broker, adapter };
}

/** Runtime-role pool on the direct port, or null when the database is not configured. */
export function testPool(): pg.Pool | null {
  const url = process.env.NOTIFICATIONS_DIRECT_URL;
  if (!url) return null;
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const incarnation = "20000000-0000-4000-8000-000000000091";
  const shards = Object.fromEntries(
    [1, 2, 3, 4].map((n) => {
      const endpoint = new URL(url);
      endpoint.port = String(Number(endpoint.port || 5432) + n - 1);
      return [
        `s${n}`,
        { incarnation, primaryUrl: endpoint.toString(), replicaUrls: [] },
      ];
    }),
  );
  createOwnerDatabase<pg.Pool>({
    legacyUrl: url,
    env: { SHARD_REGISTRY_FILE: "test-fixture", SHARD_LOCAL_LOOPBACK: "true" },
    service: "notification-service",
    database: "greenguard_notifications",
    roles: ["notifications_app"],
    readRegistry: () =>
      JSON.stringify({
        formatVersion: 1,
        service: "notification-service",
        database: "greenguard_notifications",
        shards,
      }),
    resolve: async (tenantId) => {
      const adminUrl = new URL(process.env.POSTGRES_ADMIN_URL!);
      adminUrl.pathname = "/greenguard_notifications";
      const admin = new pg.Client({ connectionString: adminUrl.toString() });
      await admin.connect();
      try {
        await admin.query(
          "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,1,'active') ON CONFLICT(tenant_id) DO NOTHING",
          [tenantId, incarnation],
        );
      } finally {
        await admin.end();
      }
      return {
        tenantId,
        shardId: "s1",
        shardIncarnation: incarnation,
        placementEpoch: "1",
        state: "active",
        expiresAt: new Date(Date.now() + 1900).toISOString(),
      };
    },
    create: () => pool,
    close: (client) => client.end(),
  });
  return pool;
}
