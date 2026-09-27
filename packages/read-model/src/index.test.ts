import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  getDevice,
  getDevices,
  getFreshness,
  getLatestReading,
  getReading,
  listDevicesBySite,
  listReadings,
  withReadTenant,
} from "./index.js";

test("tenant transaction commits and releases, while failures roll back", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    },
    release: () => calls.push("release"),
  };
  const db = { connect: async () => client as unknown as PoolClient };
  assert.equal(await withReadTenant(db, randomUUID(), async () => 7), 7);
  assert.deepEqual(calls, [
    "BEGIN READ ONLY",
    "SELECT set_config('app.tenant_id', $1, true)",
    "COMMIT",
    "release",
  ]);
  calls.length = 0;
  await assert.rejects(
    withReadTenant(db, randomUUID(), async () => {
      throw new Error("failure");
    }),
    /failure/,
  );
  assert.deepEqual(calls, [
    "BEGIN READ ONLY",
    "SELECT set_config('app.tenant_id', $1, true)",
    "ROLLBACK",
    "release",
  ]);
  await assert.rejects(
    withReadTenant(db, "", async () => undefined),
    /valid tenant/,
  );
  await assert.rejects(
    withReadTenant(
      db,
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      async () => undefined,
    ),
    /valid tenant/,
  );
  const released: Array<Error | undefined> = [];
  const broken = {
    query: async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("socket lost");
      return { rows: [] };
    },
    release: (error?: Error) => released.push(error),
  };
  await assert.rejects(
    withReadTenant(
      { connect: async () => broken as unknown as PoolClient },
      randomUUID(),
      async () => {
        throw new Error("original failure");
      },
    ),
    /original failure/,
  );
  assert.match(released[0]?.message ?? "", /socket lost/);
});

test("all read queries include an explicit tenant predicate and bounded list inputs", async () => {
  const seen: Array<{ sql: string; args: unknown[] }> = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      seen.push({ sql, args });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const tenant = randomUUID(),
    id = randomUUID();
  await getDevice(tx, tenant, id);
  await getLatestReading(tx, tenant, id);
  await getReading(tx, tenant, id);
  await listDevicesBySite(tx, tenant, id);
  await listReadings(tx, tenant, id, new Date(0), new Date(1));
  await getFreshness(tx, tenant, id);
  assert.equal(seen.length, 6);
  for (const { sql, args } of seen) {
    assert.match(sql, /tenant_id=\$1/);
    assert.equal(args[0], tenant);
  }
  await assert.rejects(listDevicesBySite(tx, tenant, id, 501), /limit/);
  await assert.rejects(
    listReadings(tx, tenant, id, new Date(1), new Date(0)),
    /invalid/,
  );
  await assert.rejects(
    listReadings(tx, tenant, id, new Date(Number.NaN), new Date()),
    /invalid/,
  );
});

test(
  "live read role sees only its tenant and cannot write or inspect checkpoints",
  { skip: process.env.READ_MODEL_LIVE !== "1" },
  async () => {
    const adminUrl = process.env.POSTGRES_ADMIN_URL;
    if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL required");
    const url = new URL(adminUrl);
    url.pathname = "/greenguard_read";
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const client = await pool.connect();
    const tenants = [randomUUID(), randomUUID()];
    const devices = [randomUUID(), randomUUID()];
    const readings = [randomUUID(), randomUUID()];
    const events = [randomUUID(), randomUUID()];
    const site = randomUUID();
    const observed = new Date();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT public.projection_history_partition($1::date)",
        [observed.toISOString().slice(0, 10)],
      );
      for (let i = 0; i < 2; i++) {
        await client.query(
          "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,$3,$4,$5,1)",
          [tenants[i], devices[i], site, `read-test-${i}`, "active"],
        );
        await client.query(
          "INSERT INTO public.consumer_inbox(consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event) VALUES('projection-builder',$1,$2,'test',0,$3,$4::jsonb)",
          [
            tenants[i],
            events[i],
            i,
            JSON.stringify({
              aggregate_id: devices[i],
              aggregate_version: 1,
              event_type: "telemetry.recorded",
              payload: {
                reading_id: readings[i],
                device_id: devices[i],
                observed_at: observed.toISOString(),
                received_at: observed.toISOString(),
                measurements: { temperature_c: 20 },
              },
            }),
          ],
        );
        await client.query(
          "INSERT INTO public.reading_history(tenant_id,reading_id,device_id,event_id,stream_version,source_message_id,site_id,observed_at,received_at,temperature_c,inventory_enrichment) VALUES($1,$2,$3,$4,1,$5,$6,$7,$7,20,'applied')",
          [
            tenants[i],
            readings[i],
            devices[i],
            events[i],
            `test-${i}`,
            site,
            observed,
          ],
        );
        await client.query(
          "INSERT INTO public.device_latest(tenant_id,device_id,reading_id,event_id,selected_observed_at,selected_stream_version,max_seen_stream_version,contiguous_through_version) VALUES($1,$2,$3,$4,$5,1,1,1)",
          [tenants[i], devices[i], readings[i], events[i], observed],
        );
      }
      await client.query("SET LOCAL ROLE read_query");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenants[0],
      ]);
      assert.equal(
        (await getDevice(client, tenants[0], devices[0]))?.device_id,
        devices[0],
      );
      assert.equal(await getDevice(client, tenants[0], devices[1]), null);
      assert.deepEqual(
        (await getDevices(client, tenants[0], devices)).map(
          (row) => row.device_id,
        ),
        [devices[0]],
      );
      assert.equal(
        (await listDevicesBySite(client, tenants[0], site)).length,
        1,
      );
      assert.equal(
        (await getReading(client, tenants[0], readings[0]))?.reading_id,
        readings[0],
      );
      assert.equal(await getReading(client, tenants[0], readings[1]), null);
      assert.equal(
        (await getLatestReading(client, tenants[0], devices[0]))?.reading_id,
        readings[0],
      );
      assert.equal(
        await getLatestReading(client, tenants[0], devices[1]),
        null,
      );
      assert.equal(
        (await getFreshness(client, tenants[0], devices[0]))?.device_id,
        devices[0],
      );
      assert.equal(await getFreshness(client, tenants[0], devices[1]), null);
      assert.deepEqual(
        (
          await listReadings(
            client,
            tenants[0],
            devices[0],
            new Date(observed.getTime() - 1000),
            new Date(observed.getTime() + 1000),
          )
        ).map((r) => r.reading_id),
        [readings[0]],
      );
      assert.deepEqual(
        await listReadings(
          client,
          tenants[0],
          devices[1],
          new Date(observed.getTime() - 1000),
          new Date(observed.getTime() + 1000),
        ),
        [],
      );
      await client.query("RESET ROLE");
      await client.query(
        "DELETE FROM public.reading_history WHERE tenant_id=$1 AND reading_id=$2",
        [tenants[0], readings[0]],
      );
      await client.query("SET LOCAL ROLE read_query");
      const durableLatest = await getLatestReading(
        client,
        tenants[0],
        devices[0],
      );
      assert.equal(durableLatest?.reading_id, readings[0]);
      assert.equal(durableLatest?.temperature_c, 20);
      assert.equal(durableLatest?.inventory_enrichment, "source");
      assert.equal(await getReading(client, tenants[0], readings[0]), null);
      assert.equal(
        await getLatestReading(client, tenants[0], devices[1]),
        null,
      );
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [""]);
      assert.equal(await getDevice(client, tenants[0], devices[0]), null);
      assert.equal(await getReading(client, tenants[0], readings[0]), null);
      const privileges = await client.query(
        "SELECT has_table_privilege('read_query','public.projection_checkpoints','SELECT') AS checkpoint, has_table_privilege('read_query','public.device_views','INSERT') AS insert_allowed, has_table_privilege('read_query','public.device_views','UPDATE') AS update_allowed",
      );
      assert.deepEqual(privileges.rows[0], {
        checkpoint: false,
        insert_allowed: false,
        update_allowed: false,
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);
