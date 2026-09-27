import Stripe from "stripe";
import type { PlanKey } from "../catalog/plans.js";

export interface CustomerView { id: string; tenantId: string }
export interface SubscriptionView {
  id: string;
  customerId: string;
  tenantId: string;
  status: "paused" | "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "canceled";
  planKey: PlanKey;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  created: number;
}
// `paused` (trial ended without a payment method) is kept as its own status so the
// previous entitlement is retained. `incomplete_expired` is terminal: the first payment
// never completed, so it is stored as `canceled` and grants nothing.
export function mapSubscriptionStatus(status: string): SubscriptionView["status"] {
  if (status === "incomplete_expired") return "canceled";
  if (!["incomplete", "trialing", "active", "past_due", "unpaid", "canceled", "paused"].includes(status))
    throw new Error("unsupported Stripe subscription status");
  return status as SubscriptionView["status"];
}
export interface InvoiceView { id: string; customerId: string; status: string; amountDue: number; currency: string }
export interface DisputeView { id: string; customerId: string; status: string; amount: number; currency: string }

export interface StripePort {
  createCustomer(tenantId: string, key: string): Promise<CustomerView>;
  retrieveCustomer(customerId: string): Promise<CustomerView>;
  createCheckout(customerId: string, tenantId: string, plan: PlanKey,
    successUrl: string, cancelUrl: string, key: string): Promise<{ id: string; url: string }>;
  createPortal(customerId: string, returnUrl: string, key: string): Promise<{ id: string; url: string }>;
  retrieveSubscription(subscriptionId: string): Promise<SubscriptionView>;
  retrieveInvoice(invoiceId: string): Promise<InvoiceView>;
  retrieveDispute(disputeId: string): Promise<DisputeView>;
  reportMeter(tenantId: string, meter: string, eventTime: Date, quantity: bigint,
    identifier: string, customerId: string): Promise<{ identifier: string }>;
  cancelSubscription(subscriptionId: string, key: string): Promise<void>;
  listSubscriptions(customerId: string): Promise<SubscriptionView[]>;
  listInvoices(customerId: string): Promise<InvoiceView[]>;
  listMeterSummaries(customerId: string, periodStart: Date, periodEnd: Date): Promise<Record<string, bigint>>;
}

// Official SDK owns API calls and webhook signature verification. No card details
// are accepted by this service; Checkout/Portal are Stripe-hosted.
export class StripeSdkPort implements StripePort {
  readonly client: Stripe;
  constructor(apiKey: string) {
    if (!/^(sk|rk)_test_/.test(apiKey)) throw new Error("live Stripe keys are forbidden");
    this.client = new Stripe(apiKey);
  }

  async createCustomer(tenantId: string, key: string): Promise<CustomerView> {
    const value = await this.client.customers.create({ metadata: { tenant_id: tenantId } }, { idempotencyKey: key });
    return { id: value.id, tenantId };
  }
  async retrieveCustomer(customerId: string): Promise<CustomerView> {
    const value = await this.client.customers.retrieve(customerId);
    if (value.deleted) throw new Error("Stripe customer is deleted");
    return { id: value.id, tenantId: value.metadata.tenant_id ?? "" };
  }
  async createCheckout(customerId: string, tenantId: string, plan: PlanKey,
    successUrl: string, cancelUrl: string, key: string) {
    const { plans } = await import("../catalog/plans.js");
    const prices = await this.client.prices.list({ lookup_keys: [plans[plan].lookupKey], active: true, limit: 2 });
    if (prices.data.length !== 1) throw new Error("exactly one active Stripe price must match the plan lookup key");
    const value = await this.client.checkout.sessions.create({
      mode: "subscription", customer: customerId, client_reference_id: tenantId,
      line_items: [{ price: prices.data[0]!.id, quantity: 1 }],
      success_url: successUrl, cancel_url: cancelUrl,
      subscription_data: { metadata: { tenant_id: tenantId, plan_key: plan } },
    }, { idempotencyKey: key });
    if (!value.url) throw new Error("Stripe did not return a Checkout URL");
    return { id: value.id, url: value.url };
  }
  async createPortal(customerId: string, returnUrl: string, key: string) {
    const value = await this.client.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl }, { idempotencyKey: key });
    return { id: value.id, url: value.url };
  }
  async retrieveSubscription(subscriptionId: string): Promise<SubscriptionView> {
    const value = await this.client.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    const item = value.items.data[0];
    const lookupKey = item?.price.lookup_key;
    const { plans } = await import("../catalog/plans.js");
    const plan = (Object.keys(plans) as PlanKey[]).find((key) => plans[key].lookupKey === lookupKey);
    if (!plan) throw new Error("unknown Stripe plan lookup key");
    if (!value.metadata.tenant_id) throw new Error("subscription tenant metadata missing");
    return {
      id: value.id, customerId: typeof value.customer === "string" ? value.customer : value.customer.id,
      tenantId: value.metadata.tenant_id, status: mapSubscriptionStatus(value.status), planKey: plan,
      periodStart: new Date(item!.current_period_start * 1000),
      periodEnd: new Date(item!.current_period_end * 1000),
      cancelAtPeriodEnd: value.cancel_at_period_end, created: value.created,
    };
  }
  async retrieveInvoice(invoiceId: string): Promise<InvoiceView> {
    const value = await this.client.invoices.retrieve(invoiceId);
    return { id: value.id, customerId: typeof value.customer === "string" ? value.customer : value.customer?.id ?? "",
      status: value.status ?? "unknown", amountDue: value.amount_due, currency: value.currency };
  }
  async retrieveDispute(disputeId: string): Promise<DisputeView> {
    const value = await this.client.disputes.retrieve(disputeId);
    const charge = typeof value.charge === "string" ? await this.client.charges.retrieve(value.charge) : value.charge;
    return { id: value.id, customerId: typeof charge?.customer === "string" ? charge.customer : charge?.customer?.id ?? "",
      status: value.status, amount: value.amount, currency: value.currency };
  }
  async cancelSubscription(subscriptionId: string, key: string): Promise<void> {
    // Immediate cancel with a prorated credit; a settled charge is refunded by an operator
    // from the reconciliation finding, never automatically.
    await this.client.subscriptions.cancel(subscriptionId,
      { prorate: true, invoice_now: true }, { idempotencyKey: key });
  }
  async reportMeter(tenantId: string, meter: string, eventTime: Date, quantity: bigint,
    identifier: string, customerId: string) {
    await this.client.billing.meterEvents.create({ event_name: meter, identifier,
      timestamp: Math.floor(eventTime.getTime() / 1000),
      payload: { stripe_customer_id: customerId, value: quantity.toString(), tenant_id: tenantId },
    }, { idempotencyKey: identifier });
    return { identifier };
  }
  async listSubscriptions(customerId: string): Promise<SubscriptionView[]> {
    const values = await this.client.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    return Promise.all(values.data.map((value) => this.retrieveSubscription(value.id)));
  }
  async listInvoices(customerId: string): Promise<InvoiceView[]> {
    const values = await this.client.invoices.list({ customer: customerId, limit: 100 });
    return Promise.all(values.data.map((value) => this.retrieveInvoice(value.id)));
  }
  async listMeterSummaries(customerId: string, periodStart: Date, periodEnd: Date): Promise<Record<string, bigint>> {
    const meters = await this.client.billing.meters.list({ limit: 100 });
    const result: Record<string, bigint> = {};
    for (const meter of meters.data.filter((value) =>
      value.event_name === "accepted_readings" || value.event_name === "active_devices")) {
      const summaries = await this.client.billing.meters.listEventSummaries(meter.id, {
        customer: customerId,
        start_time: Math.floor(periodStart.getTime() / 1000),
        end_time: Math.floor(periodEnd.getTime() / 1000), limit: 100,
      });
      const quantity = summaries.data.reduce((sum, item) => {
        if (!Number.isSafeInteger(item.aggregated_value)) throw new Error("unsafe Stripe meter summary");
        return sum + BigInt(item.aggregated_value);
      }, 0n);
      result[meter.event_name] = quantity;
    }
    return result;
  }
}
