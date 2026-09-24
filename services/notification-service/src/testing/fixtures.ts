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
    severity: "critical",
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
  return url ? new pg.Pool({ connectionString: url, max: 8 }) : null;
}
