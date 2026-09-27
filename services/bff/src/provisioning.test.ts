import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import { ProvisioningClient, UpstreamError } from "./provisioning.js";

const principal = (roles: Principal["roles"]): Principal => ({
  subject: "user-1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  roles,
  expiresAt: new Date(Date.now() + 60_000),
});

test("forwards bearer and idempotency key without accepting a caller tenant", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const client = new ProvisioningClient(
    "http://127.0.0.1:8092",
    async (url, init) => {
      calls.push({ url: url as URL, init: init! });
      return Response.json({ SagaID: "saga" }, { status: 202 });
    },
  );
  await client.start(
    principal(["operator"]),
    "Bearer signed-token",
    "device",
    "asset",
    "key-1",
  );
  assert.equal(calls[0].url.pathname, "/v1/provisioning");
  assert.equal(
    new Headers(calls[0].init.headers).get("Authorization"),
    "Bearer signed-token",
  );
  assert.equal(
    new Headers(calls[0].init.headers).get("Idempotency-Key"),
    "key-1",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    device_id: "device",
    asset_id: "asset",
  });
});

test("enforces roles before any upstream request", async () => {
  let called = false;
  const client = new ProvisioningClient("http://127.0.0.1:8092", async () => {
    called = true;
    return Response.json({});
  });
  assert.throws(() =>
    client.start(principal(["viewer"]), "Bearer token", "d", "a", "k"),
  );
  assert.throws(() =>
    client.redrive(principal(["operator"]), "Bearer token", "s", "r"),
  );
  assert.equal(called, false);
});

test("preserves owner not-found for a foreign saga", async () => {
  const client = new ProvisioningClient("http://127.0.0.1:8092", async () =>
    Response.json({ code: "not_found" }, { status: 404 }),
  );
  await assert.rejects(
    client.status(principal(["viewer"]), "Bearer tenant-one", "foreign-saga"),
    (error) =>
      error instanceof UpstreamError &&
      error.status === 404 &&
      error.code === "not_found",
  );
});

test("rejects cleartext upstream except loopback", () => {
  assert.throws(() => new ProvisioningClient("http://saga:8092"));
});

test("forwards only a valid incoming traceparent to the saga API", async () => {
  const seen: (string | null)[] = [];
  const client = new ProvisioningClient(
    "http://127.0.0.1:8092",
    async (_url, init) => {
      seen.push(new Headers(init!.headers).get("traceparent"));
      return Response.json({ SagaID: "saga" }, { status: 202 });
    },
  );
  const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
  const start = (trace?: string) =>
    client.start(principal(["operator"]), "Bearer t", "d", "a", "k", trace);
  await start(valid);
  await start(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`);
  await start("garbage");
  await start();
  assert.deepEqual(seen, [valid, null, null, null]);
});

test("status and redrive forward only a valid traceparent", async () => {
  const seen: (string | null)[] = [];
  const client = new ProvisioningClient(
    "http://127.0.0.1:8092",
    async (_url, init) => {
      seen.push(new Headers(init!.headers).get("traceparent"));
      return Response.json({ saga: {}, history: [] });
    },
  );
  const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const admin = principal(["admin"]);
  await client.status(admin, "Bearer t", "s", valid);
  await client.status(admin, "Bearer t", "s", "garbage");
  await client.status(admin, "Bearer t", "s");
  await client.redrive(admin, "Bearer t", "s", "why", valid);
  await client.redrive(admin, "Bearer t", "s", "why", "garbage");
  await client.redrive(admin, "Bearer t", "s", "why");
  assert.deepEqual(seen, [valid, null, null, valid, null, null]);
});
