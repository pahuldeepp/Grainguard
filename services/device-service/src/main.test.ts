import { test } from "node:test";
import assert from "node:assert/strict";
import type { INestApplication } from "@nestjs/common";
const load = (tag: string) =>
  import(new URL(`./main.js?${tag}`, import.meta.url).href) as Promise<{
    app: INestApplication;
  }>;
test("startup fails fast without a database URL", async () => {
  delete process.env.INVENTORY_DATABASE_URL;
  await assert.rejects(load("missing"), /INVENTORY_DATABASE_URL/);
});
test("startup listens and reports readiness against an unreachable database", async () => {
  process.env.INVENTORY_DATABASE_URL = "postgres://u:p@127.0.0.1:1/db";
  process.env.PORT = "0";
  const { app } = await load("started");
  try {
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  } finally {
    await app.close();
  }
});

test("startup mounts the authenticated API when AUTH_* is configured", async () => {
  process.env.INVENTORY_DATABASE_URL = "postgres://u:p@127.0.0.1:1/db";
  process.env.PORT = "0";
  process.env.AUTH_ISSUER = "https://issuer.test";
  process.env.AUTH_AUDIENCE = "greenguard-api";
  process.env.AUTH_JWKS_URL = "http://127.0.0.1:1/jwks";
  try {
    const { app } = await load("api");
    try {
      const base = await app.getUrl();
      const res = await fetch(`${base}/v1/devices`);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("api-version"), "1");
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
    } finally {
      await app.close();
    }
  } finally {
    delete process.env.AUTH_ISSUER;
    delete process.env.AUTH_AUDIENCE;
    delete process.env.AUTH_JWKS_URL;
  }
});
test("startup with an invalid version policy fails before listening", async () => {
  process.env.INVENTORY_DATABASE_URL = "postgres://u:p@127.0.0.1:1/db";
  process.env.AUTH_ISSUER = "https://issuer.test";
  process.env.AUTH_AUDIENCE = "greenguard-api";
  process.env.AUTH_JWKS_URL = "http://127.0.0.1:1/jwks";
  process.env.API_VERSION_POLICY = "{not json";
  try {
    await assert.rejects(load("badpolicy"));
  } finally {
    for (const key of [
      "AUTH_ISSUER",
      "AUTH_AUDIENCE",
      "AUTH_JWKS_URL",
      "API_VERSION_POLICY",
    ])
      delete process.env[key];
  }
});
