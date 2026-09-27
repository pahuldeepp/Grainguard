import type { Tx } from "./db.js";

// Queue contents stay private; this tenant-scoped procedure mutates the ID index.
// Rows are never deleted: nothing due marks the row done, a new deadline reopens it.
async function upsertDue(
  tx: Tx,
  tenantId: string,
  kind: "subscription" | "usage",
  due: Date | null | undefined,
): Promise<void> {
  await tx.$executeRaw`SELECT billing_inbox.set_due_work(
    ${tenantId}::uuid, ${kind}, ${due ?? null}::timestamptz)`;
}

export async function scheduleSubscription(
  tx: Tx,
  tenantId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ due_at: Date }[]>`
    SELECT CASE
      WHEN pending_plan_key IS NOT NULL THEN current_period_end
      WHEN cancel_at_period_end AND entitlement_plan_key <> 'free' THEN current_period_end
      WHEN status='past_due' AND entitlement_plan_key <> 'free' THEN grace_until
      ELSE NULL END AS due_at
    FROM subscriptions WHERE tenant_id=${tenantId}::uuid`;
  const due = rows[0]?.due_at;
  await upsertDue(tx, tenantId, "subscription", due);
}

export async function scheduleUsage(tx: Tx, tenantId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ due_at: Date | null }[]>`
    SELECT min(period_end) AS due_at FROM usage_periods
    WHERE tenant_id=${tenantId}::uuid AND state='open'`;
  const due = rows[0]?.due_at;
  await upsertDue(tx, tenantId, "usage", due);
}
