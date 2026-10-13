import type { Db } from "./db.js";
import { withTenant } from "./db.js";
import { audit } from "./events.js";
import { writeFinding, type Finding } from "./findings.js";
import { freshId, nameId } from "./ids.js";
import type { StripePort } from "./stripe-port.js";
import { monthStart, nextMonth } from "./usage.js";

export type { Finding };

export class BillingReconciliation {
  constructor(private readonly db: Db, private readonly stripe: StripePort) {}

  async run(tenantId: string, periodStart: Date, actor = "system"):
    Promise<{ runId: string; findings: Finding[] }> {
    if (monthStart(periodStart).getTime() !== periodStart.getTime())
      throw new Error("reconciliation period must start at UTC month boundary");
    const local = await withTenant(this.db, tenantId, async (tx) => ({
      customer: (await tx.$queryRaw<{ stripe_customer_id: string }[]>`
        SELECT stripe_customer_id FROM billing_customers WHERE tenant_id=${tenantId}::uuid`)[0],
      subscriptions: await tx.$queryRaw<{ stripe_subscription_id: string; status: string; plan_key: string }[]>`
        SELECT stripe_subscription_id,status,plan_key FROM subscriptions WHERE tenant_id=${tenantId}::uuid`,
      invoices: await tx.$queryRaw<{ invoice_id: string; status: string; amount_due: bigint }[]>`
        SELECT invoice_id,status,amount_due FROM invoice_mirrors WHERE tenant_id=${tenantId}::uuid`,
      reports: await tx.$queryRaw<{ meter: string; quantity: bigint }[]>`
        SELECT meter,quantity FROM usage_reports WHERE tenant_id=${tenantId}::uuid
          AND period_start=${periodStart}`,
    }));
    if (!local.customer) throw new Error("billing customer not found");
    const customerId = local.customer.stripe_customer_id;
    const [remoteSubscriptions, remoteInvoices, meterSummaries] = await Promise.all([
      this.stripe.listSubscriptions(customerId), this.stripe.listInvoices(customerId),
      this.stripe.listMeterSummaries(customerId, periodStart, nextMonth(periodStart)),
    ]);
    const findings: Finding[] = [];
    for (const remote of remoteSubscriptions) {
      const match = local.subscriptions.find((value) => value.stripe_subscription_id === remote.id);
      if (remote.customerId !== customerId || remote.tenantId !== tenantId) {
        findings.push({ objectType: "subscription", objectId: remote.id,
          diffClass: "tenant_binding_mismatch", local: {},
          remote: { customer_id: remote.customerId, tenant_id: remote.tenantId } });
      } else if (!match || match.status !== remote.status || match.plan_key !== remote.planKey) {
        findings.push({ objectType: "subscription", objectId: remote.id,
          diffClass: "subscription_mismatch", local: match
            ? { status: match.status, plan_key: match.plan_key } : {},
          remote: { status: remote.status, plan_key: remote.planKey } });
      }
    }
    for (const remote of remoteInvoices) {
      const match = local.invoices.find((value) => value.invoice_id === remote.id);
      if (!match || match.status !== remote.status || match.amount_due !== BigInt(remote.amountDue))
        findings.push({ objectType: "invoice", objectId: remote.id,
          diffClass: "invoice_mismatch", local: match
            ? { status: match.status, amount_due: match.amount_due.toString() } : {},
          remote: { status: remote.status, amount_due: String(remote.amountDue) } });
    }
    for (const report of local.reports) {
      const remote = meterSummaries[report.meter];
      if (remote === undefined || report.quantity !== remote)
        findings.push({ objectType: "meter", objectId: report.meter,
          diffClass: "usage_mismatch", local: { quantity: report.quantity.toString() },
          remote: { quantity: remote?.toString() ?? "missing" } });
    }
    const runId = freshId();
    await withTenant(this.db, tenantId, async (tx) => {
      await tx.$executeRaw`INSERT INTO reconciliation_runs
        (tenant_id,run_id,period_start) VALUES (${tenantId}::uuid,${runId}::uuid,${periodStart})`;
      for (const [index, finding] of findings.entries()) {
        const findingId = nameId("billing-finding", tenantId, runId, String(index));
        await writeFinding(tx, tenantId, runId, findingId, finding);
      }
      await audit(tx, tenantId, actor, "billing.reconciliation.run", runId,
        { period_start: periodStart.toISOString(), findings: findings.length }, runId);
    });
    return { runId, findings };
  }
}
