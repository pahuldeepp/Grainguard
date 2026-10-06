import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { ReadCache } from "../services/read-api/dist/cache.js";
import { createReadRedis } from "../services/read-api/dist/redis.js";

const { Pool } = pg;
const required = [
  "PROJECTION_DATABASE_URL",
  "READ_QUERY_DATABASE_URL",
  "KAFKA_BROKERS",
];
for (const key of required)
  if (!process.env[key]) throw new Error(`${key} required`);
const redis = createReadRedis(process.env);
if (!redis) throw new Error("Redis cache configuration required");
const app = new Pool({ connectionString: process.env.PROJECTION_DATABASE_URL });
const read = new Pool({
  connectionString: process.env.READ_QUERY_DATABASE_URL,
});
const tenant = randomUUID(),
  device = randomUUID(),
  site = randomUUID(),
  event = randomUUID();
const traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;

async function scoped(pool, fn, scopeTenant = tenant) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [
      scopeTenant,
    ]);
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function runGo(service, test, extra = {}) {
  const result = spawnSync(
    "go",
    ["test", "./...", "-run", test, "-count=1", "-v"],
    {
      cwd: new URL(`../services/${service}/`, import.meta.url),
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...extra },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `${service} live test failed: ${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

try {
  await redis.connect();
  await scoped(app, (db) =>
    db.query(
      `INSERT INTO device_views
    (tenant_id,device_id,site_id,serial_number,status,inventory_version)
    VALUES ($1,$2,$3,$4,'registered',1)`,
      [tenant, device, site, `cache-e2e-${device}`],
    ),
  );
  const cache = new ReadCache(redis, {
    ttlMs: 15_000,
    epochRefreshMs: 0,
    random: () => 0,
  });
  let loads = 0;
  const origin = () =>
    scoped(read, async (db) => {
      loads++;
      const { rows } = await db.query(
        "SELECT status FROM read.device_views WHERE tenant_id=$1 AND device_id=$2",
        [tenant, device],
      );
      assert.equal(rows.length, 1);
      return rows[0].status;
    });
  const first = await cache.get(tenant, "device-status", [device], origin);
  assert.equal(first, "registered");

  await scoped(app, async (db) => {
    await db.query(
      "UPDATE device_views SET status='active',inventory_version=2 WHERE tenant_id=$1 AND device_id=$2",
      [tenant, device],
    );
    await db.query(
      `INSERT INTO consumer_inbox
      (consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event)
      VALUES ('projection-builder',$1,$2,'cache-e2e',0,1,$3::jsonb)`,
      [
        tenant,
        event,
        JSON.stringify({
          event_type: "device.status_changed",
          aggregate_version: "2",
          correlation_id: event,
          traceparent,
        }),
      ],
    );
    await db.query(
      `INSERT INTO projection_notifications
      (tenant_id,notification_id,resource_type,resource_id,event_id,purpose)
      VALUES ($1,$2,'device',$3,$2,'projection_changed')`,
      [tenant, event, device],
    );
  });

  // Before the CDC consumer invalidates, the old cached answer is still served.
  assert.equal(
    await cache.get(tenant, "device-status", [device], origin),
    "registered",
  );
  assert.match(
    runGo("cdc-transformer", "TestLiveTransformProjectionNotification", {
      PROJECTION_NOTIFICATION_LIVE: "1",
      PROJECTION_NOTIFICATION_EVENT_ID: event,
    }),
    /PASS/,
  );
  assert.match(
    runGo("cache-invalidator", "TestLiveConsumeProjectionNotification", {
      CACHE_PROJECTION_LIVE: "1",
      CACHE_PROJECTION_EVENT_ID: event,
    }),
    /PASS/,
  );
  assert.equal(
    await cache.get(tenant, "device-status", [device], origin),
    "active",
  );
  assert.equal(loads, 2);

  // A promotion changes all tenants' read origin; one infrastructure-tenant
  // notification bumps the global epoch. The actual view swap and emission are
  // proven atomic in the disposable promotion test.
  await scoped(app, (db) =>
    db.query(
      "UPDATE device_views SET status='maintenance',inventory_version=3 WHERE tenant_id=$1 AND device_id=$2",
      [tenant, device],
    ),
  );
  assert.equal(
    await cache.get(tenant, "device-status", [device], origin),
    "active",
  );
  const promotionEvent = randomUUID();
  const infrastructureTenant = "00000000-0000-4000-8000-000000000001";
  await scoped(
    app,
    async (db) => {
      await db.query(
        `INSERT INTO consumer_inbox
      (consumer_name,tenant_id,event_id,source_topic,source_partition,source_offset,event)
      VALUES ('promotion',$1,$2,'cache-e2e-promotion',0,0,$3::jsonb)`,
        [
          infrastructureTenant,
          promotionEvent,
          JSON.stringify({
            event_type: "projection.promoted",
            aggregate_version: "1",
            correlation_id: promotionEvent,
            traceparent,
          }),
        ],
      );
      await db.query(
        `INSERT INTO projection_notifications
      (tenant_id,notification_id,resource_type,resource_id,event_id,purpose,consumer_name)
      VALUES ($1,$2,'device',$1,$2,'promotion_changed','promotion')`,
        [infrastructureTenant, promotionEvent],
      );
    },
    infrastructureTenant,
  );
  assert.match(
    runGo("cdc-transformer", "TestLiveTransformProjectionNotification", {
      PROJECTION_NOTIFICATION_LIVE: "1",
      PROJECTION_NOTIFICATION_EVENT_ID: promotionEvent,
    }),
    /PASS/,
  );
  assert.match(
    runGo("cache-invalidator", "TestLiveConsumeProjectionNotification", {
      CACHE_PROJECTION_LIVE: "1",
      CACHE_PROJECTION_EVENT_ID: promotionEvent,
    }),
    /PASS/,
  );
  assert.equal(
    await cache.get(tenant, "device-status", [device], origin),
    "maintenance",
  );
  assert.equal(loads, 3);
  console.log(
    JSON.stringify({
      tenant,
      event,
      promotionEvent,
      originLoads: loads,
      result: "maintenance",
      path: "projection-commit>CDC>transformer>invalidator>ReadCache",
    }),
  );
} finally {
  await redis.close().catch(() => {});
  await Promise.all([app.end(), read.end()]);
}
