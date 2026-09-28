import type { Db, Tx } from "./db.js";
import { withTenant } from "./db.js";
import { allowedReturnUrl } from "./config.js";
import type { BillingConfig } from "./config.js";
import { audit, context, outbox, type EventContext } from "./events.js";
import { freshId, nameId } from "./ids.js";
import { raiseFinding } from "./findings.js";
import { meterEventTime } from "./usage.js";
import type { StripePort } from "./stripe-port.js";
import { isPlanKey, type PlanKey } from "../catalog/plans.js";

type Kind = "create_customer" | "checkout" | "portal" | "meter_report";
interface CommandRow {
  command_id: string;
  kind: Kind;
  status: string;
  stripe_idempotency_key: string;
  payload: unknown;
  result: unknown;
  attempts: number;
}
export interface CommandReceipt {
  commandId: string;
  status: string;
  result?: unknown;
}

function idempotencyKey(value: string): string {
  if (!/^[\x21-\x7e]{1,200}$/.test(value))
    throw new Error("Idempotency-Key is required");
  return value;
}

async function queue(
  tx: Tx,
  tenantId: string,
  kind: Kind,
  commandId: string,
  payload: Record<string, unknown>,
  actor: string,
  ctx: EventContext,
): Promise<CommandReceipt> {
  const normalized = JSON.stringify(payload);
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_, entry: unknown) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
          )
        : entry,
    );
  const rows = await tx.$queryRaw<CommandRow[]>`INSERT INTO billing_commands
    (tenant_id, command_id, kind, stripe_idempotency_key, payload)
    VALUES (${tenantId}::uuid, ${commandId}::uuid, ${kind}, ${commandId}, ${normalized}::jsonb)
    ON CONFLICT (tenant_id, command_id) DO UPDATE SET command_id = EXCLUDED.command_id
    RETURNING command_id, kind, status, stripe_idempotency_key, payload, result, attempts`;
  const row = rows[0]!;
  if (row.kind !== kind || canonical(row.payload) !== canonical(payload))
    throw new Error(
      "Idempotency-Key was reused with a different billing request",
    );
  await outbox(
    tx,
    tenantId,
    "billing_command",
    commandId,
    1n,
    "billing.command_requested",
    { command_id: commandId, kind },
    ctx,
  );
  await audit(
    tx,
    tenantId,
    actor,
    `billing.${kind}.requested`,
    commandId,
    { kind },
    commandId,
  );
  return { commandId, status: row.status, result: row.result ?? undefined };
}

export class BillingCommands {
  constructor(
    private readonly db: Db,
    private readonly stripe: StripePort,
    private readonly config: Pick<BillingConfig, "returnOrigins">,
  ) {}

  async onTenantCreated(
    tenantId: string,
    sourceEventId: string,
  ): Promise<CommandReceipt> {
    const commandId = nameId("billing-customer", tenantId);
    return withTenant(this.db, tenantId, (tx) =>
      queue(
        tx,
        tenantId,
        "create_customer",
        commandId,
        { tenant_id: tenantId },
        "system",
        context(undefined, sourceEventId),
      ),
    );
  }

  async requestCheckout(
    tenantId: string,
    plan: string,
    successUrl: string,
    cancelUrl: string,
    key: string,
    actor: string,
    ctx = context(),
  ): Promise<CommandReceipt> {
    if (!isPlanKey(plan) || plan === "free")
      throw new Error("paid plan is required");
    const payload = {
      plan,
      success_url: allowedReturnUrl(successUrl, this.config.returnOrigins),
      cancel_url: allowedReturnUrl(cancelUrl, this.config.returnOrigins),
    };
    const commandId = nameId("billing-checkout", tenantId, idempotencyKey(key));
    return withTenant(this.db, tenantId, async (tx) => {
      // A per-tenant advisory lock serializes checkout requests: the subscription row may
      // not exist yet, so a row lock would cover zero rows and two sessions could both open.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 9))`;
      const active = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM subscriptions WHERE tenant_id=${tenantId}::uuid
          AND status IN ('active','trialing','past_due','unpaid','paused') FOR UPDATE`;
      if (active.length)
        throw new Error(
          "active subscription must be changed in billing portal",
        );
      const open = await tx.$queryRaw<{ command_id: string }[]>`
        SELECT command_id FROM billing_commands WHERE tenant_id=${tenantId}::uuid
          AND kind='checkout' AND status IN ('pending','running')
          AND command_id <> ${commandId}::uuid`;
      if (open.length)
        throw new Error("checkout already in progress for this tenant");
      const customers = await tx.$queryRaw<{ stripe_customer_id: string }[]>`
        SELECT stripe_customer_id FROM billing_customers WHERE tenant_id = ${tenantId}::uuid`;
      if (!customers.length)
        await queue(
          tx,
          tenantId,
          "create_customer",
          nameId("billing-customer", tenantId),
          { tenant_id: tenantId },
          "system",
          ctx,
        );
      return queue(tx, tenantId, "checkout", commandId, payload, actor, ctx);
    });
  }

  async requestPortal(
    tenantId: string,
    returnUrl: string,
    key: string,
    actor: string,
    ctx = context(),
  ): Promise<CommandReceipt> {
    const commandId = nameId("billing-portal", tenantId, idempotencyKey(key));
    return withTenant(this.db, tenantId, (tx) =>
      queue(
        tx,
        tenantId,
        "portal",
        commandId,
        { return_url: allowedReturnUrl(returnUrl, this.config.returnOrigins) },
        actor,
        ctx,
      ),
    );
  }

  async get(
    tenantId: string,
    commandId: string,
  ): Promise<CommandReceipt | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        CommandRow[]
      >`SELECT command_id, kind, status,
        stripe_idempotency_key, payload, result, attempts FROM billing_commands
        WHERE tenant_id = ${tenantId}::uuid AND command_id = ${commandId}::uuid`;
      const row = rows[0];
      return row
        ? {
            commandId: row.command_id,
            status: row.status,
            result: row.result ?? undefined,
          }
        : null;
    });
  }

  // Operator redrive of a quarantined command: same command ID and idempotency key, so
  // Stripe still sees one remote effect. Reason and actor are audited.
  async redriveCommand(
    tenantId: string,
    commandId: string,
    actor: string,
    reason: string,
  ): Promise<boolean> {
    if (!actor.trim() || !reason.trim() || reason.length > 500)
      throw new Error("redrive actor and reason are required");
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        { command_id: string }[]
      >`UPDATE billing_commands
        SET status='pending', attempts=0, last_error=NULL, updated_at=clock_timestamp()
        WHERE tenant_id=${tenantId}::uuid AND command_id=${commandId}::uuid
          AND status='quarantined' RETURNING command_id`;
      if (!rows.length) return false;
      await tx.$executeRaw`SELECT billing_inbox.reset_command_work(
        ${tenantId}::uuid, ${commandId}::uuid)`;
      await audit(tx, tenantId, actor, "billing.command.redriven", commandId, {
        reason,
      });
      return true;
    });
  }

  private async load(
    tenantId: string,
    commandId: string,
  ): Promise<CommandRow | null> {
    return withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        CommandRow[]
      >`SELECT command_id, kind, status,
        stripe_idempotency_key, payload, result, attempts FROM billing_commands
        WHERE tenant_id = ${tenantId}::uuid AND command_id = ${commandId}::uuid`;
      return rows[0] ?? null;
    });
  }

  private async customerId(tenantId: string): Promise<string | undefined> {
    const customers = await withTenant(
      this.db,
      tenantId,
      (tx) => tx.$queryRaw<
        { stripe_customer_id: string }[]
      >`SELECT stripe_customer_id FROM billing_customers
      WHERE tenant_id=${tenantId}::uuid`,
    );
    return customers[0]?.stripe_customer_id;
  }

  private async createCustomer(
    tenantId: string,
  ): Promise<Record<string, unknown>> {
    const customer = await this.stripe.createCustomer(
      tenantId,
      `customer:${tenantId}`,
    );
    if (customer.tenantId !== tenantId)
      throw new Error("Stripe customer tenant mismatch");
    await withTenant(this.db, tenantId, async (tx) => {
      await tx.$executeRaw`INSERT INTO billing_customers (tenant_id, stripe_customer_id)
        VALUES (${tenantId}::uuid, ${customer.id})
        ON CONFLICT (tenant_id) DO NOTHING`;
      const rows = await tx.$queryRaw<{ stripe_customer_id: string }[]>`
        SELECT stripe_customer_id FROM billing_customers WHERE tenant_id=${tenantId}::uuid`;
      if (rows[0]?.stripe_customer_id !== customer.id)
        throw new Error("different Stripe customer already bound to tenant");
      await tx.$executeRaw`INSERT INTO billing_inbox.customer_directory
        (stripe_customer_id, tenant_id) VALUES (${customer.id}, ${tenantId}::uuid)
        ON CONFLICT (stripe_customer_id) DO NOTHING`;
      const directories = await tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT tenant_id FROM billing_inbox.customer_directory WHERE stripe_customer_id=${customer.id}`;
      if (directories[0]?.tenant_id !== tenantId)
        throw new Error("Stripe customer belongs to another tenant");
    });
    return { stripe_customer_id: customer.id };
  }

  private async reportMeter(
    tenantId: string,
    row: CommandRow,
    customerId: string,
  ): Promise<Record<string, unknown>> {
    const payload = row.payload as {
      meter: string;
      period_start: string;
      quantity: string;
      event_time?: string;
    };
    const start = new Date(payload.period_start);
    // The event time is fixed in the command at close, so a retry repeats the same request.
    const eventTime = new Date(
      payload.event_time ?? meterEventTime(start, new Date()),
    );
    const result = await this.stripe.reportMeter(
      tenantId,
      payload.meter,
      eventTime,
      BigInt(payload.quantity),
      row.stripe_idempotency_key,
      customerId,
    );
    await withTenant(this.db, tenantId, async (tx) => {
      await tx.$executeRaw`UPDATE usage_periods SET state='reported', version=version+1
        WHERE tenant_id=${tenantId}::uuid AND meter=${payload.meter}
          AND period_start=${start} AND state='closed'`;
      await tx.$executeRaw`UPDATE usage_reports SET status='reported'
        WHERE tenant_id=${tenantId}::uuid AND meter=${payload.meter}
          AND period_start=${start} AND status='pending'`;
    });
    return result;
  }

  private async execute(
    tenantId: string,
    row: CommandRow,
    customerId: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (row.kind === "create_customer") return this.createCustomer(tenantId);
    if (!customerId) throw new Error("billing customer missing");
    if (row.kind === "checkout") {
      const payload = row.payload as {
        plan: PlanKey;
        success_url: string;
        cancel_url: string;
      };
      return this.stripe.createCheckout(
        customerId,
        tenantId,
        payload.plan,
        payload.success_url,
        payload.cancel_url,
        row.stripe_idempotency_key,
      );
    }
    if (row.kind === "portal") {
      const payload = row.payload as { return_url: string };
      return this.stripe.createPortal(
        customerId,
        payload.return_url,
        row.stripe_idempotency_key,
      );
    }
    return this.reportMeter(tenantId, row, customerId);
  }

  // Quarantine must never be silent: usage that is never billed and a checkout that never
  // opens are both operator-visible through billing.reconciliation_required.
  private async recordFailure(
    tenantId: string,
    row: CommandRow,
    error: unknown,
  ): Promise<void> {
    // Error class only. Provider responses may contain secrets or personal data.
    const safe = error instanceof Error ? error.constructor.name : "unknown";
    await withTenant(this.db, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; attempts: number }[]>`
        UPDATE billing_commands SET status=CASE WHEN attempts >= 5 THEN 'quarantined' ELSE 'pending' END,
          last_error=${safe}, updated_at=clock_timestamp()
        WHERE tenant_id=${tenantId}::uuid AND command_id=${row.command_id}::uuid
          AND status <> 'quarantined' RETURNING status, attempts`;
      if (rows[0]?.status !== "quarantined") return;
      const meter = (row.payload as { meter?: string }).meter;
      await raiseFinding(tx, tenantId, freshId(), freshId(), {
        objectType: row.kind === "meter_report" ? "meter" : "subscription",
        objectId: meter ?? row.command_id,
        diffClass: "command_quarantined",
        local: {
          command_id: row.command_id,
          kind: row.kind,
          attempts: rows[0].attempts,
          last_error: safe,
        },
        remote: {},
      });
    });
  }

  // Invoked with tenant + command ID from the committed outbox event. Running
  // commands are retryable: the Stripe idempotency key is stable across crashes.
  // Returns false when the command is not runnable yet (customer not created) or
  // quarantined; a not-yet-due wait is never counted as an attempt.
  async process(tenantId: string, commandId: string): Promise<boolean> {
    const row = await this.load(tenantId, commandId);
    if (!row) throw new Error("billing command not found");
    if (row.status === "completed") return true;
    if (row.status === "quarantined") return false;
    const customerId =
      row.kind === "create_customer"
        ? undefined
        : await this.customerId(tenantId);
    if (row.kind !== "create_customer" && !customerId) return false;
    await withTenant(
      this.db,
      tenantId,
      (tx) => tx.$executeRaw`
      UPDATE billing_commands SET status='running', attempts=attempts+1,
        updated_at=clock_timestamp() WHERE tenant_id=${tenantId}::uuid
        AND command_id=${commandId}::uuid AND status IN ('pending','running')`,
    );
    try {
      const result = await this.execute(tenantId, row, customerId);
      await withTenant(
        this.db,
        tenantId,
        (tx) => tx.$executeRaw`
        UPDATE billing_commands SET status='completed', result=${JSON.stringify(result)}::jsonb,
          last_error=NULL, updated_at=clock_timestamp()
        WHERE tenant_id=${tenantId}::uuid AND command_id=${commandId}::uuid`,
      );
      return true;
    } catch (error) {
      await this.recordFailure(tenantId, row, error);
      throw error;
    }
  }
}
