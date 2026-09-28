import assert from "node:assert/strict";
import { test } from "node:test";
import { start } from "./main.js";
import { env } from "./testing/fixtures.js";

test("start serves probes and the lookup from environment configuration", async () => {
  const app = await start({
    CONTROL_DATABASE_URL: env("CONTROL_DATABASE_URL"),
    CONTROL_LOOKUP_TOKEN: "lookup-token-with-at-least-32-bytes!",
    PORT: "0",
    AUTH_ISSUER: "https://issuer.test",
    AUTH_AUDIENCE: "greenguard-api",
    AUTH_JWKS_URL: "http://127.0.0.1:1/keys",
  });
  try {
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    const denied = await fetch(
      `${base}/v1/internal/memberships?issuer=i&subject=s`,
    );
    assert.equal(denied.status, 401);
    assert.equal(
      denied.headers.get("content-type"),
      "application/problem+json",
    );
    const unavailable = await fetch(`${base}/v1/organizations/x/members`, {
      headers: { authorization: "Bearer a.b.c" },
    });
    assert.equal(unavailable.status, 401);
  } finally {
    await app.close();
  }
});
