/** Disposable PostgreSQL + real owner HTTP; synthetic signed humans and risk events. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { createTokenVerifier } from "@greenguard/tenant-auth";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import { createAlertsApp } from "../app.js";
import { handleRiskEvent } from "../consumer/handler.js";
import { newStream, riskEvent } from "../testing/fixtures.js";
import type { Db } from "../db/client.js";
const name = `greenguard-device-alerts-${randomUUID().slice(0, 8)}`;
const password = randomUUID(),
  incarnation = randomUUID();
const image =
  "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
let pool: pg.Pool | undefined,
  app: Awaited<ReturnType<typeof createAlertsApp>> | undefined;
try {
  docker(
    "run",
    "--pull=never",
    "-d",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=greenguard_alerts",
    "-p",
    "127.0.0.1::5432",
    image,
  );
  const port = docker("port", name, "5432/tcp").split(":").at(-1);
  let admin = new pg.Client({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/greenguard_alerts`,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.connect();
      break;
    } catch {
      await admin.end();
      admin = new pg.Client({
        connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/greenguard_alerts`,
      });
      if (attempt >= 30) throw new Error("disposable PostgreSQL unavailable");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await admin.query(
    "CREATE ROLE alerts_app LOGIN NOBYPASSRLS; CREATE ROLE cdc_reader; CREATE ROLE tenant_ownership_bootstrap",
  );
  await admin.query(
    "ALTER ROLE alerts_app PASSWORD $1".replace("$1", `'${password}'`),
  );
  const migrations = new URL("../../prisma/migrations/", import.meta.url);
  for (const version of readdirSync(migrations)
    .filter((x) => /^\d/.test(x))
    .sort())
    await admin.query(
      readFileSync(new URL(`${version}/migration.sql`, migrations), "utf8"),
    );
  const tenant = randomUUID(),
    foreign = randomUUID();
  for (const t of [tenant, foreign])
    await admin.query(
      "INSERT INTO greenguard_internal.tenant_ownership(tenant_id,shard_id,shard_incarnation,placement_epoch,state) VALUES($1,'s1',$2,1,'active')",
      [t, incarnation],
    );
  pool = new pg.Pool({
    connectionString: `postgresql://alerts_app:${password}@127.0.0.1:${port}/greenguard_alerts`,
  });
  const db = {
    $disconnect: async () => {},
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const conn = await pool!.connect();
      try {
        await conn.query("BEGIN");
        await conn.query(
          "SELECT set_config('app.shard_id','s1',true),set_config('app.shard_incarnation',$1,true),set_config('app.placement_epoch','1',true)",
          [incarnation],
        );
        const query = async (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) =>
          conn.query(
            strings.reduce(
              (sql, part, i) => sql + (i ? `$${i}` : "") + part,
              "",
            ),
            values,
          );
        const result = await work({
          $queryRaw: async (...args: Parameters<typeof query>) =>
            (await query(...args)).rows,
          $executeRaw: async (...args: Parameters<typeof query>) =>
            (await query(...args)).rowCount,
        });
        await conn.query("COMMIT");
        return result;
      } catch (error) {
        await conn.query("ROLLBACK");
        throw error;
      } finally {
        conn.release();
      }
    },
  } as unknown as Db;
  const stream = newStream(tenant),
    other = newStream(tenant),
    foreignStream = { ...newStream(foreign), deviceId: stream.deviceId };
  for (const s of [stream, other, foreignStream])
    assert.equal(
      (await handleRiskEvent(db, riskEvent(s, 75))).status,
      "applied",
    );
  const malformed = riskEvent(newStream(tenant), 75);
  malformed.payload.device_id = "invalid";
  assert.equal((await handleRiskEvent(db, malformed)).status, "invalid");
  const issuer = await createTestIssuer();
  const verifier = createTokenVerifier({
    issuer: issuer.issuer,
    audience: issuer.audience,
    keys: { getKey: issuer.getKey },
  });
  app = await createAlertsApp({
    db,
    actorHmacKey: randomUUID() + randomUUID(),
    historyCursorKey: randomUUID() + randomUUID(),
    verifier: {
      verify: async (auth) => ({
        ...(await verifier.verify(auth)),
        issuer: issuer.issuer,
      }),
    },
  });
  await app.listen(0, "127.0.0.1");
  const call = async (t: string, d: string) => {
    const token = await issuer.sign({
      tenant_id: t,
      roles: ["viewer"],
      sub: "synthetic-human",
    });
    const response = await fetch(
      `${await app!.getUrl()}/v1/alerts?deviceId=${d}&limit=20`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        items: { alertId: string }[];
        association: string;
      },
    };
  };
  const own = await call(tenant, stream.deviceId);
  assert.equal(own.status, 200);
  assert.equal(own.body.items.length, 1);
  assert.equal(own.body.association, "current_assessment_source_device");
  assert.equal((await call(tenant, other.deviceId)).body.items.length, 1);
  const foreignResult = await call(foreign, stream.deviceId);
  assert.equal(foreignResult.body.items.length, 1);
  assert.notEqual(
    foreignResult.body.items[0]!.alertId,
    own.body.items[0]!.alertId,
  );
  assert.equal((await call(tenant, randomUUID())).body.items.length, 0);
  assert.equal((await call(tenant, "invalid")).status, 400);
  // An arbitrary wrong-type receipt cannot associate another device to an episode.
  const badDevice = randomUUID();
  await admin.query(
    "SELECT set_config('app.tenant_id',$1,false),set_config('app.shard_id','s1',false),set_config('app.shard_incarnation',$2,false),set_config('app.placement_epoch','1',false)",
    [tenant, incarnation],
  );
  const assessment = (
    await admin.query(
      "SELECT current_assessment_id FROM alert_episodes WHERE tenant_id=$1 AND episode_id=$2",
      [tenant, own.body.items[0]!.alertId],
    )
  ).rows[0].current_assessment_id;
  await admin.query(
    "INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,event,effect,processed_at) VALUES('workflow-alerts.risk-assessed',$1,$2,$3::jsonb,'{}',clock_timestamp())",
    [
      tenant,
      randomUUID(),
      JSON.stringify({
        tenant_id: tenant,
        event_type: "risk.assessment_invalidated",
        payload: {
          device_id: badDevice,
          assessment_id: assessment,
        },
      }),
    ],
  );
  assert.equal((await call(tenant, badDevice)).body.items.length, 0);
  await admin.query(
    "INSERT INTO consumer_inbox(consumer_name,tenant_id,event_id,event,effect,processed_at) VALUES('workflow-alerts.risk-assessed',$1,$2,$3::jsonb,'{}',clock_timestamp())",
    [
      tenant,
      randomUUID(),
      JSON.stringify({
        tenant_id: foreign,
        event_type: "risk.assessed",
        payload: { device_id: badDevice, assessment_id: assessment },
      }),
    ],
  );
  assert.equal((await call(tenant, badDevice)).body.items.length, 0);
  await admin.end();
  console.log(
    "DEVICE_ALERTS_PASS: bounded owner HTTP, validated receipt association, two tenants sharing device ID isolated, unknown/invalid device and wrong-type receipt rejected; disposable PostgreSQL with all current migrations and runtime RLS role",
  );
} finally {
  if (app) await app.close();
  if (pool) await pool.end();
  docker("rm", "-f", name);
}
