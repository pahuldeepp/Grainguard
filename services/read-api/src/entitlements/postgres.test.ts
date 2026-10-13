import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient, Pool } from "pg";
import type { ReplicaProvider, ReplicaRequest } from "../replicas.js";
import { readContext } from "../consistency.js";
import { postgresHistoryEntitlements } from "./postgres.js";
const tenant = "11111111-1111-4111-8111-111111111111";
test("entitlement metadata is primary-only, uncertifying and uses the request budget", async () => {
  const controller = new AbortController();
  const deadline = Date.now() + 1000;
  let acquisitions = 0,
    commits = 0,
    rollbacks = 0;
  const snapshots = {
    acquire: async (request: ReplicaRequest) => {
      acquisitions++;
      assert.equal(request.primaryOnly, true);
      assert.equal(request.certify, false);
      assert.equal(request.deadline, deadline);
      assert.equal(request.signal, controller.signal);
      return {
        endpoint: "primary",
        tx: {
          query: async (_sql: string, values: string[]) => {
            assert.deepEqual(values, [tenant]);
            return { rows: [{ days: 14, plan_version: "2" }] };
          },
        } as unknown as PoolClient,
        commit: async () => {
          commits++;
        },
        rollback: async () => {
          rollbacks++;
        },
      };
    },
  } as unknown as ReplicaProvider;
  const entitlements = postgresHistoryEntitlements(
    {} as Pool,
    () => {},
    snapshots,
  );
  await readContext.run(
    { tenantId: tenant, deadline, signal: controller.signal },
    async () => {
      assert.deepEqual(await entitlements.rangeDays(tenant), {
        days: 14,
        planVersion: 2,
      });
      assert.equal(readContext.getStore()?.watermark, undefined);
      controller.abort();
      await assert.rejects(
        entitlements.rangeDays(tenant),
        /read_freshness_unavailable/,
      );
    },
  );
  assert.equal(acquisitions, 1);
  assert.equal(commits, 1);
  assert.equal(rollbacks, 0);
});
