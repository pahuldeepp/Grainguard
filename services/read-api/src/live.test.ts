import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import pg from "pg";
import cassandra from "cassandra-driver";
import { createApp } from "./app.js";
import { CassandraHistory, ElasticSearch, postgresReads } from "./backends.js";

const LIVE = process.env.READ_API_LIVE === "1";
test(
  "live PostgreSQL, Cassandra and Elasticsearch routes preserve tenant isolation",
  { skip: !LIVE },
  async () => {
    const adminUrl = new URL(process.env.POSTGRES_ADMIN_URL!);
    adminUrl.pathname = "/greenguard_read";
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const read = new pg.Pool({
      connectionString: process.env.READ_QUERY_DATABASE_URL!,
    });
    const cql = new cassandra.Client({
      contactPoints: (process.env.CASSANDRA_HOSTS ?? "127.0.0.1:59042").split(
        ",",
      ),
      localDataCenter: "datacenter1",
      keyspace: "greenguard_history",
    });
    const elastic = process.env.ELASTICSEARCH_URL ?? "http://127.0.0.1:19200";
    const alias = `read-api-live-${randomUUID().replaceAll("-", "")}`;
    const tenant = [randomUUID(), randomUUID()];
    const device = randomUUID(),
      site = randomUUID();
    const hotTime = new Date(Date.now() - 3600_000),
      coldTime = new Date(Date.now() - 48 * 3600_000);
    const hotReading = tenant.map(() => randomUUID()),
      coldReading = tenant.map(() => randomUUID());
    const index = `${alias}-v1`;
    const es = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${elastic}/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (!response.ok)
        throw new Error(
          `${method} ${path}: ${response.status} ${await response.text()}`,
        );
      return response.json();
    };
    let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
    try {
      for (let i = 0; i < 2; i++) {
        await admin.query(
          "INSERT INTO public.device_views(tenant_id,device_id,site_id,serial_number,status,inventory_version) VALUES($1,$2,$3,$4,'active',1)",
          [tenant[i], device, site, `read-api-live-${i}`],
        );
        await admin.query(
          "INSERT INTO public.reading_history(tenant_id,reading_id,device_id,event_id,stream_version,source_message_id,site_id,observed_at,received_at,temperature_c,inventory_enrichment) VALUES($1,$2,$3,$4,1,$5,$6,$7,$7,$8,'applied')",
          [
            tenant[i],
            hotReading[i],
            device,
            randomUUID(),
            `read-api-live-${i}`,
            site,
            hotTime,
            i + 10,
          ],
        );
        await cql.execute(
          "INSERT INTO readings_by_device_day (tenant_id,device_id,day,observed_at,reading_id,event_id,stream_version,received_at,site_id,temperature_c) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [
            tenant[i],
            device,
            coldTime.toISOString().slice(0, 10),
            coldTime,
            coldReading[i],
            randomUUID(),
            1,
            coldTime,
            site,
            i + 20,
          ],
          { prepare: true },
        );
      }
      await es(index, "PUT", {
        mappings: {
          properties: {
            tenant_id: { type: "keyword" },
            name: { type: "text" },
            resource_id: { type: "keyword" },
          },
        },
      });
      for (let i = 0; i < 2; i++)
        await es(`${index}/_doc/${i}`, "PUT", {
          tenant_id: tenant[i],
          name: "shared match",
          resource_id: device,
        });
      await es(`${index}/_refresh`, "POST");
      await es("_aliases", "POST", { actions: [{ add: { index, alias } }] });
      const history = new CassandraHistory(cql);
      const app = createApp({
        verify: async (auth) => ({
          subject: "live",
          tenantId: auth === "Bearer a" ? tenant[0] : tenant[1],
          roles: ["viewer"],
          expiresAt: new Date(Date.now() + 10000),
        }),
        backends: {
          ...postgresReads(read),
          history,
          search: new ElasticSearch(elastic, alias),
        },
      });
      server = app.listen(0);
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const get = async (path: string, token: string) => {
        const response = await fetch(origin + path, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status !== 200)
          throw new Error(
            `${path}: ${response.status} ${await response.text()}`,
          );
        return response.json() as Promise<{
          data: Array<Record<string, unknown>> | Record<string, unknown>;
          source?: string;
        }>;
      };
      for (let i = 0; i < 2; i++) {
        const token = i === 0 ? "a" : "b";
        const current = await get(`/api/v1/read/devices/${device}`, token);
        assert.equal(
          (current.data as Record<string, unknown>).tenant_id,
          tenant[i],
        );
        const batchResponse = await fetch(
          `${origin}/api/v1/read/devices/batch`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ deviceIds: [device, device] }),
          },
        );
        assert.equal(batchResponse.status, 200);
        const batch = (await batchResponse.json()) as {
          data: Array<Record<string, unknown>>;
        };
        assert.deepEqual(
          batch.data.map((row) => row.tenant_id),
          [tenant[i]],
        );
        const ownReading = await get(
          `/api/v1/read/readings/${hotReading[i]}`,
          token,
        );
        assert.equal(
          (ownReading.data as Record<string, unknown>).tenant_id,
          tenant[i],
        );
        const foreignReading = await get(
          `/api/v1/read/readings/${hotReading[1 - i]}`,
          token,
        );
        assert.equal(foreignReading.data, null);
        const hot = await get(
          `/api/v1/read/devices/${device}/readings?from=${encodeURIComponent(new Date(hotTime.getTime() - 60000).toISOString())}&to=${encodeURIComponent(new Date(hotTime.getTime() + 60000).toISOString())}`,
          token,
        );
        assert.equal(hot.source, "postgres");
        assert.deepEqual(
          (hot.data as Array<Record<string, unknown>>).map(
            (row) => row.reading_id,
          ),
          [hotReading[i]],
        );
        const cold = await get(
          `/api/v1/read/devices/${device}/readings?from=${encodeURIComponent(new Date(coldTime.getTime() - 60000).toISOString())}&to=${encodeURIComponent(new Date(coldTime.getTime() + 60000).toISOString())}`,
          token,
        );
        assert.equal(cold.source, "cassandra");
        assert.deepEqual(
          (cold.data as Array<Record<string, unknown>>).map(
            (row) => row.reading_id,
          ),
          [coldReading[i]],
        );
        const search = await get("/api/v1/read/search?q=shared", token);
        assert.equal(search.source, "elasticsearch");
        assert.deepEqual(
          (search.data as Array<Record<string, unknown>>).map(
            (row) => row.tenant_id,
          ),
          [tenant[i]],
        );
      }
    } finally {
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      await Promise.allSettled([
        es(index, "DELETE"),
        ...tenant.map((t, i) =>
          admin.query(
            "DELETE FROM public.reading_history WHERE tenant_id=$1 AND reading_id=$2",
            [t, hotReading[i]],
          ),
        ),
        ...tenant.map((t) =>
          admin.query(
            "DELETE FROM public.device_views WHERE tenant_id=$1 AND device_id=$2",
            [t, device],
          ),
        ),
      ]);
      await Promise.allSettled(
        tenant.map((t, i) =>
          cql.execute(
            "DELETE FROM readings_by_device_day WHERE tenant_id=? AND device_id=? AND day=? AND observed_at=? AND reading_id=?",
            [
              t,
              device,
              coldTime.toISOString().slice(0, 10),
              coldTime,
              coldReading[i],
            ],
            { prepare: true },
          ),
        ),
      );
      await Promise.all([admin.end(), read.end(), cql.shutdown()]);
    }
  },
);
