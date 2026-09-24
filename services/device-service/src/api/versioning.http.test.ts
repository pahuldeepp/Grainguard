import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTenant } from "../inventory/repository.js";
import { startApi } from "../testing/api.js";
import type { VersionRegistry } from "./versioning/index.js";

const registry: VersionRegistry = {
  defaultVersion: "2",
  versions: [
    {
      version: "1",
      deprecatedAt: new Date("2026-01-01T00:00:00Z"),
      sunsetAt: new Date("2026-12-31T23:59:59Z"),
      successor: "2",
      documentationUrl: "https://docs.example/migrate-v2",
    },
    { version: "2" },
  ],
};

async function withApi(
  now: string,
  run: (api: Awaited<ReturnType<typeof startApi>>) => Promise<void>,
) {
  const api = await startApi({ versions: registry, now: () => new Date(now) });
  try {
    await run(api);
  } finally {
    await api.close();
  }
}

test("header versioning: default version is echoed and a deprecated version announces its sunset", async () => {
  await withApi("2026-06-01T00:00:00Z", async (api) => {
    const tenantId = randomUUID();
    await createTenant(api.db, tenantId, "versions");
    const token = await api.token(tenantId, ["viewer"]);
    const current = await api.call("GET", "/v1/devices", { token });
    assert.equal(current.status, 200);
    assert.equal(current.headers.get("api-version"), "2");
    assert.equal(current.headers.get("deprecation"), null);
    assert.equal(current.headers.get("sunset"), null);
    assert.match(current.headers.get("vary") ?? "", /API-Version/i);
    const old = await api.call("GET", "/v1/devices", {
      token,
      headers: { "api-version": "1" },
    });
    assert.equal(old.status, 200);
    assert.equal(old.headers.get("api-version"), "1");
    assert.equal(
      old.headers.get("deprecation"),
      `@${Date.parse("2026-01-01T00:00:00Z") / 1000}`,
    );
    assert.equal(old.headers.get("sunset"), "Thu, 31 Dec 2026 23:59:59 GMT");
    assert.match(
      old.headers.get("link") ?? "",
      /<urn:api-version:2>; rel="successor-version"/,
    );
    assert.match(
      old.headers.get("link") ?? "",
      /<https:\/\/docs.example\/migrate-v2>; rel="deprecation"/,
    );
    const unsupported = await api.call("GET", "/v1/devices", {
      token,
      headers: { "api-version": "9" },
    });
    assert.equal(unsupported.status, 400);
    assert.deepEqual(unsupported.json?.supported, ["1", "2"]);
    assert.equal(unsupported.json?.code, "unsupported_api_version");
    assert.equal(
      unsupported.json?.correlation_id,
      unsupported.headers.get("x-correlation-id"),
    );
  });
});

test("header versioning: after the sunset instant the old version is 410 Gone, before authentication", async () => {
  await withApi("2027-01-01T00:00:00Z", async (api) => {
    const gone = await api.call("GET", "/v1/devices", {
      token: null,
      headers: { "api-version": "1" },
    });
    assert.equal(gone.status, 410);
    assert.equal(gone.json?.code, "api_version_sunset");
    assert.equal(
      gone.json?.correlation_id,
      gone.headers.get("x-correlation-id"),
    );
    assert.equal(gone.headers.get("sunset"), "Thu, 31 Dec 2026 23:59:59 GMT");
    assert.equal(gone.headers.get("content-type"), "application/problem+json");
    const current = await api.call("GET", "/v1/devices", { token: null });
    assert.equal(current.status, 401);
    const unsupported = await api.call("GET", "/v1/devices", {
      token: null,
      headers: { "api-version": "1x" },
    });
    assert.deepEqual(unsupported.json?.supported, ["2"]);
  });
});
