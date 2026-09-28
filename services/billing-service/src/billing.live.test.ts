import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, test } from "node:test";
import Stripe from "stripe";
import pg from "pg";
import { createDb, withTenant } from "./db.js";
import { BillingCommands } from "./commands.js";
import { BillingWebhooks, TenantMismatch } from "./webhooks.js";
import { BillingUsage, monthStart, nextMonth } from "./usage.js";
import { BillingWorker } from "./worker.js";
import { BillingReconciliation } from "./reconciliation.js";
import { createBillingApp } from "./app.js";
import { AuthError } from "@greenguard/tenant-auth";
import type {
  StripePort,
  CustomerView,
  SubscriptionView,
  InvoiceView,
  DisputeView,
} from "./stripe-port.js";

const enabled = Boolean(
  process.env.BILLING_DATABASE_URL && process.env.POSTGRES_ADMIN_URL,
);
const db = enabled ? createDb(process.env.BILLING_DATABASE_URL!) : null;
after(async () => {
  await db?.$disconnect();
});
const secret = "whsec_billinglivetest";
const signer = new Stripe("sk_test_signature_verification_only");
const key = Buffer.alloc(32, 7);
const returnOrigins = ["http://127.0.0.1:5173"];
const hex = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

class FakeStripe implements StripePort {
  customers = new Map<string, CustomerView>();
  subscriptions = new Map<string, SubscriptionView>();
  checkout = new Map<string, { id: string; url: string }>();
  reports = new Map<string, bigint>();
  invoices = new Map<string, InvoiceView>();
  failCheckoutOnce = false;
  failMeter = false;
  checkoutCalls = 0;
  reportTimes = new Map<string, Date>();
  canceled: string[] = [];

  async createCustomer(tenantId: string): Promise<CustomerView> {
    const customer = { id: `cus_${tenantId.replaceAll("-", "")}`, tenantId };
    this.customers.set(customer.id, customer);
    return customer;
  }
  async retrieveCustomer(id: string) {
    return this.customers.get(id)!;
  }
  async createCheckout(
    _customerId: string,
    _tenantId: string,
    _plan: "free" | "standard" | "enterprise",
    _success: string,
    _cancel: string,
    idempotencyKey: string,
  ) {
    this.checkoutCalls++;
    const value = this.checkout.get(idempotencyKey) ?? {
      id: `cs_${hex(idempotencyKey)}`,
      url: `https://checkout.stripe.test/${hex(idempotencyKey)}`,
    };
    this.checkout.set(idempotencyKey, value);
    if (this.failCheckoutOnce) {
      this.failCheckoutOnce = false;
      throw new Error("network reset after Stripe call");
    }
    return value;
  }
  async createPortal(
    _customerId: string,
    _returnUrl: string,
    idempotencyKey: string,
  ) {
    return {
      id: `bps_${hex(idempotencyKey)}`,
      url: `https://billing.stripe.test/${hex(idempotencyKey)}`,
    };
  }
  async retrieveSubscription(id: string) {
    return this.subscriptions.get(id)!;
  }
  async retrieveInvoice(id: string) {
    return this.invoices.get(id)!;
  }
  async retrieveDispute(id: string): Promise<DisputeView> {
    return { id, customerId: "", status: "open", amount: 0, currency: "usd" };
  }
  async reportMeter(
    _tenantId: string,
    _meter: string,
    eventTime: Date,
    quantity: bigint,
    identifier: string,
  ) {
    if (this.failMeter) throw new Error("Stripe unavailable");
    this.reports.set(identifier, quantity);
    this.reportTimes.set(identifier, eventTime);
    return { identifier };
  }
  async cancelSubscription(id: string) {
    this.canceled.push(id);
    const current = this.subscriptions.get(id);
    if (current) this.subscriptions.set(id, { ...current, status: "canceled" });
  }
  async listSubscriptions(customerId: string) {
    return [...this.subscriptions.values()].filter(
      (s) => s.customerId === customerId,
    );
  }
  async listInvoices(customerId: string) {
    return [...this.invoices.values()].filter(
      (i) => i.customerId === customerId,
    );
  }
  async listMeterSummaries() {
    return Object.fromEntries(
      [...this.reports].map(([identifier, quantity]) => [
        identifier.includes("active_devices")
          ? "active_devices"
          : "accepted_readings",
        quantity,
      ]),
    );
  }
}

async function admin<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = new URL(process.env.POSTGRES_ADMIN_URL!);
  url.pathname = "/greenguard_billing";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

async function fixture() {
  const tenantId = randomUUID();
  const stripe = new FakeStripe();
  const commands = new BillingCommands(db!, stripe, { returnOrigins });
  const webhooks = new BillingWebhooks(db!, stripe, {
    secrets: [secret],
    encryptionKey: key,
    graceDays: 14,
  });
  const usage = new BillingUsage(db!);
  const customerCommand = await commands.onTenantCreated(
    tenantId,
    randomUUID(),
  );
  await commands.process(tenantId, customerCommand.commandId);
  const customerId = `cus_${tenantId.replaceAll("-", "")}`;
  const subscriptionId = `sub_${tenantId.replaceAll("-", "")}`;
  const view = (changes: Partial<SubscriptionView> = {}): SubscriptionView => ({
    id: subscriptionId,
    customerId,
    tenantId,
    status: "active",
    planKey: "standard",
    periodStart: new Date(Date.now() - 3600_000),
    periodEnd: new Date(Date.now() + 3600_000),
    cancelAtPeriodEnd: false,
    created: Math.floor(Date.now() / 1000) - 3600,
    ...changes,
  });
  return {
    tenantId,
    stripe,
    commands,
    webhooks,
    usage,
    customerId,
    subscriptionId,
    view,
  };
}

async function signed(
  f: Awaited<ReturnType<typeof fixture>>,
  type: string,
  changes: Record<string, unknown> = {},
  created = Math.floor(Date.now() / 1000),
) {
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const raw = Buffer.from(
    JSON.stringify({
      id: eventId,
      object: "event",
      type,
      created,
      data: {
        object: {
          id: f.subscriptionId,
          customer: f.customerId,
          metadata: { tenant_id: f.tenantId },
          ...changes,
        },
      },
    }),
  );
  const signature = signer.webhooks.generateTestHeaderString({
    payload: raw.toString("utf8"),
    secret,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return { eventId, raw, signature };
}

async function subscription(tenantId: string) {
  const rows = await withTenant(
    db!,
    tenantId,
    (tx) => tx.$queryRaw<
      {
        status: string;
        plan_key: string;
        entitlement_plan_key: string;
        pending_plan_key: string | null;
        version: bigint;
      }[]
    >`
    SELECT status, plan_key, entitlement_plan_key, pending_plan_key, version
      FROM subscriptions WHERE tenant_id=${tenantId}::uuid`,
  );
  return rows[0];
}

test(
  "B03 duplicate Stripe event has one subscription and entitlement effect",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(f.subscriptionId, f.view());
    const event = await signed(f, "customer.subscription.created");
    assert.equal(
      (await f.webhooks.receive(event.raw, event.signature)).duplicate,
      false,
    );
    assert.equal(
      (await f.webhooks.receive(event.raw, event.signature)).duplicate,
      true,
    );
    assert.equal(await f.webhooks.processOne(event.eventId), true);
    assert.equal(await f.webhooks.processOne(event.eventId), false);
    assert.equal((await subscription(f.tenantId))?.version, 1n);
    const rows = await admin<{ count: string }>(
      `SELECT count(*) FROM outbox_events
    WHERE tenant_id=$1 AND event_type='entitlements.changed'`,
      [f.tenantId],
    );
    assert.equal(rows[0]?.count, "1");
  },
);

test(
  "B04 reordered updated then created events retain the current remote state",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ status: "active", planKey: "enterprise" }),
    );
    const newer = await signed(
      f,
      "customer.subscription.updated",
      {},
      Math.floor(Date.now() / 1000),
    );
    const older = await signed(
      f,
      "customer.subscription.created",
      {},
      Math.floor(Date.now() / 1000) - 20,
    );
    await f.webhooks.receive(newer.raw, newer.signature);
    await f.webhooks.processOne(newer.eventId);
    await f.webhooks.receive(older.raw, older.signature);
    await f.webhooks.processOne(older.eventId);
    assert.equal((await subscription(f.tenantId))?.plan_key, "enterprise");
    assert.equal((await subscription(f.tenantId))?.version, 1n);
  },
);

test(
  "B05 restart after inbox commit and after tenant commit applies once",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(f.subscriptionId, f.view());
    const event = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(event.raw, event.signature);
    const restarted = new BillingWebhooks(db!, f.stripe, {
      secrets: [secret],
      encryptionKey: key,
      graceDays: 14,
    });
    await assert.rejects(
      restarted.processOne(event.eventId, () => {
        throw new Error("simulated crash after tenant commit");
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(await restarted.processOne(event.eventId), true);
    assert.equal((await subscription(f.tenantId))?.version, 1n);
  },
);

test(
  "B06 retry after Stripe call uses one Checkout Session",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const receipt = await f.commands.requestCheckout(
      f.tenantId,
      "standard",
      "http://127.0.0.1:5173/success",
      "http://127.0.0.1:5173/cancel",
      randomUUID(),
      "admin",
    );
    f.stripe.failCheckoutOnce = true;
    await assert.rejects(f.commands.process(f.tenantId, receipt.commandId));
    assert.equal(await f.commands.process(f.tenantId, receipt.commandId), true);
    assert.equal(f.stripe.checkout.size, 1);
    assert.equal(
      (await f.commands.get(f.tenantId, receipt.commandId))?.status,
      "completed",
    );
  },
);

test(
  "B07 cancel at period end lowers entitlements only at the boundary",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const end = new Date(Date.now() + 60_000);
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ cancelAtPeriodEnd: true, periodEnd: end }),
    );
    const event = await signed(f, "customer.subscription.updated");
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "standard",
    );
    await f.webhooks.applyDueTransition(
      f.tenantId,
      new Date(end.getTime() + 1),
    );
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "free",
    );
  },
);

test(
  "B08 downgrade below current usage retains plan until period boundary",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const end = new Date(Date.now() + 60_000);
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ planKey: "enterprise", periodEnd: end }),
    );
    let event = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    await f.usage.recordReadings(f.tenantId, [
      { eventId: randomUUID(), acceptedAt: new Date() },
    ]);
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ planKey: "standard", periodEnd: end }),
    );
    event = await signed(
      f,
      "customer.subscription.updated",
      {},
      Math.floor(Date.now() / 1000) + 1,
    );
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "enterprise",
    );
    assert.equal(
      (await subscription(f.tenantId))?.pending_plan_key,
      "standard",
    );
    await f.webhooks.applyDueTransition(
      f.tenantId,
      new Date(end.getTime() - 1),
    );
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "enterprise",
    );
    await f.webhooks.applyDueTransition(
      f.tenantId,
      new Date(end.getTime() + 1),
    );
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "standard",
    );
  },
);

test(
  "B09 past_due grace ends in free limits; unpaid is immediate",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ status: "past_due" }),
    );
    const event = await signed(f, "customer.subscription.updated");
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "standard",
    );
    await f.webhooks.applyDueTransition(
      f.tenantId,
      new Date(Date.now() + 15 * 86400_000),
    );
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "free",
    );
    f.stripe.subscriptions.set(f.subscriptionId, f.view({ status: "unpaid" }));
    const unpaid = await signed(
      f,
      "customer.subscription.updated",
      {},
      Math.floor(Date.now() / 1000) + 2,
    );
    await f.webhooks.receive(unpaid.raw, unpaid.signature);
    await f.webhooks.processOne(unpaid.eventId);
    assert.equal((await subscription(f.tenantId))?.status, "unpaid");
  },
);

test(
  "B10 meter resend uses one identifier and one remote effect",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const previous = monthStart(new Date(Date.UTC(2025, 0, 15)));
    await f.usage.recordReadings(f.tenantId, [
      { eventId: randomUUID(), acceptedAt: previous },
    ]);
    const closed = await f.usage.closePeriod(
      f.tenantId,
      "accepted_readings",
      previous,
      "system",
    );
    assert.equal(await f.commands.process(f.tenantId, closed.commandId), true);
    assert.equal(await f.commands.process(f.tenantId, closed.commandId), true);
    assert.equal(f.stripe.reports.size, 1);
    assert.equal([...f.stripe.reports.values()][0], 1n);
  },
);

test(
  "B11 close racing a late reading attributes it to exactly one period with matching totals",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const february = monthStart(new Date(Date.UTC(2025, 1, 15)));
    const march = nextMonth(february);
    const eventId = randomUUID();
    await Promise.all([
      f.usage.recordReadings(f.tenantId, [{ eventId, acceptedAt: february }]),
      f.usage.closePeriod(f.tenantId, "accepted_readings", february, "system"),
    ]);
    await f.usage.recordReadings(f.tenantId, [
      { eventId, acceptedAt: february },
    ]);
    const totals = async (start: Date) =>
      (
        await withTenant(
          db!,
          f.tenantId,
          (tx) => tx.$queryRaw<
            {
              total: bigint;
              state: string;
            }[]
          >`SELECT total, state FROM usage_periods
      WHERE tenant_id=${f.tenantId}::uuid AND meter='accepted_readings'
        AND period_start=${start}`,
        )
      )[0];
    const feb = await totals(february);
    const mar = await totals(march);
    const report = (
      await admin<{ quantity: string }>(
        `SELECT quantity FROM usage_reports
    WHERE tenant_id=$1 AND period_start=$2`,
        [f.tenantId, february],
      )
    )[0];
    assert.equal(feb?.state !== "open", true, "February closed");
    assert.equal(
      String((feb?.total ?? 0n) + (mar?.total ?? 0n)),
      "1",
      "one unit in total",
    );
    // The reported quantity must equal what the closed period holds: a misattributed
    // unit would show in the wrong period or leave the report out of step.
    assert.equal(report?.quantity, String(feb?.total));
    const late = await admin<{ late: boolean; attributed: Date }>(
      `SELECT late,
    attributed_period_start AS attributed FROM usage_sources WHERE tenant_id=$1
    AND source_event_id=$2`,
      [f.tenantId, eventId],
    );
    assert.equal(late.length, 1);
    const inFeb = late[0]!.attributed.getTime() === february.getTime();
    assert.equal(late[0]!.late, !inFeb);
    assert.equal(feb?.total, inFeb ? 1n : 0n);
    assert.equal(mar?.total ?? 0n, inFeb ? 0n : 1n);
  },
);

test(
  "F4 usage period stays open through the close lag so late-consumed readings bill to their month",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const january = monthStart(new Date(Date.UTC(2020, 0, 15)));
    const end = nextMonth(january);
    await f.usage.recordReadings(f.tenantId, [
      { eventId: randomUUID(), acceptedAt: january },
    ]);
    const worker = new BillingWorker(db!, f.commands, f.webhooks, f.usage);
    await worker.closeDuePeriods(new Date(end.getTime() + 60_000));
    const early = (
      await admin<{ state: string }>(
        `SELECT state FROM usage_periods
    WHERE tenant_id=$1 AND meter='accepted_readings' AND period_start=$2`,
        [f.tenantId, january],
      )
    )[0];
    assert.equal(
      early?.state,
      "open",
      "not closed one minute after the period ends",
    );
    await f.usage.recordReadings(f.tenantId, [
      { eventId: randomUUID(), acceptedAt: january },
    ]);
    await worker.closeDuePeriods(new Date(end.getTime() + 16 * 60_000));
    const rows = await admin<{
      period_start: Date;
      total: string;
      state: string;
    }>(
      `SELECT period_start, total::text, state FROM usage_periods WHERE tenant_id=$1
      AND meter='accepted_readings' ORDER BY period_start`,
      [f.tenantId],
    );
    assert.deepEqual(
      rows.map((row) => [row.period_start.toISOString(), row.total, row.state]),
      [[january.toISOString(), "2", "closed"]],
    );
  },
);

test(
  "F4 a lagging consumer defers the period close",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const january = monthStart(new Date(Date.UTC(2020, 0, 15)));
    await f.usage.recordReadings(f.tenantId, [
      { eventId: randomUUID(), acceptedAt: january },
    ]);
    const worker = new BillingWorker(db!, f.commands, f.webhooks, f.usage, {
      consumerLagMs: () => 3_600_000,
    });
    const later = new Date(nextMonth(january).getTime() + 3_600_000);
    assert.equal(await worker.closeDuePeriods(later), 0);
    const caughtUp = new BillingWorker(db!, f.commands, f.webhooks, f.usage, {
      consumerLagMs: () => 0,
    });
    assert.equal(await caughtUp.closeDuePeriods(later), 1);
  },
);

test(
  "F4 meter events use an accepted event time and quarantine raises reconciliation_required",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const old = monthStart(new Date(Date.UTC(2025, 0, 15)));
    await f.usage.recordReadings(f.tenantId, [
      { eventId: randomUUID(), acceptedAt: old },
    ]);
    const closed = await f.usage.closePeriod(
      f.tenantId,
      "accepted_readings",
      old,
      "system",
    );
    assert.equal(await f.commands.process(f.tenantId, closed.commandId), true);
    const sent = [...f.stripe.reportTimes.values()][0]!;
    assert.ok(
      sent.getTime() >= Date.now() - 35 * 86_400_000,
      "inside Stripe's 35 day window",
    );
    assert.ok(sent.getTime() <= Date.now() + 5 * 60_000);

    const g = await fixture();
    const period = monthStart(new Date(Date.UTC(2025, 2, 15)));
    await g.usage.recordReadings(g.tenantId, [
      { eventId: randomUUID(), acceptedAt: period },
    ]);
    const failing = await g.usage.closePeriod(
      g.tenantId,
      "accepted_readings",
      period,
      "system",
    );
    g.stripe.failMeter = true;
    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(g.commands.process(g.tenantId, failing.commandId));
    assert.equal(
      (await g.commands.get(g.tenantId, failing.commandId))?.status,
      "quarantined",
    );
    const alerts = await admin<{
      payload: { object_type: string; diff_class: string };
    }>(
      `SELECT payload FROM outbox_events WHERE tenant_id=$1
      AND event_type='billing.reconciliation_required'`,
      [g.tenantId],
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.payload.object_type, "meter");
    assert.equal(alerts[0]?.payload.diff_class, "command_quarantined");
    g.stripe.failMeter = false;
    assert.equal(
      await g.commands.redriveCommand(
        g.tenantId,
        failing.commandId,
        "operator",
        "stripe recovered",
      ),
      true,
    );
    assert.equal(await g.commands.process(g.tenantId, failing.commandId), true);
    assert.equal(g.stripe.reports.size, 1);
  },
);

test(
  "F4 waiting for the customer neither counts an attempt nor busy-loops",
  { skip: !enabled },
  async () => {
    const tenantId = randomUUID();
    const stripe = new FakeStripe();
    const commands = new BillingCommands(db!, stripe, { returnOrigins });
    const usage = new BillingUsage(db!);
    const webhooks = new BillingWebhooks(db!, stripe, {
      secrets: [secret],
      encryptionKey: key,
      graceDays: 14,
    });
    const receipt = await commands.requestPortal(
      tenantId,
      "http://127.0.0.1:5173/account",
      randomUUID(),
      "admin",
    );
    assert.equal(await commands.process(tenantId, receipt.commandId), false);
    const row = (
      await admin<{ attempts: number }>(
        `SELECT attempts FROM billing_commands
    WHERE tenant_id=$1`,
        [tenantId],
      )
    )[0];
    assert.equal(row?.attempts, 0);
    const worker = new BillingWorker(db!, commands, webhooks, usage);
    const workRow = async () =>
      (
        await admin<{ available_at: Date }>(
          `SELECT available_at FROM billing_inbox.command_work WHERE tenant_id=$1`,
          [tenantId],
        )
      )[0]!;
    for (
      let index = 0;
      index < 300 && (await workRow()).available_at <= new Date();
      index++
    )
      await worker.processCommand();
    assert.ok(
      (await workRow()).available_at.getTime() > Date.now(),
      "waiting command is backed off",
    );
    const command = (
      await admin<{ attempts: number }>(
        `SELECT attempts FROM billing_commands
    WHERE tenant_id=$1`,
        [tenantId],
      )
    )[0];
    assert.equal(command?.attempts, 0);
  },
);

test(
  "F4 concurrent Checkout requests create one Checkout command",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const request = () =>
      f.commands.requestCheckout(
        f.tenantId,
        "standard",
        "http://127.0.0.1:5173/success",
        "http://127.0.0.1:5173/cancel",
        randomUUID(),
        "admin",
      );
    const results = await Promise.allSettled([request(), request(), request()]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rows = await admin<{ count: string }>(
      `SELECT count(*) FROM billing_commands
    WHERE tenant_id=$1 AND kind='checkout'`,
      [f.tenantId],
    );
    assert.equal(rows[0]?.count, "1");
  },
);

test(
  "F4 a duplicate completed subscription is cancelled and raised for reconciliation",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(f.subscriptionId, f.view());
    const first = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(first.raw, first.signature);
    await f.webhooks.processOne(first.eventId);
    const secondId = `sub_second${f.tenantId.replaceAll("-", "")}`;
    f.stripe.subscriptions.set(
      secondId,
      f.view({ id: secondId, planKey: "enterprise" }),
    );
    const second = await signed(
      f,
      "customer.subscription.created",
      { id: secondId },
      Math.floor(Date.now() / 1000) + 5,
    );
    await f.webhooks.receive(second.raw, second.signature);
    assert.equal(await f.webhooks.processOne(second.eventId), true);
    assert.deepEqual(f.stripe.canceled, [secondId]);
    assert.equal((await subscription(f.tenantId))?.plan_key, "standard");
    const alerts = await admin<{
      payload: { diff_class: string; object_id: string };
    }>(
      `SELECT payload FROM outbox_events WHERE tenant_id=$1
      AND event_type='billing.reconciliation_required'`,
      [f.tenantId],
    );
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.payload.diff_class, "duplicate_subscription");
    assert.equal(alerts[0]?.payload.object_id, secondId);
    const inbox = await admin<{ status: string }>(
      `SELECT status FROM billing_inbox.stripe_webhook_inbox
    WHERE event_id=$1`,
      [second.eventId],
    );
    assert.equal(inbox[0]?.status, "applied");
  },
);

test(
  "F4 paused keeps the paid entitlement; incomplete_expired grants none",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ planKey: "enterprise" }),
    );
    let event = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ planKey: "enterprise", status: "paused" }),
    );
    event = await signed(
      f,
      "customer.subscription.updated",
      {},
      Math.floor(Date.now() / 1000) + 3,
    );
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    const paused = await subscription(f.tenantId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.entitlement_plan_key, "enterprise");
    await f.webhooks.applyDueTransition(
      f.tenantId,
      new Date(Date.now() + 90 * 86_400_000),
    );
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "enterprise",
    );

    const g = await fixture();
    g.stripe.subscriptions.set(
      g.subscriptionId,
      g.view({ status: "canceled" }),
    );
    const expired = await signed(g, "customer.subscription.updated");
    await g.webhooks.receive(expired.raw, expired.signature);
    await g.webhooks.processOne(expired.eventId);
    assert.equal(
      (await subscription(g.tenantId))?.entitlement_plan_key,
      "free",
    );
  },
);

test(
  "F4 quarantined transient webhook failures are redriven with bounded backoff",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(f.subscriptionId, f.view());
    const event = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(event.raw, event.signature);
    await admin(
      `UPDATE billing_inbox.stripe_webhook_inbox SET attempts=9 WHERE event_id=$1`,
      [event.eventId],
    );
    const original = f.stripe.retrieveSubscription.bind(f.stripe);
    f.stripe.retrieveSubscription = async () => {
      throw new Error("Stripe outage");
    };
    await assert.rejects(f.webhooks.processOne(event.eventId));
    const state = async () =>
      (
        await admin<{ status: string; auto_redrives: number }>(
          `SELECT status, auto_redrives FROM billing_inbox.stripe_webhook_inbox WHERE event_id=$1`,
          [event.eventId],
        )
      )[0];
    assert.equal((await state())?.status, "quarantined");
    // The sweep is global: exhaust the automatic budget of rows left by other runs.
    await admin(
      `UPDATE billing_inbox.stripe_webhook_inbox SET auto_redrives=6
    WHERE status='quarantined' AND event_id<>$1`,
      [event.eventId],
    );
    assert.equal(
      await f.webhooks.redriveQuarantined(new Date()),
      0,
      "backoff not elapsed",
    );
    assert.equal(
      await f.webhooks.redriveQuarantined(new Date(Date.now() + 3_600_000)),
      1,
    );
    assert.equal((await state())?.status, "pending");
    assert.equal((await state())?.auto_redrives, 1);
    f.stripe.retrieveSubscription = original;
    await admin(
      `UPDATE billing_inbox.stripe_webhook_inbox SET lease_until=NULL WHERE event_id=$1`,
      [event.eventId],
    );
    assert.equal(await f.webhooks.processOne(event.eventId), true);
    assert.equal((await subscription(f.tenantId))?.plan_key, "standard");
    await admin(
      `UPDATE billing_inbox.stripe_webhook_inbox SET status='quarantined',
    auto_redrives=6, last_error='Error' WHERE event_id=$1`,
      [event.eventId],
    );
    assert.equal(
      await f.webhooks.redriveQuarantined(
        new Date(Date.now() + 30 * 86_400_000),
      ),
      0,
      "bounded: operator redrive only after the automatic budget",
    );
    await admin(
      `UPDATE billing_inbox.stripe_webhook_inbox SET auto_redrives=0, last_error='TenantMismatch'
    WHERE event_id=$1`,
      [event.eventId],
    );
    assert.equal(
      await f.webhooks.redriveQuarantined(
        new Date(Date.now() + 30 * 86_400_000),
      ),
      0,
      "terminal classes are never auto redriven",
    );
  },
);

test(
  "F4 work queues expose identifier columns only and selectors return IDs",
  { skip: !enabled },
  async () => {
    const privileges = await admin<{
      table_name: string;
      column_name: string;
      has_select: boolean;
    }>(
      `SELECT table_name, column_name,
       has_column_privilege('billing_app', format('billing_inbox.%I', table_name), column_name, 'SELECT') AS has_select
       FROM (VALUES ('due_work','tenant_id'),('due_work','kind'),('due_work','due_at'),
                    ('due_work','status'),('command_work','tenant_id'),('command_work','command_id'),
                    ('command_work','status'),('command_work','attempts'),('command_work','available_at'))
         AS cols(table_name,column_name)`,
    );
    const privilege = (table: string, column: string) =>
      privileges.find(
        (row) => row.table_name === table && row.column_name === column,
      )?.has_select;
    assert.equal(privilege("due_work", "tenant_id"), true);
    assert.equal(privilege("due_work", "kind"), true);
    assert.equal(privilege("due_work", "due_at"), false);
    assert.equal(privilege("due_work", "status"), false);
    assert.equal(privilege("command_work", "tenant_id"), true);
    assert.equal(privilege("command_work", "command_id"), true);
    assert.equal(privilege("command_work", "status"), false);
    assert.equal(privilege("command_work", "attempts"), false);
    assert.equal(privilege("command_work", "available_at"), false);
    await assert.rejects(
      db!.$queryRaw`SELECT * FROM billing_inbox.due_work LIMIT 1`,
    );
    await assert.rejects(
      db!.$queryRaw`SELECT * FROM billing_inbox.command_work LIMIT 1`,
    );
    const selected = await db!.$queryRaw<{ tenant_id: string }[]>`
    SELECT tenant_id FROM billing_inbox.ready_due_tenants('usage', now(), 1)`;
    assert.ok(Array.isArray(selected));
    assert.equal(
      (
        await admin<{
          ok: boolean;
        }>(`SELECT has_function_privilege('billing_app',
    'billing_inbox.claim_command_work()', 'EXECUTE') AS ok`)
      )[0]?.ok,
      true,
    );
  },
);

test(
  "B12 reconciliation reports mismatch without silently altering money",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ planKey: "enterprise" }),
    );
    const result = await new BillingReconciliation(db!, f.stripe).run(
      f.tenantId,
      monthStart(new Date()),
    );
    assert.ok(
      result.findings.some(
        (finding) => finding.diffClass === "subscription_mismatch",
      ),
    );
    assert.equal(await subscription(f.tenantId), undefined);
  },
);

test(
  "B13 metadata mismatch quarantines event and cannot alter other tenant",
  { skip: !enabled },
  async () => {
    const a = await fixture();
    const b = await fixture();
    a.stripe.subscriptions.set(a.subscriptionId, a.view());
    const event = await signed(a, "customer.subscription.created", {
      metadata: { tenant_id: b.tenantId },
    });
    await a.webhooks.receive(event.raw, event.signature);
    await assert.rejects(a.webhooks.processOne(event.eventId), TenantMismatch);
    assert.equal(await subscription(a.tenantId), undefined);
    assert.equal(await subscription(b.tenantId), undefined);
    const inbox = await admin<{ status: string }>(
      `SELECT status FROM billing_inbox.stripe_webhook_inbox
    WHERE event_id=$1`,
      [event.eventId],
    );
    assert.equal(inbox[0]?.status, "quarantined");
  },
);

test(
  "active checkout is rejected; canceled subscription can be replaced",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(f.subscriptionId, f.view());
    let event = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    await assert.rejects(
      f.commands.requestCheckout(
        f.tenantId,
        "enterprise",
        "http://127.0.0.1:5173/success",
        "http://127.0.0.1:5173/cancel",
        randomUUID(),
        "admin",
      ),
      /active subscription/,
    );
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ status: "canceled" }),
    );
    event = await signed(
      f,
      "customer.subscription.deleted",
      {},
      Math.floor(Date.now() / 1000) + 1,
    );
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    const nextId = `sub_renewed${f.tenantId.replaceAll("-", "")}`;
    f.stripe.subscriptions.set(
      nextId,
      f.view({ id: nextId, planKey: "enterprise" }),
    );
    event = await signed(
      f,
      "customer.subscription.created",
      { id: nextId },
      Math.floor(Date.now() / 1000) + 2,
    );
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    const row = await subscription(f.tenantId);
    assert.equal(row?.plan_key, "enterprise");
    assert.equal(row?.version, 3n);
  },
);

test(
  "B16 redrive is audited and applied events remain no-ops",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    f.stripe.subscriptions.set(f.subscriptionId, f.view());
    const event = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    assert.equal(
      await f.webhooks.redrive(
        event.eventId,
        "operator",
        "verification",
        f.tenantId,
      ),
      false,
    );
    const audit = await admin<{ count: string }>(
      `SELECT count(*) FROM billing_inbox.webhook_redrive_audit
    WHERE event_id=$1`,
      [event.eventId],
    );
    assert.equal(audit[0]?.count, "1");
    assert.equal((await subscription(f.tenantId))?.version, 1n);
  },
);

test(
  "billing RLS and explicit tenant filters deny cross-tenant reads",
  { skip: !enabled },
  async () => {
    const a = await fixture();
    const b = await fixture();
    const rows = await withTenant(
      db!,
      a.tenantId,
      (tx) => tx.$queryRaw<
        {
          stripe_customer_id: string;
        }[]
      >`SELECT stripe_customer_id FROM billing_customers
      WHERE tenant_id=${b.tenantId}::uuid`,
    );
    assert.deepEqual(rows, []);
  },
);

test(
  "durable worker finds tenant command after restart",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const receipt = await f.commands.requestPortal(
      f.tenantId,
      "http://127.0.0.1:5173/account",
      randomUUID(),
      "admin",
    );
    const worker = new BillingWorker(db!, f.commands, f.webhooks, f.usage);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    for (let index = 0; index < 100; index++) {
      await worker.processCommand();
      if (
        (await f.commands.get(f.tenantId, receipt.commandId))?.status ===
        "completed"
      )
        break;
    }
    assert.equal(
      (await f.commands.get(f.tenantId, receipt.commandId))?.status,
      "completed",
    );
  },
);

test(
  "due-work index and malformed-source receipt survive restart",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const end = new Date(Date.now() + 60_000);
    f.stripe.subscriptions.set(
      f.subscriptionId,
      f.view({ cancelAtPeriodEnd: true, periodEnd: end }),
    );
    const event = await signed(f, "customer.subscription.created");
    await f.webhooks.receive(event.raw, event.signature);
    await f.webhooks.processOne(event.eventId);
    const due = await admin<{ due_at: Date }>(
      `SELECT due_at FROM billing_inbox.due_work
    WHERE tenant_id=$1 AND kind='subscription'`,
      [f.tenantId],
    );
    assert.equal(due.length, 1);
    const topic = "greenguard.telemetry.recorded.v1";
    await f.usage.rejectSource(topic, 2, "987654321", "invalid_source_event");
    await f.usage.rejectSource(topic, 2, "987654321", "invalid_source_event");
    const rejected = await admin<{ count: string }>(
      `SELECT count(*)
    FROM billing_inbox.source_rejections
    WHERE topic=$1 AND partition=2 AND source_offset=987654321`,
      [topic],
    );
    assert.equal(rejected[0]?.count, "1");
    const restarted = new BillingWorker(db!, f.commands, f.webhooks, f.usage);
    assert.ok(
      (await restarted.dueTransitions(new Date(end.getTime() + 1))) >= 1,
    );
    assert.equal(
      (await subscription(f.tenantId))?.entitlement_plan_key,
      "free",
    );
  },
);

test(
  "HTTP billing API authenticates tenant admin and persists command before 202",
  { skip: !enabled },
  async () => {
    const a = await fixture();
    const b = await fixture();
    const app = await createBillingApp({
      db: db!,
      commands: a.commands,
      webhooks: a.webhooks,
      verifier: {
        async verify(header) {
          if (!header) throw new AuthError(401, "missing_token");
          if (header === "Bearer viewer")
            return {
              subject: "viewer",
              tenantId: a.tenantId,
              roles: ["viewer"],
              expiresAt: new Date(Date.now() + 60_000),
            };
          return {
            subject: "admin",
            tenantId: header === "Bearer b" ? b.tenantId : a.tenantId,
            roles: ["admin"],
            expiresAt: new Date(Date.now() + 60_000),
          };
        },
      },
    });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const request = (auth?: string) =>
        fetch(`${base}/v1/billing/checkout`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            ...(auth ? { authorization: auth } : {}),
          },
          body: JSON.stringify({
            plan: "standard",
            successUrl: "http://127.0.0.1:5173/success",
            cancelUrl: "http://127.0.0.1:5173/cancel",
          }),
        });
      assert.equal((await request()).status, 401);
      assert.equal((await request("Bearer viewer")).status, 403);
      const response = await request("Bearer a");
      assert.equal(response.status, 202);
      const receipt = (await response.json()) as {
        commandId: string;
        status: string;
      };
      assert.equal(receipt.status, "pending");
      assert.equal(
        (await a.commands.get(a.tenantId, receipt.commandId))?.status,
        "pending",
      );
      assert.equal(await a.commands.get(b.tenantId, receipt.commandId), null);
    } finally {
      await app.close();
    }
  },
);

test(
  "B01 HTTP bad signature returns 400 with no inbox row; valid raw body commits",
  { skip: !enabled },
  async () => {
    const f = await fixture();
    const app = await createBillingApp({
      db: db!,
      commands: f.commands,
      webhooks: f.webhooks,
      verifier: {
        async verify() {
          throw new AuthError(401, "missing_token");
        },
      },
    });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const event = await signed(f, "customer.subscription.created");
      const bad = await fetch(`${base}/webhooks/stripe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1,v1=bad",
        },
        body: event.raw,
      });
      assert.equal(bad.status, 400);
      let rows = await admin<{ count: string }>(
        `SELECT count(*) FROM billing_inbox.stripe_webhook_inbox
      WHERE event_id=$1`,
        [event.eventId],
      );
      assert.equal(rows[0]?.count, "0");
      const good = await fetch(`${base}/webhooks/stripe`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": event.signature,
        },
        body: event.raw,
      });
      assert.ok(good.status >= 200 && good.status < 300);
      rows = await admin<{ count: string }>(
        `SELECT count(*) FROM billing_inbox.stripe_webhook_inbox
      WHERE event_id=$1`,
        [event.eventId],
      );
      assert.equal(rows[0]?.count, "1");
    } finally {
      await app.close();
    }
  },
);
