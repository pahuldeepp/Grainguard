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
