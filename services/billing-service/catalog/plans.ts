// Rate limits are integer READINGS PER MINUTE (entitlement limits must be integers).
// TEST MODE ONLY. These are engineering fixtures, not approved commercial prices.
// The owner must replace the amounts and plan limits before catalog sync against
// their Stripe test account. Lookup keys remain stable across Stripe price IDs.
export const plans = {
  free: {
    version: 1, lookupKey: "greenguard_free_monthly_v1", amountCents: 0,
    limits: { "devices.max": 10, "seats.max": 3, "api_keys.max": 1,
      "ingest.readings_per_month": 100_000, "history.range_days": 7,
      "ingest.rate_per_device": 12, "ingest.rate_per_tenant": 12_000, "retention.days": 7, "exports.per_day": 0 },
    features: { sso: false, audit_export: false },
  },
  standard: {
    version: 1, lookupKey: "greenguard_standard_monthly_v1", amountCents: 4900,
    limits: { "devices.max": 100, "seats.max": 20, "api_keys.max": 10,
      "ingest.readings_per_month": 1_000_000, "history.range_days": 90,
      "ingest.rate_per_device": 60, "ingest.rate_per_tenant": 60_000, "retention.days": 90, "exports.per_day": 5 },
    features: { sso: false, audit_export: true },
  },
  enterprise: {
    version: 1, lookupKey: "greenguard_enterprise_monthly_v1", amountCents: 19900,
    limits: { "devices.max": 1000, "seats.max": 500, "api_keys.max": 100,
      "ingest.readings_per_month": 20_000_000, "history.range_days": 365,
      "ingest.rate_per_device": 300, "ingest.rate_per_tenant": 600_000, "retention.days": 365, "exports.per_day": 50 },
    features: { sso: true, audit_export: true },
  },
} as const;

export type PlanKey = keyof typeof plans;
export const isPlanKey = (value: string): value is PlanKey => Object.hasOwn(plans, value);
