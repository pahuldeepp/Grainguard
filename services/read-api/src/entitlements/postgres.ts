import type { Pool } from "pg";
import { withReadTenant } from "@greenguard/read-model";
import type { HistoryEntitlements } from "./history.js";

export function postgresHistoryEntitlements(
  pool: Pick<Pool, "connect">,
  onStale: (tenantId: string) => void = () => {},
): HistoryEntitlements {
  return {
    async rangeDays(tenantId) {
      const rows = await withReadTenant(
        pool,
        tenantId,
        async (tx) =>
          (
            await tx.query<{ days: number; plan_version: string }>(
              `SELECT CASE WHEN read.entitlement_feed_fresh() AND
          (limits->>'history.range_days') ~ '^[0-9]+$' THEN
          LEAST((limits->>'history.range_days')::numeric,31)::int END AS days,
          plan_version::text FROM read.tenant_entitlements WHERE tenant_id=$1`,
              [tenantId],
            )
          ).rows,
      );
      if (!rows[0] || rows[0].days === null) {
        onStale(tenantId);
        return { days: 7, planVersion: 1 };
      }
      return { days: rows[0].days, planVersion: Number(rows[0].plan_version) };
    },
  };
}
