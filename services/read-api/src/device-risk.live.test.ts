import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { postgresReads } from "./backends.js";
import type { ReplicaProvider } from "./replicas.js";

test(
  "live risk projection enforces read_query RLS and application scope with rollback-only fixtures",
  {
    skip: process.env.READ_RISK_LIVE !== "1",
  },
  async () => {
    const adminUrl = new URL(process.env.POSTGRES_ADMIN_URL!);
    adminUrl.pathname = "/greenguard_read";
    const client = new pg.Client({
      connectionString: adminUrl.toString(),
      connectionTimeoutMillis: 2000,
    });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='4s'");
      const owners = await client.query(
        "SELECT tenant_id::text,shard_id,shard_incarnation::text,placement_epoch::text FROM greenguard_internal.tenant_ownership WHERE state='active' ORDER BY tenant_id LIMIT 2",
      );
      assert.equal(
        owners.rows.length,
        2,
        "two bootstrapped tenants are required",
      );
      const device = randomUUID(),
        foreignDevice = randomUUID(),
        site = randomUUID();
      const assessmentIDs = [randomUUID(), randomUUID()];
      const withdrawnIDs = [randomUUID(), randomUUID()];
      const invalidationEvents: string[] = [];
      const install = async (tenant: string) => {
        const owner = owners.rows.find((row) => row.tenant_id === tenant)!;
        for (const [key, value] of [
          ["app.tenant_id", tenant],
          ["app.shard_id", owner.shard_id],
          ["app.shard_incarnation", owner.shard_incarnation],
          ["app.placement_epoch", owner.placement_epoch],
        ]) {
          await client.query("SELECT set_config($1,$2,true)", [key, value]);
        }
        await client.query(
          "SELECT greenguard_internal.admit_tenant_placement($1::uuid,$2::text,$3::uuid,$4::bigint)",
          [
            tenant,
            owner.shard_id,
            owner.shard_incarnation,
            owner.placement_epoch,
          ],
        );
      };
      for (let index = 0; index < 2; index++) {
        const tenant = owners.rows[index]!.tenant_id as string;
        await install(tenant);
        await client.query(
          "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,$3,'rollback-risk-test','active',1)",
          [tenant, device, site],
        );
        if (index === 0)
          await client.query(
            "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,$3,'rollback-risk-foreign-test','active',1)",
            [tenant, foreignDevice, site],
          );
        const event = randomUUID();
        await client.query(
          "INSERT INTO public.consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-only',0,0,$3::jsonb)",
          [
            tenant,
            event,
            JSON.stringify({
              event_type: "risk.assessed",
              aggregate_type: "device_risk",
              aggregate_id: device,
              aggregate_version: "1",
            }),
          ],
        );
        await client.query(
          "INSERT INTO public.risk_assessments(tenant_id,assessment_id,device_id,assessment_version,reading_id,source_event_id,bin_id,lot_id,grain_type,policy_version,score,severity,alert_eligible,reasons,event_id,occurred_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,'wheat',1,$8,'normal',false,'[]'::jsonb,$9,$10)",
          [
            tenant,
            assessmentIDs[index],
            device,
            randomUUID(),
            randomUUID(),
            randomUUID(),
            randomUUID(),
            11 + index,
            event,
            new Date("2026-10-03T12:00:00Z"),
          ],
        );
      }
      // Newer withdrawn rows must not consume the limit or imply truncation.
      // Install the immutable withdrawal before its assessment to prove that
      // absence of the assessment does not drop the withdrawal.
      await install(owners.rows[0]!.tenant_id);
      for (let index = 0; index < withdrawnIDs.length; index++) {
        const invalidationEvent = randomUUID(),
          assessmentEvent = randomUUID();
        invalidationEvents.push(invalidationEvent);
        await client.query(
          "INSERT INTO public.consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-invalidation',0,$3,'{}'::jsonb)",
          [owners.rows[0]!.tenant_id, invalidationEvent, index],
        );
        await client.query(
          "INSERT INTO public.risk_assessment_invalidations(tenant_id,event_id,assessment_id,assessment_version,device_id,payload,occurred_at) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,now())",
          [
            owners.rows[0]!.tenant_id,
            invalidationEvent,
            withdrawnIDs[index],
            index + 2,
            device,
          ],
        );
        await client.query(
          "INSERT INTO public.consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-assessment',0,$3,'{}'::jsonb)",
          [owners.rows[0]!.tenant_id, assessmentEvent, index],
        );
        await client.query(
          "INSERT INTO public.risk_assessments(tenant_id,assessment_id,device_id,assessment_version,reading_id,source_event_id,bin_id,lot_id,grain_type,policy_version,score,severity,alert_eligible,reasons,event_id,occurred_at) SELECT tenant_id,$2,device_id,$3,reading_id,source_event_id,bin_id,lot_id,grain_type,policy_version,score,'critical',true,reasons,$4,occurred_at+interval '1 hour' FROM public.risk_assessments WHERE tenant_id=$1 AND assessment_id=$5",
          [
            owners.rows[0]!.tenant_id,
            withdrawnIDs[index],
            index + 2,
            assessmentEvent,
            assessmentIDs[0],
          ],
        );
        // The same assessment identity in another tenant must stay visible.
        if (index === 0) {
          await install(owners.rows[1]!.tenant_id);
          const otherEvent = randomUUID();
          await client.query(
            "INSERT INTO public.consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'rollback-other',0,0,'{}'::jsonb)",
            [owners.rows[1]!.tenant_id, otherEvent],
          );
          await client.query(
            "INSERT INTO public.risk_assessments(tenant_id,assessment_id,device_id,assessment_version,reading_id,source_event_id,bin_id,lot_id,grain_type,policy_version,score,severity,alert_eligible,reasons,event_id,occurred_at) SELECT tenant_id,$2,device_id,2,reading_id,source_event_id,bin_id,lot_id,grain_type,policy_version,score,severity,alert_eligible,reasons,$3,occurred_at-interval '1 hour' FROM public.risk_assessments WHERE tenant_id=$1 AND assessment_id=$4",
            [
              owners.rows[1]!.tenant_id,
              withdrawnIDs[0],
              otherEvent,
              assessmentIDs[1],
            ],
          );
          await install(owners.rows[0]!.tenant_id);
        }
      }
      await client.query("SET LOCAL ROLE read_query");
      const roles = await client.query(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      assert.equal(roles.rows[0]!.rolbypassrls, false);
      const provider = {
        withTenant: async (
          tenant: string,
          run: (tx: unknown) => Promise<unknown>,
        ) => {
          await install(tenant);
          return run(client);
        },
      } as unknown as ReplicaProvider;
      const reads = postgresReads(provider);
      const query = {
        deviceId: device,
        from: new Date("2026-10-03T00:00:00Z"),
        to: new Date("2026-10-04T00:00:00Z"),
        limit: 1,
      };
      for (let index = 0; index < 2; index++) {
        const result = await reads.deviceRisk({
          ...query,
          tenantId: owners.rows[index]!.tenant_id,
        });
        assert.equal(result.status, "available");
        assert.deepEqual(
          result.assessments.map((row) => row.assessment_id),
          [assessmentIDs[index]],
        );
        assert.equal(result.assessments[0]!.score, 11 + index);
        assert.equal(result.actionable, false);
        assert.equal(result.validity, "unverified");
        assert.equal(result.truncated, index === 1);
      }
      const crossTenant = await reads.deviceRisk({
        ...query,
        limit: 100,
        tenantId: owners.rows[1]!.tenant_id,
      });
      assert(
        crossTenant.assessments.some(
          (row) => row.assessment_id === withdrawnIDs[0],
        ),
        "foreign tenant withdrawal must not hide same assessment ID",
      );
      const foreignLedger = await client.query(
        "SELECT event_id FROM read.risk_assessment_invalidations WHERE tenant_id=$1",
        [owners.rows[0]!.tenant_id],
      );
      assert.equal(
        foreignLedger.rows.length,
        0,
        "forced RLS denies explicitly requested foreign ledger rows",
      );
      const security = await client.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.risk_assessment_invalidations'::regclass",
      );
      assert.deepEqual(security.rows[0], {
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      const denied = await reads.deviceRisk({
        ...query,
        deviceId: foreignDevice,
        tenantId: owners.rows[1]!.tenant_id,
      });
      assert.equal(denied.status, "device_not_found");
      assert.deepEqual(denied.assessments, []);
      const rls = await client.query(
        "SELECT assessment_id FROM read.risk_assessments WHERE tenant_id=$1 AND assessment_id=$2",
        [owners.rows[0]!.tenant_id, assessmentIDs[0]],
      );
      assert.equal(
        rls.rows.length,
        0,
        "RLS must deny foreign rows even with a foreign application predicate",
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
