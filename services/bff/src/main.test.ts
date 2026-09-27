import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import { AuthError } from "@greenguard/tenant-auth";
import { createApp } from "./main.js";
import { ProvisioningClient } from "./provisioning.js";
import { operationHash, operations } from "./query-policy.js";
import { createTestIssuer } from "@greenguard/tenant-auth/testing";
import {
  createMembershipCache,
  createMembershipVerifier,
  membershipChangedHandler,
  identityKey,
} from "@greenguard/membership-client";

test("a still-valid JWT loses BFF access after membership.changed", async () => {
  const issuer = await createTestIssuer();
  const tenantId = "11111111-1111-4111-8111-111111111111";
  let version = "1";
  let state: "active" | "revoked" = "active";
  const cache = createMembershipCache({
    fetch: async () =>
      state === "active"
        ? { tenantId, roles: ["viewer"], version, state }
        : { tenantId, roles: [], version, state },
  });
  const verifier = createMembershipVerifier(
    {
      issuer: issuer.issuer,
      audience: issuer.audience,
      keys: { getKey: issuer.getKey },
    },
    cache,
  );
  const bearer = `Bearer ${await issuer.sign({ sub: "alice", tenant_id: "22222222-2222-4222-8222-222222222222", roles: ["admin"] })}`;
  const { app, server } = await createApp({
    verify: verifier.verify,
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const call = () =>
      fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: "POST",
        headers: { Authorization: bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
    assert.equal((await call()).status, 400);
    state = "revoked";
    version = "2";
    await membershipChangedHandler(cache)({
      event_type: "membership.changed",
      tenant_id: tenantId,
      payload: {
        identity_id: identityKey(issuer.issuer, "alice"),
        membership_version: "2",
      },
    });
    const denied = await call();
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, "insufficient_role");
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});

test("HTTP GraphQL verifies the bearer before executing a tenant-scoped query", async () => {
  const headers: string[] = [];
  const principal: Principal = {
    subject: "u1",
    tenantId: "11111111-1111-4111-8111-111111111111",
    roles: ["viewer"],
    expiresAt: new Date(Date.now() + 60_000),
  };
  const provisioning = new ProvisioningClient(
    "http://127.0.0.1:8092",
    async (_url, init) => {
      headers.push(new Headers(init?.headers).get("Authorization") ?? "");
      return Response.json({
        saga: {
          TenantID: principal.tenantId,
          SagaID: "s1",
          DeviceID: "d1",
          AssetID: "a1",
          State: "active",
          Version: 2,
          FencingToken: 1,
          DeadlineAt: "2026-09-25T00:00:00Z",
        },
        history: [],
      });
    },
  );
  const { app, server } = await createApp({
    verify: async (header) => {
      if (header !== "Bearer tenant-one")
        throw new AuthError(401, "invalid_token");
      return principal;
    },
    provisioning,
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extensions: {
          persistedQuery: {
            sha256Hash: operationHash(operations.provisioningStatus),
          },
        },
        variables: { id: "s1" },
      }),
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(headers, []);
    const adHoc = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tenant-one",
      },
      body: JSON.stringify({
        query: '{ provisioningStatus(id: "s1") { saga { state } } }',
      }),
    });
    assert.equal(adHoc.status, 400);
    assert.equal((await adHoc.json()).code, "persisted_operation_required");
    assert.deepEqual(headers, []);
    const authorized = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tenant-one",
      },
      body: JSON.stringify({
        extensions: {
          persistedQuery: {
            sha256Hash: operationHash(operations.provisioningStatus),
          },
        },
        variables: { id: "s1" },
      }),
    });
    assert.equal(
      authorized.status,
      200,
      JSON.stringify(await authorized.clone().json()),
    );
    assert.equal(
      (await authorized.json()).data.provisioningStatus.saga.state,
      "active",
    );
    assert.deepEqual(headers, ["Bearer tenant-one"]);
    assert.equal((await fetch(`${base}/healthz`)).status, 204);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});

test("HTTP GraphQL carries a valid caller trace into the saga start request", async () => {
  const trace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00";
  const seen: (string | null)[] = [];
  const principal: Principal = {
    subject: "u1",
    tenantId: "11111111-1111-4111-8111-111111111111",
    roles: ["operator"],
    expiresAt: new Date(Date.now() + 60_000),
  };
  const provisioning = new ProvisioningClient(
    "http://127.0.0.1:8092",
    async (_url, init) => {
      seen.push(new Headers(init?.headers).get("traceparent"));
      return Response.json(
        {
          TenantID: principal.tenantId,
          SagaID: "s1",
          DeviceID: "d1",
          AssetID: "a1",
          State: "reserving",
          Version: 1,
          FencingToken: 1,
          DeadlineAt: "2026-09-25T00:00:00Z",
        },
        { status: 202 },
      );
    },
  );
  const { app, server } = await createApp({
    verify: async () => principal,
    provisioning,
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    const start = (traceparent: string) =>
      fetch(`${base}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tenant-one",
          traceparent,
        },
        body: JSON.stringify({
          extensions: {
            persistedQuery: {
              sha256Hash: operationHash(operations.startProvisioning),
            },
          },
          variables: { deviceId: "d1", assetId: "a1", idempotencyKey: "key" },
        }),
      });
    assert.equal((await start(trace)).status, 200);
    assert.equal((await start("invalid-trace")).status, 200);
    assert.deepEqual(seen, [trace, null]);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});

test("readiness is separate from liveness and a stalled rate check is bounded", async () => {
  const principal: Principal = {
    subject: "u1",
    tenantId: "11111111-1111-4111-8111-111111111111",
    roles: ["viewer"],
    expiresAt: new Date(Date.now() + 60_000),
  };
  const { app, server } = await createApp({
    verify: async () => principal,
    provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
    rateLimiter: { check: () => new Promise(() => undefined) },
    rateCheckTimeoutMs: 20,
    ready: () => false,
  });
  const listener = app.listen(0);
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 204);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    const response = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
      },
      body: JSON.stringify({
        extensions: {
          persistedQuery: { sha256Hash: operationHash(operations.session) },
        },
      }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "rate_limit_unavailable");
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await server.stop();
  }
});
