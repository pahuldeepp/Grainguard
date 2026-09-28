import type { Db } from "./db.js";
import { withTenant } from "./db.js";
import { BillingCommands } from "./commands.js";
import { BillingWebhooks } from "./webhooks.js";
import { BillingUsage, type Meter } from "./usage.js";

export interface WorkerOptions {
  // A usage period closes only this long after it ends, so readings received in month M
  // and consumed shortly after midnight still bill to M.
  closeLagMs?: number;
  // ...and only while the reading consumer is within this lag of the topic head.
  maxConsumerLagMs?: number;
  consumerLagMs?: () => number;
}

interface WorkRow {
  tenant_id: string;
  command_id: string;
}

// The command index contains no customer or payment details. A lease lets another
// replica reclaim a command after a crash; Stripe receives the same idempotency key.
export class BillingWorker {
  private readonly closeLagMs: number;
  private readonly maxConsumerLagMs: number;
  private readonly consumerLagMs: () => number;

  constructor(
    private readonly db: Db,
    private readonly commands: BillingCommands,
    private readonly webhooks: BillingWebhooks,
    private readonly usage: BillingUsage,
    options: WorkerOptions = {},
  ) {
    this.closeLagMs = options.closeLagMs ?? 15 * 60_000;
    this.maxConsumerLagMs = options.maxConsumerLagMs ?? 60_000;
    this.consumerLagMs = options.consumerLagMs ?? (() => 0);
  }

  async processCommand(): Promise<boolean> {
    const rows = await this.db.$queryRaw<WorkRow[]>`
      SELECT tenant_id, command_id FROM billing_inbox.claim_command_work()`;
    const row = rows[0];
    if (!row) return false;
    let completed = false;
    try {
      completed = await this.commands.process(row.tenant_id, row.command_id);
    } catch {
      /* Failure state is durable on the command; the queue row backs off below. */
    }
    const receipt = await this.commands.get(row.tenant_id, row.command_id);
    const status =
      receipt?.status === "quarantined"
        ? "quarantined"
        : completed || receipt?.status === "completed"
          ? "completed"
          : "pending";
    // Exponential backoff (1s..5min) on the queue row: a not-yet-runnable or failing
    // command is not polled every second.
    await withTenant(
      this.db,
      row.tenant_id,
      (tx) => tx.$executeRaw`
      SELECT billing_inbox.finish_command_work(
        ${row.tenant_id}::uuid, ${row.command_id}::uuid, ${status})`,
    );
    return true;
  }

  async processWebhook(): Promise<boolean> {
    try {
      return await this.webhooks.processOne();
    } catch {
      return true;
    } // Quarantine/retry state is durable in the inbox.
  }

  async dueTransitions(now = new Date()): Promise<number> {
    const tenants = await this.db.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM billing_inbox.ready_due_tenants('subscription', ${now}, 100)`;
    let changed = 0;
    for (const { tenant_id } of tenants) {
      try {
        if (await this.webhooks.applyDueTransition(tenant_id, now)) changed++;
      } catch {
        /* Keep the due row for the next tick; continue other tenants. */
      }
    }
    return changed;
  }

  async closeDuePeriods(now = new Date()): Promise<number> {
    if (this.consumerLagMs() > this.maxConsumerLagMs) return 0;
    const cutoff = new Date(now.getTime() - this.closeLagMs);
    const tenants = await this.db.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM billing_inbox.ready_due_tenants('usage', ${cutoff}, 100)`;
    let closed = 0;
    for (const { tenant_id } of tenants) {
      try {
        const due = await withTenant(
          this.db,
          tenant_id,
          (tx) => tx.$queryRaw<{ meter: Meter; period_start: Date }[]>`
          SELECT meter, period_start FROM usage_periods WHERE tenant_id=${tenant_id}::uuid
            AND state='open' AND period_end <= ${cutoff}
          ORDER BY period_start, meter LIMIT 100`,
        );
        for (const { meter, period_start } of due) {
          await this.usage.closePeriod(
            tenant_id,
            meter,
            period_start,
            "system",
            now,
          );
          closed++;
        }
      } catch {
        /* Another tenant's due work remains runnable. */
      }
    }
    return closed;
  }

  async runOnce(now = new Date()): Promise<{
    commands: number;
    webhooks: number;
    transitions: number;
    periods: number;
  }> {
    let webhooks = 0;
    while (webhooks < 100 && (await this.processWebhook())) webhooks++;
    let commands = 0;
    while (commands < 100 && (await this.processCommand())) commands++;
    await this.webhooks.redriveQuarantined(now);
    return {
      commands,
      webhooks,
      transitions: await this.dueTransitions(now),
      periods: await this.closeDuePeriods(now),
    };
  }
}

export function startBillingWorker(
  worker: BillingWorker,
  intervalMs = 5_000,
): () => Promise<void> {
  let active = true;
  let busy = false;
  let current: Promise<void> | undefined;
  const tick = async () => {
    if (!active || busy) return;
    busy = true;
    try {
      await worker.runOnce();
    } catch {
      /* Retry on the next tick; individual rows retain durable state. */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    if (!busy) current = tick();
  }, intervalMs);
  current = tick();
  return async () => {
    active = false;
    clearInterval(timer);
    await current;
  };
}
