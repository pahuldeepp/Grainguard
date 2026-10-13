import type { Pool } from "pg";
import { withReadTenant } from "@greenguard/read-model";
import type { ReplicaProvider } from "../replicas.js";
import { readContext, assertReadActive } from "../consistency.js";
import type { ReadTransaction } from "@greenguard/read-model";
import type { HistoryEntitlements } from "./history.js";

export function postgresHistoryEntitlements(
  pool: Pick<Pool, "connect"> | ((tenantId: string) => Pick<Pool, "connect">),
  onStale: (tenantId: string) => void = () => {},
  snapshots?: ReplicaProvider,
): HistoryEntitlements {
  return {
    async rangeDays(tenantId) {
      assertReadActive();
      const query = async (tx: ReadTransaction) =>
        (
          await tx.query<{ days: number; plan_version: string }>(
            `SELECT CASE WHEN read.entitlement_feed_fresh() AND
          (limits->>'history.range_days') ~ '^[0-9]+$' THEN
          LEAST((limits->>'history.range_days')::numeric,31)::int END AS days,
          plan_version::text FROM read.tenant_entitlements WHERE tenant_id=$1`,
            [tenantId],
          )
        ).rows;
      let rows: { days: number; plan_version: string }[];
      if (snapshots) {
        const context = readContext.getStore();
        const lease = await snapshots.acquire({
          tenantId,
          primaryOnly: true,
          certify: false,
          deadline: context?.deadline ?? Date.now() + 4000,
          signal: context?.signal,
        });
        try {
          rows = await query(lease.tx);
          await lease.commit();
        } catch (error) {
          await lease.rollback().catch(() => {});
          throw error;
        }
      } else
        rows = await withReadTenant(
          typeof pool === "function" ? pool(tenantId) : pool,
          tenantId,
          query,
        );
      assertReadActive();
      if (!rows[0] || rows[0].days === null) {
        onStale(tenantId);
        return { days: 7, planVersion: 1 };
      }
      return { days: rows[0].days, planVersion: Number(rows[0].plan_version) };
    },
  };
}
