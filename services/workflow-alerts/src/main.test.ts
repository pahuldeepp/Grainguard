import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./main.js";
import { createAlertsApp } from "./app.js";
import type { Db } from "./db/client.js";

const env = {
  ALERTS_DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
  PORT: "0",
};

test("starts probes only without AUTH_* and reports not ready without a database", async () => {
  const app = await start(env);
  try {
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/v1/alerts`)).status, 404);
  } finally {
    await app.close();
  }
});

test("mounts the authenticated API and tracing when configured", async () => {
  const app = await start({
    ...env,
    AUTH_ISSUER: "https://issuer.test",
    AUTH_AUDIENCE: "greenguard-api",
    AUTH_JWKS_URL: "http://127.0.0.1:1/jwks",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
  });
  try {
    const res = await fetch(`${await app.getUrl()}/v1/alerts`);
    assert.equal(res.status, 401);
  } finally {
    await app.close();
  }
});

test("consumer crash removes readiness and shutdown closes consumer before database", async () => {
  const calls: string[] = [];
  const health = { ready: true };
  const db = {
    $queryRaw: async () => [{ one: 1 }],
    $disconnect: async () => {
      calls.push("database");
    },
  } as unknown as Db;
  const app = await createAlertsApp({
    db,
    consumerHealth: health,
    stopConsumer: {
      close: async () => {
        calls.push("consumer");
      },
    },
  });
  await app.listen(0, "127.0.0.1");
  const base = await app.getUrl();
  try {
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    health.ready = false;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  } finally {
    await app.close();
  }
  assert.deepEqual(calls, ["consumer", "database"]);
});
