import Stripe from "stripe";
import type { Db, Tx } from "./db.js";
import { withTenant } from "./db.js";
import { open, seal } from "./crypto.js";
import { audit, context, outbox } from "./events.js";
import { freshId, hash, nameId, UUID } from "./ids.js";
import { scheduleSubscription } from "./due.js";
import { raiseFinding } from "./findings.js";
import { plans } from "../catalog/plans.js";
import type { StripePort, SubscriptionView } from "./stripe-port.js";

export class InvalidWebhook extends Error {}
export class TenantMismatch extends Error {}
// A second live subscription for a tenant that already has one (two Checkouts completed).
export class DuplicateSubscription extends Error {
  constructor(readonly existingId: string) { super("different subscription already bound to tenant"); }
}

export interface WebhookConfig { secrets: readonly string[]; encryptionKey: Buffer; graceDays: number }
interface InboxRow { event_id: string; event_type: string; stripe_created: bigint;
  tenant_id: string | null; encrypted_payload: Uint8Array; attempts: number }
interface SubscriptionRow { stripe_subscription_id: string; status: string; plan_key: string;
  current_period_end: Date; grace_until: Date | null; stripe_event_created: bigint;
  stripe_state_hash: string; entitlement_plan_key: string; pending_plan_key: string | null;
  version: bigint }

function objectId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return "";
}

export function verifyStripeWebhook(raw: Buffer, signature: string, secrets: readonly string[],
  now = Date.now()): Stripe.Event {
  // Official SDK verifies the HMAC over the exact raw bytes and checks timestamp.
  const timestamp = /(?:^|,)t=(\d+)(?:,|$)/.exec(signature)?.[1];
  if (!timestamp || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300)
    throw new InvalidWebhook("Stripe signature timestamp outside tolerance");
  const sdk = new Stripe("sk_test_signature_verification_only");
  for (const secret of secrets) {
    try {
      return sdk.webhooks.constructEvent(raw, signature, secret, 300, undefined, now);
    } catch { /* Try the second active secret during rotation. */ }
  }
  throw new InvalidWebhook("invalid Stripe signature or stale timestamp");
}

// `paused` (Stripe: trial ended without a payment method, invoice generation halted) keeps
// the entitlement already granted and never raises it: nothing is being charged or failed,
// so neither an upgrade nor a downgrade is implied. A tenant without one stays on free.
function effectivePlan(view: SubscriptionView, now: Date, graceUntil: Date | null,
  current?: string): string {
  if (view.status === "paused") return current ?? "free";
  if (view.status === "active" || view.status === "trialing")
    return view.cancelAtPeriodEnd && now >= view.periodEnd ? "free" : view.planKey;
  if (view.status === "past_due" && graceUntil && now < graceUntil) return view.planKey;
  return "free";
}

const planRank: Record<string, number> = { free: 0, standard: 1, enterprise: 2 };

function entitlementForUpdate(view: SubscriptionView, now: Date, graceUntil: Date | null,
  existing?: SubscriptionRow): { plan: string; pending: string | null } {
  const candidate = effectivePlan(view, now, graceUntil, existing?.entitlement_plan_key);
  if (existing && (view.status === "active" || view.status === "trialing") &&
      (planRank[candidate] ?? 0) < (planRank[existing.entitlement_plan_key] ?? 0) &&
      now < existing.current_period_end)
    return { plan: existing.entitlement_plan_key, pending: candidate };
  return { plan: candidate, pending: null };
}

function stateHash(view: SubscriptionView): string {
  return hash(JSON.stringify({ id: view.id, customerId: view.customerId,
    status: view.status, planKey: view.planKey,
    periodStart: view.periodStart.toISOString(), periodEnd: view.periodEnd.toISOString(),
    cancelAtPeriodEnd: view.cancelAtPeriodEnd }));
}

export class BillingWebhooks {
  constructor(private readonly db: Db, private readonly stripe: StripePort,
    private readonly config: WebhookConfig) {}

  async receive(raw: Buffer, signature: string): Promise<{ eventId: string; duplicate: boolean }> {
    const event = verifyStripeWebhook(raw, signature, this.config.secrets);
    if (!/^evt_[A-Za-z0-9]+$/.test(event.id) || !Number.isSafeInteger(event.created))
      throw new InvalidWebhook("invalid Stripe event envelope");
    const encrypted = seal(raw, this.config.encryptionKey);
    const inserted = await this.db.$executeRaw`INSERT INTO billing_inbox.stripe_webhook_inbox
      (event_id, event_type, stripe_created, encrypted_payload)
      VALUES (${event.id}, ${event.type}, ${BigInt(event.created)}, ${encrypted})
      ON CONFLICT (event_id) DO NOTHING`;
    return { eventId: event.id, duplicate: inserted === 0 };
  }

  private async claim(eventId?: string): Promise<InboxRow | null> {
    const rows = await this.db.$queryRaw<InboxRow[]>`
      WITH next AS (
        SELECT event_id FROM billing_inbox.stripe_webhook_inbox
        WHERE (${eventId ?? null}::text IS NULL OR event_id=${eventId ?? null})
          AND ((status='pending' AND (lease_until IS NULL OR lease_until < clock_timestamp()))
            OR (status='processing' AND lease_until < clock_timestamp()))
        ORDER BY received_at, event_id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE billing_inbox.stripe_webhook_inbox AS inbox
      SET status='processing', attempts=attempts+1,
        lease_until=clock_timestamp()+interval '30 seconds', updated_at=clock_timestamp()
      FROM next WHERE inbox.event_id=next.event_id
      RETURNING inbox.event_id, inbox.event_type, inbox.stripe_created,
        inbox.tenant_id, inbox.encrypted_payload, inbox.attempts`;
    return rows[0] ?? null;
  }

  async processOne(eventId?: string, afterTenantCommit?: () => void): Promise<boolean> {
    const row = await this.claim(eventId);
    if (!row) return false;
    try {
      const raw = open(Buffer.from(row.encrypted_payload), this.config.encryptionKey);
      const event = JSON.parse(raw.toString("utf8")) as Stripe.Event;
      if (event.id !== row.event_id || event.type !== row.event_type || event.created !== Number(row.stripe_created))
        throw new InvalidWebhook("stored Stripe event mismatch");
      const tenantId = await this.apply(event);
      afterTenantCommit?.(); // fault injection: crash after tenant transaction
      await this.db.$executeRaw`UPDATE billing_inbox.stripe_webhook_inbox
        SET status='applied', tenant_id=${tenantId}::uuid,
          lease_until=NULL, last_error=NULL, updated_at=clock_timestamp()
        WHERE event_id=${row.event_id}`;
      return true;
    } catch (error) {
      const terminal = error instanceof TenantMismatch || error instanceof InvalidWebhook || row.attempts >= 10;
      const safe = error instanceof Error ? error.constructor.name : "unknown";
      await this.db.$executeRaw`UPDATE billing_inbox.stripe_webhook_inbox
        SET status=${terminal ? "quarantined" : "pending"},
          lease_until=${terminal ? null : new Date(Date.now() + Math.min(300_000, 1000 * 2 ** row.attempts))},
          last_error=${safe}, updated_at=clock_timestamp()
        WHERE event_id=${row.event_id}`;
      throw error;
    }
  }

  private async resolveTenant(customerId: string): Promise<string> {
    const rows = await this.db.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM billing_inbox.customer_directory WHERE stripe_customer_id=${customerId}`;
    const tenantId = rows[0]?.tenant_id;
    if (!tenantId || !UUID.test(tenantId)) throw new TenantMismatch("unmapped Stripe customer");
    const verified = await withTenant(this.db, tenantId, (tx) => tx.$queryRaw<{ stripe_customer_id: string }[]>`
      SELECT stripe_customer_id FROM billing_customers
      WHERE tenant_id=${tenantId}::uuid AND stripe_customer_id=${customerId}`);
    if (verified.length !== 1) throw new TenantMismatch("customer directory mismatch");
    return tenantId;
  }

  private async apply(event: Stripe.Event): Promise<string | null> {
    const object = event.data.object as unknown as Record<string, unknown>;
    const eventCustomer = objectId(object.customer);
    if (event.type.startsWith("customer.subscription.") || event.type === "checkout.session.completed") {
      const subscriptionId = event.type === "checkout.session.completed"
        ? objectId(object.subscription) : objectId(object.id);
      if (!subscriptionId) throw new InvalidWebhook("subscription reference missing");
      const view = await this.stripe.retrieveSubscription(subscriptionId);
      const tenantId = await this.resolveTenant(view.customerId);
      if (view.tenantId !== tenantId || (eventCustomer && eventCustomer !== view.customerId))
        throw new TenantMismatch("subscription customer or tenant mismatch");
      const metadata = object.metadata as Record<string, unknown> | undefined;
      if (metadata?.tenant_id && metadata.tenant_id !== tenantId)
        throw new TenantMismatch("event tenant metadata mismatch");
      if (event.type === "checkout.session.completed" && object.client_reference_id !== tenantId)
        throw new TenantMismatch("checkout client reference mismatch");
      try { await this.applySubscription(tenantId, event, view); }
      catch (error) {
        if (!(error instanceof DuplicateSubscription)) throw error;
        await this.rejectDuplicate(tenantId, event, view, error.existingId);
      }
      return tenantId;
    }
    if (event.type.startsWith("invoice.")) {
      const invoiceId = objectId(object.id);
      if (!invoiceId) throw new InvalidWebhook("invoice reference missing");
      const view = await this.stripe.retrieveInvoice(invoiceId);
      const tenantId = await this.resolveTenant(view.customerId);
      if (eventCustomer && eventCustomer !== view.customerId) throw new TenantMismatch("invoice customer mismatch");
      await withTenant(this.db, tenantId, async (tx) => {
        if (!(await this.applyReceipt(tx, tenantId, event.id))) return;
        await tx.$executeRaw`INSERT INTO invoice_mirrors
          (tenant_id, invoice_id, status, amount_due, currency, stripe_event_created)
          VALUES (${tenantId}::uuid, ${view.id}, ${view.status}, ${BigInt(view.amountDue)},
            ${view.currency}, ${BigInt(event.created)})
          ON CONFLICT (tenant_id, invoice_id) DO UPDATE SET status=EXCLUDED.status,
            amount_due=EXCLUDED.amount_due, currency=EXCLUDED.currency,
            stripe_event_created=EXCLUDED.stripe_event_created, version=invoice_mirrors.version+1
          WHERE invoice_mirrors.stripe_event_created <= EXCLUDED.stripe_event_created`;
        await audit(tx, tenantId, "stripe", "billing.invoice.mirrored", view.id,
          { status: view.status }, event.id);
      });
      return tenantId;
    }
    if (event.type.startsWith("charge.dispute.")) {
      const disputeId = objectId(object.id);
      if (!disputeId) throw new InvalidWebhook("dispute reference missing");
      const view = await this.stripe.retrieveDispute(disputeId);
      const tenantId = await this.resolveTenant(view.customerId);
      await withTenant(this.db, tenantId, async (tx) => {
        if (!(await this.applyReceipt(tx, tenantId, event.id))) return;
        await tx.$executeRaw`INSERT INTO dispute_mirrors
          (tenant_id, dispute_id, status, amount, currency, stripe_event_created)
          VALUES (${tenantId}::uuid, ${view.id}, ${view.status}, ${BigInt(view.amount)},
            ${view.currency}, ${BigInt(event.created)})
          ON CONFLICT (tenant_id, dispute_id) DO UPDATE SET status=EXCLUDED.status,
            amount=EXCLUDED.amount, currency=EXCLUDED.currency,
            stripe_event_created=EXCLUDED.stripe_event_created, version=dispute_mirrors.version+1
          WHERE dispute_mirrors.stripe_event_created <= EXCLUDED.stripe_event_created`;
        await audit(tx, tenantId, "stripe", "billing.dispute.mirrored", view.id,
          { status: view.status }, event.id);
      });
      return tenantId;
    }
    // Unknown signed events are recorded and safely ignored. They never get an
    // inferred tenant and cannot mutate a subscription.
    return null;
  }

  private async applyReceipt(tx: Tx, tenantId: string, eventId: string): Promise<boolean> {
    const inserted = await tx.$executeRaw`INSERT INTO webhook_applied_events (tenant_id, event_id)
      VALUES (${tenantId}::uuid, ${eventId}) ON CONFLICT DO NOTHING`;
    return inserted === 1;
  }

  // True when the event changes nothing. Throws DuplicateSubscription when a different
  // live subscription would be bound to a tenant that already has one.
  private isStale(existing: SubscriptionRow | undefined, view: SubscriptionView,
    event: Stripe.Event): boolean {
    if (!existing) return false;
    if (existing.stripe_subscription_id !== view.id && existing.status !== "canceled") {
      if (view.status === "canceled") return true; // an old, ended subscription
      throw new DuplicateSubscription(existing.stripe_subscription_id);
    }
    return existing.stripe_state_hash === stateHash(view) ||
      (existing.stripe_subscription_id === view.id &&
        BigInt(event.created) < existing.stripe_event_created);
  }

  // The second Checkout completed: the tenant is paying twice. Cancel the newer
  // subscription through the port (idempotent by key), then alert. Refunding a settled
  // charge stays a human decision taken from the reconciliation finding.
  private async rejectDuplicate(tenantId: string, event: Stripe.Event,
    view: SubscriptionView, existingId: string): Promise<void> {
    await this.stripe.cancelSubscription(view.id, `duplicate-subscription:${view.id}`);
    await withTenant(this.db, tenantId, async (tx) => {
      if (!(await this.applyReceipt(tx, tenantId, event.id))) return;
      await raiseFinding(tx, tenantId, nameId("billing-duplicate-run", tenantId, view.id),
        nameId("billing-duplicate-finding", tenantId, view.id), {
          objectType: "subscription", objectId: view.id, diffClass: "duplicate_subscription",
          local: { subscription_id: existingId }, remote: { subscription_id: view.id,
            plan_key: view.planKey, status: view.status } });
      await audit(tx, tenantId, "stripe", "billing.subscription.duplicate_cancelled", view.id,
        { existing: existingId }, event.id);
    });
  }

  private async applySubscription(tenantId: string, event: Stripe.Event,
    view: SubscriptionView): Promise<void> {
    await withTenant(this.db, tenantId, async (tx) => {
      if (!(await this.applyReceipt(tx, tenantId, event.id))) return;
      const existing = (await tx.$queryRaw<SubscriptionRow[]>`SELECT
        stripe_subscription_id, status, plan_key, current_period_end,
        grace_until, stripe_event_created, stripe_state_hash,
        entitlement_plan_key, pending_plan_key, version FROM subscriptions
        WHERE tenant_id=${tenantId}::uuid FOR UPDATE`)[0];
      if (this.isStale(existing, view, event)) return;
      const digest = stateHash(view);
      const now = new Date();
      const grace = view.status === "past_due"
        ? existing?.status === "past_due" && existing.grace_until
          ? existing.grace_until
          : new Date(now.getTime() + this.config.graceDays * 86400_000)
        : null;
      const { plan: entitled, pending } = entitlementForUpdate(view, now, grace, existing);
      const version = existing ? existing.version + 1n : 1n;
      if (existing) {
        await tx.$executeRaw`UPDATE subscriptions SET
          stripe_subscription_id=${view.id}, stripe_customer_id=${view.customerId},
          stripe_object_created=${BigInt(view.created)},
          status=${view.status}, plan_key=${view.planKey},
          current_period_start=${view.periodStart}, current_period_end=${view.periodEnd},
          cancel_at_period_end=${view.cancelAtPeriodEnd},
          stripe_event_created=${BigInt(event.created)}, stripe_state_hash=${digest},
          entitlement_plan_key=${entitled}, pending_plan_key=${pending}, grace_until=${grace},
          version=${version}, updated_at=clock_timestamp()
          WHERE tenant_id=${tenantId}::uuid AND version=${existing.version}`;
      } else {
        await tx.$executeRaw`INSERT INTO subscriptions
          (tenant_id, stripe_subscription_id, stripe_customer_id, status, plan_key,
            current_period_start, current_period_end, cancel_at_period_end,
            stripe_object_created, stripe_event_created, stripe_state_hash,
            entitlement_plan_key, pending_plan_key, grace_until, version)
          VALUES (${tenantId}::uuid, ${view.id}, ${view.customerId}, ${view.status},
            ${view.planKey}, ${view.periodStart}, ${view.periodEnd},
            ${view.cancelAtPeriodEnd}, ${BigInt(view.created)}, ${BigInt(event.created)},
            ${digest}, ${entitled}, ${pending}, ${grace}, ${version})`;
      }
      await this.publishSubscription(tx, tenantId, view, entitled, version,
        context(undefined, nameId("stripe-event", event.id)));
      await scheduleSubscription(tx, tenantId);
      await audit(tx, tenantId, "stripe", "billing.subscription.changed", view.id,
        { status: view.status, plan_key: view.planKey, version: version.toString() }, event.id);
    });
  }

  private async publishSubscription(tx: Tx, tenantId: string, view: SubscriptionView,
    entitled: string, version: bigint, ctx: ReturnType<typeof context>): Promise<void> {
    const subscriptionId = nameId("subscription", tenantId, view.id);
    await outbox(tx, tenantId, "subscription", subscriptionId, version,
      "subscription.changed", { subscription_id: view.id, status: view.status,
        plan_key: view.planKey, current_period_start: view.periodStart.toISOString(),
        current_period_end: view.periodEnd.toISOString(), cancel_at_period_end: view.cancelAtPeriodEnd,
        version: version.toString() }, ctx);
    const plan = plans[entitled as keyof typeof plans];
    await outbox(tx, tenantId, "entitlement", tenantId, version,
      "entitlements.changed", { tenant_id: tenantId, plan_key: entitled,
        plan_version: String(plan.version), limits: plan.limits, features: plan.features,
        source_version: version.toString(), effective_at: new Date().toISOString() }, ctx);
  }

  // Run at least once per minute. Cancel-at-period-end and grace expiry are
  // enforced even if a Stripe webhook is delayed; no data is deleted.
  async applyDueTransition(tenantId: string, now = new Date()): Promise<boolean> {
    return withTenant(this.db, tenantId, async (tx) => {
      const row = (await tx.$queryRaw<(SubscriptionRow & { plan_key: string;
        cancel_at_period_end: boolean; current_period_start: Date;
        stripe_customer_id: string; stripe_object_created: bigint })[]>`
        SELECT * FROM subscriptions WHERE tenant_id=${tenantId}::uuid FOR UPDATE`)[0];
      if (!row) return false;
      const view: SubscriptionView = {
        id: row.stripe_subscription_id, customerId: row.stripe_customer_id,
        tenantId, status: row.status as SubscriptionView["status"],
        planKey: row.plan_key as SubscriptionView["planKey"],
        periodStart: row.current_period_start, periodEnd: row.current_period_end,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        created: Number(row.stripe_object_created),
      };
      const entitled = row.pending_plan_key && now < row.current_period_end
        ? row.entitlement_plan_key : effectivePlan(view, now, row.grace_until, row.entitlement_plan_key);
      if (row.entitlement_plan_key === entitled) return false;
      const version = row.version + 1n;
      await tx.$executeRaw`UPDATE subscriptions SET entitlement_plan_key=${entitled},
        pending_plan_key=NULL, version=${version}, updated_at=clock_timestamp()
        WHERE tenant_id=${tenantId}::uuid AND version=${row.version}`;
      await this.publishSubscription(tx, tenantId, view, entitled, version, context());
      await scheduleSubscription(tx, tenantId);
      await audit(tx, tenantId, "system", "billing.entitlement.transition", view.id,
        { plan_key: entitled, version: version.toString() });
      return true;
    });
  }

  // Automatic, bounded redrive of events quarantined by transient failure (a Stripe or
  // database outage outlasting the ~13 minute retry budget). Backoff 15 min doubling to
  // 6 h, at most 6 automatic redrives per event, 20 per sweep; TenantMismatch and
  // InvalidWebhook are never redriven. Each redrive is audited as system:auto-redrive.
  async redriveQuarantined(now: Date): Promise<number> {
    return this.db.$executeRaw`
      WITH due AS (
        SELECT event_id FROM billing_inbox.stripe_webhook_inbox
        WHERE status='quarantined' AND auto_redrives < 6
          AND COALESCE(last_error,'') NOT IN ('TenantMismatch','InvalidWebhook')
          AND updated_at + interval '1 minute' * LEAST(360, 15 * power(2, auto_redrives)) <= ${now}
        ORDER BY updated_at LIMIT 20 FOR UPDATE SKIP LOCKED
      ), moved AS (
        UPDATE billing_inbox.stripe_webhook_inbox AS inbox SET status='pending', attempts=0,
          lease_until=NULL, auto_redrives=auto_redrives+1, updated_at=clock_timestamp()
        FROM due WHERE inbox.event_id=due.event_id RETURNING inbox.event_id, inbox.tenant_id
      )
      INSERT INTO billing_inbox.webhook_redrive_audit (redrive_id, event_id, tenant_id, actor_id, reason)
      SELECT gen_random_uuid(), event_id, tenant_id, 'system:auto-redrive',
        'automatic redrive of a transient quarantine' FROM moved`;
  }

  async redrive(eventId: string, actorId: string, reason: string,
    tenantId?: string): Promise<boolean> {
    if (!reason.trim() || reason.length > 500) throw new Error("redrive reason required");
    const row = (await this.db.$queryRaw<{ tenant_id: string | null; status: string }[]>`
      SELECT tenant_id, status FROM billing_inbox.stripe_webhook_inbox WHERE event_id=${eventId}`)[0];
    if (!row) return false;
    if (tenantId && row.tenant_id !== tenantId) throw new TenantMismatch("redrive tenant mismatch");
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO billing_inbox.webhook_redrive_audit
        (redrive_id, event_id, tenant_id, actor_id, reason)
        VALUES (${freshId()}::uuid, ${eventId}, ${row.tenant_id}::uuid, ${actorId}, ${reason})`;
      if (row.status !== "applied") await tx.$executeRaw`
        UPDATE billing_inbox.stripe_webhook_inbox SET status='pending',
          attempts=0, lease_until=NULL, last_error=NULL, updated_at=clock_timestamp()
        WHERE event_id=${eventId}`;
    });
    return row.status !== "applied";
  }
}
