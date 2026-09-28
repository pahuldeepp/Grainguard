import assert from "node:assert/strict";
import { test } from "node:test";
import { controlClientLookup } from "./auth.js";

test("control lookup sends a signed-token tenant hint and fails closed on outage", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: url as URL, init: init! });
    return Response.json({
      tenant_id: "tenant-a",
      principal_id: "principal-a",
      scopes: ["inventory:import"],
    });
  };
  const lookup = controlClientLookup(
    "https://control.example",
    "t".repeat(32),
    fetcher,
  );
  assert.equal(await lookup("issuer", "client"), undefined);
  assert.equal(calls.length, 0);
  const result = await lookup("issuer", "client", "tenant-a");
  assert.equal(result?.tenant_id, "tenant-a");
  assert.equal(
    calls[0]?.url.pathname,
    "/v1/internal/credentials/oauth-client/lookup",
  );
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    issuer: "issuer",
    clientId: "client",
    tenantId: "tenant-a",
  });
  assert.equal(calls[0]!.init.redirect, "error");
  await assert.rejects(
    controlClientLookup("https://control.example", "t".repeat(32), async () => {
      throw new Error("down");
    })("issuer", "client", "tenant-a"),
    { status: 503, code: "auth_unavailable" },
  );
});

test("control lookup preserves a configured endpoint path prefix", async () => {
  let path = "";
  const lookup = controlClientLookup(
    "https://control.example/tenant-control",
    "t".repeat(32),
    async (url) => {
      path = (url as URL).pathname;
      return Response.json({
        tenant_id: "tenant-a",
        principal_id: "p",
        scopes: ["inventory:import"],
      });
    },
  );
  await lookup("issuer", "client", "tenant-a");
  assert.equal(
    path,
    "/tenant-control/v1/internal/credentials/oauth-client/lookup",
  );
});
