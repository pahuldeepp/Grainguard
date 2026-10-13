import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { withReadTenant } from "@greenguard/read-model";
import {
  createReadReplicas,
  FreshnessUnavailable,
  ConsistencyIdentityMismatch,
} from "./replicas.js";
import { postgresReads } from "./backends.js";
import { snapshotWatermark } from "./watermark-cache.js";

test(
  "real PG snapshot selects current ownership despite retained higher old-epoch watermark",
  {
    skip:
      !process.env.FRESHNESS_PG_ADMIN_URL ||
      !process.env.FRESHNESS_PG_QUERY_URL,
  },
  async () => {
    const tenantId = randomUUID(),
      incarnation = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.FRESHNESS_PG_ADMIN_URL,
    });
    const primary = new pg.Pool({
      connectionString: process.env.FRESHNESS_PG_QUERY_URL,
      max: 2,
      connectionTimeoutMillis: 1000,
      query_timeout: 2000,
    });
    const provider = createReadReplicas(
      undefined,
      undefined,
      process.env.FRESHNESS_PG_QUERY_URL!,
      {
        primaryPool: primary,
        allowPrimaryOnly: true,
        requireWatermark: true,
        attemptTimeoutMs: 1000,
      },
    )!;
    await admin.connect();
    const updateSequence = async (epoch: string, sequence: string) => {
      await admin.query("BEGIN");
      try {
        await admin.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.shard_id','s2',true),set_config('app.shard_incarnation',$2,true),set_config('app.placement_epoch',$3,true)",
          [tenantId, incarnation, epoch],
        );
        await admin.query(
          "UPDATE public.projection_watermarks SET sequence=$4::bigint WHERE tenant_id=$1::uuid AND shard_incarnation=$2::uuid AND placement_epoch=$3::bigint",
          [tenantId, incarnation, epoch, sequence],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    };
    try {
      await admin.query(
        "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s2',$2,4,'active')",
        [tenantId, incarnation],
      );
      await updateSequence("4", "9007199254740994");
      // Trusted scratch fixture simulates retaining the old identity after cutover.
      await admin.query(
        "UPDATE greenguard_internal.tenant_ownership SET placement_epoch=5 WHERE tenant_id=$1",
        [tenantId],
      );
      await updateSequence("5", "10");
      const placement = {
        shardId: "s2",
        shardIncarnation: incarnation,
        placementEpoch: "5",
      };
      const lease = await provider.acquire({
        tenantId,
        placement,
        deadline: Date.now() + 2000,
        minimumSequence: { ...placement, sequence: "10" },
      });
      assert.deepEqual(lease.watermark, {
        shardIncarnation: incarnation,
        placementEpoch: "5",
        sequence: "10",
      });
      assert.equal(
        (
          await lease.tx.query(
            "SELECT count(*)::int AS count FROM read.projection_watermarks WHERE tenant_id=$1",
            [tenantId],
          )
        ).rows[0].count,
        2,
      );
      await lease.commit();
      await assert.rejects(
        provider.acquire({
          tenantId,
          placement,
          deadline: Date.now() + 2000,
          minimumSequence: {
            shardIncarnation: incarnation,
            placementEpoch: "4",
            sequence: "9007199254740994",
          },
        }),
        ConsistencyIdentityMismatch,
      );
      const normal = await provider.acquire({
        tenantId,
        placement,
        deadline: Date.now() + 2000,
      });
      assert.equal(normal.watermark?.placementEpoch, "5");
      await normal.commit();
      const watermark = await withReadTenant(primary, tenantId, (tx) =>
        snapshotWatermark(tx, tenantId),
      );
      assert.equal(watermark.placementEpoch, "5");
      assert.equal(watermark.sequence, "10");
      const aggregate = await postgresReads(provider).deviceCurrent(
        tenantId,
        randomUUID(),
      );
      assert.deepEqual(aggregate, { device: null, latestReading: null });
      // Nonempty aggregate parity uses only this isolated harness database. The
      // microsecond/offset timestamps must match pg Date -> HTTP JSON encoding.
      const deviceId = randomUUID(),
        foreignTenant = randomUUID(),
        foreignOnly = randomUUID();
      const fixtureTime = "2026-09-27T12:34:56.123456-05:00";
      await admin.query(
        "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s2',$2,5,'active')",
        [foreignTenant, incarnation],
      );
      const insertFixture = async (
        tenant: string,
        id: string,
        version: string,
      ) => {
        const site = randomUUID(),
          reading = randomUUID(),
          event = randomUUID();
        await admin.query("BEGIN");
        try {
          await admin.query(
            "SELECT set_config('app.tenant_id',$1,true),set_config('app.shard_id','s2',true),set_config('app.shard_incarnation',$2,true),set_config('app.placement_epoch','5',true)",
            [tenant, incarnation],
          );
          await admin.query(
            "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version,updated_at) VALUES($1,$2,$3,'parity','active',$4,$5)",
            [tenant, id, site, version, fixtureTime],
          );
          await admin.query(
            "INSERT INTO public.reading_history(tenant_id,reading_id,device_id,event_id,stream_version,source_message_id,site_id,observed_at,received_at,temperature_c,relative_humidity_percent,inventory_enrichment,projected_at) VALUES($1,$2,$3,$4::uuid,$5,$4::text,$6,$7,$7,23.5,60.25,'applied',$7)",
            [tenant, reading, id, event, version, site, fixtureTime],
          );
          await admin.query(
            "INSERT INTO public.consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event,processed_at) VALUES('projection-builder',$1,$2,'parity',0,1,$3,$4)",
            [
              tenant,
              event,
              JSON.stringify({
                event_type: "telemetry.recorded",
                aggregate_id: id,
                schema_version: 1,
                payload: {
                  device_id: id,
                  reading_id: reading,
                  site_id: site,
                  observed_at: fixtureTime,
                  received_at: fixtureTime,
                  measurements: {
                    temperature_c: 23.5,
                    relative_humidity_percent: 60.25,
                  },
                },
              }),
              fixtureTime,
            ],
          );
          await admin.query(
            "INSERT INTO public.device_latest(tenant_id,device_id,reading_id,event_id,selected_observed_at,selected_stream_version,max_seen_stream_version,contiguous_through_version,projected_at) VALUES($1,$2,$3,$4,$5,$6,$6,$6,$5)",
            [tenant, id, reading, event, fixtureTime, version],
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      await insertFixture(tenantId, deviceId, "9007199254740993");
      await insertFixture(foreignTenant, deviceId, "9007199254740995");
      await insertFixture(foreignTenant, foreignOnly, "9007199254740997");
      const reads = postgresReads(provider);
      const current = await reads.deviceCurrent(tenantId, deviceId);
      const ordinaryDevice = JSON.parse(
        JSON.stringify(await reads.device(tenantId, deviceId)),
      );
      const ordinaryLatest = JSON.parse(
        JSON.stringify(await reads.latest(tenantId, deviceId)),
      );
      assert.equal(current.device?.inventory_version, "9007199254740993");
      assert.deepEqual(current.device, ordinaryDevice);
      assert.equal(
        current.latestReading?.observed_at,
        "2026-09-27T17:34:56.123Z",
      );
      // age_seconds is volatile, but its NUMERIC wire type must remain text.
      assert.equal(
        typeof current.latestReading?.age_seconds,
        typeof ordinaryLatest.age_seconds,
      );
      assert.equal(typeof current.latestReading?.age_seconds, "string");
      const comparableLatest = {
        ...ordinaryLatest,
        stream_version: ordinaryLatest.stream_version ?? null,
      };
      delete comparableLatest.age_seconds;
      const comparableCurrent = { ...current.latestReading };
      delete comparableCurrent.age_seconds;
      assert.deepEqual(comparableCurrent, comparableLatest);
      assert.deepEqual(await reads.deviceCurrent(tenantId, foreignOnly), {
        device: null,
        latestReading: null,
      });
      // Real server evidence: abort an active SQL statement, discard its transport,
      // and verify it cannot keep a snapshot or execute another business statement.
      const controller = new AbortController();
      const cancellationDeadline = Date.now() + 2000;
      const cancelled = await provider.acquire({
        tenantId,
        placement,
        deadline: cancellationDeadline,
        signal: controller.signal,
      });
      const pid = (await cancelled.tx.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      const running = cancelled.tx.query("SELECT pg_sleep(3)");
      for (let attempt = 0; attempt < 30; attempt++) {
        const active = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE '%pg_sleep%'",
          [pid],
        );
        if (active.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      await assert.rejects(running, FreshnessUnavailable);
      await assert.rejects(cancelled.commit(), FreshnessUnavailable);
      await cancelled.rollback();
      let gone = false;
      while (Date.now() < cancellationDeadline + 250) {
        const active = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active'",
          [pid],
        );
        if (!active.rowCount) {
          gone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        gone,
        true,
        "cancelled backend must finish within its server statement timeout",
      );
      await admin.query(
        "UPDATE greenguard_internal.tenant_ownership SET state='fenced' WHERE tenant_id=$1",
        [tenantId],
      );
      await assert.rejects(
        provider.acquire({ tenantId, placement, deadline: Date.now() + 2000 }),
        FreshnessUnavailable,
      );
    } finally {
      await provider.close();
      await primary.end();
      await admin.end();
    }
  },
);
