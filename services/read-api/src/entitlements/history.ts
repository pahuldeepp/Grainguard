export interface HistoryEntitlements {
  rangeDays(tenantId: string): Promise<{ days: number; planVersion: number }>;
}
export const defaultHistoryEntitlements: HistoryEntitlements = {
  async rangeDays() {
    return { days: 7, planVersion: 1 };
  },
};
export class HistoryEntitlementError extends Error {
  constructor(readonly planVersion: number) {
    super("entitlement_exceeded");
  }
}
export async function assertHistoryRange(
  entitlements: HistoryEntitlements,
  tenantId: string,
  from: Date,
  to: Date,
): Promise<void> {
  const { days, planVersion } = await entitlements.rangeDays(tenantId);
  const bounded =
    Number.isSafeInteger(days) && days >= 0 ? Math.min(days, 31) : 7;
  if (to.getTime() - from.getTime() > bounded * 86_400_000)
    throw new HistoryEntitlementError(planVersion);
}
