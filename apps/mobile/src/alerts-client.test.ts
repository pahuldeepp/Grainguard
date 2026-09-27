import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AlertsClient, operations } from "./alerts-client.js";
import { GraphqlError } from "./graphql.js";
import { defaultCrypto } from "./pkce.js";
import { IdentityChangedError } from "./session.js";
import type { AccessGrant } from "./session.js";
import { jsonResponse } from "./support.test.js";

const alertA = { alertId: "a1", state: "open", version: "3" };

function harness(initial: Partial<AccessGrant> = {}) {
  const grant = {
    accessToken: "tok-1",
    tenantId: "tenant-a",
    subject: "u1",
    ...initial,
  };
  const forced: boolean[] = [];
  const session = {
    getAccessToken: async (options?: { force?: boolean }) => {
      forced.push(Boolean(options?.force));
      if (options?.force) grant.accessToken = "tok-2";
      return { ...grant };
    },
  };
  const requests: { headers: Record<string, string>; body: string }[] = [];
  const queue: Response[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    requests.push({
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    });
    return queue.shift() ?? jsonResponse(200, { data: {} });
  }) as unknown as typeof fetch;
  const client = new AlertsClient("https://bff.example/graphql", session, {
    fetch: fetchFn,
    crypto: defaultCrypto(),
  });
  return { client, grant, forced, requests, queue };
}

test("operations match the BFF persisted-query allowlist text", () => {
  const source = readFileSync(
    resolve("../../services/bff/src/query-policy.ts"),
    "utf8",
  );
  for (const query of Object.values(operations))
    assert.ok(source.includes(query), query.slice(0, 40));
});

test("list sends persisted-query hash, bearer token and no tenant in the payload", async () => {
  const h = harness();
  h.queue.push(
    jsonResponse(200, {
      data: { alerts: { items: [alertA], nextCursor: null } },
    }),
  );
  const page = await h.client.list();
  assert.equal(page.items[0].alertId, "a1");
  const [request] = h.requests;
  assert.equal(request.headers.Authorization, "Bearer tok-1");
  assert.equal(request.body.includes("tenant-a"), false);
  assert.match(request.body, /"sha256Hash":"[0-9a-f]{64}"/);
  assert.equal(JSON.parse(request.body).query, undefined);
});

test("list results are cached per tenant and cleared on demand", async () => {
  const h = harness();
  h.queue.push(
    jsonResponse(200, {
      data: { alerts: { items: [alertA], nextCursor: null } },
    }),
  );
  await h.client.list();
  await h.client.list();
  assert.equal(h.requests.length, 1);
  h.grant.tenantId = "tenant-b";
  h.queue.push(
    jsonResponse(200, { data: { alerts: { items: [], nextCursor: null } } }),
  );
  const other = await h.client.list();
  assert.equal(other.items.length, 0);
  assert.equal(h.requests.length, 2);
  h.client.clearCache();
  h.grant.tenantId = "tenant-a";
  h.queue.push(
    jsonResponse(200, {
      data: { alerts: { items: [alertA], nextCursor: null } },
    }),
  );
  await h.client.list();
  assert.equal(h.requests.length, 3);
});

test("detail returns the alert", async () => {
  const h = harness();
  h.queue.push(jsonResponse(200, { data: { alert: alertA } }));
  assert.equal((await h.client.detail("a1"))?.version, "3");
});

test("acknowledge sends id, version and the caller's idempotency key", async () => {
  const h = harness();
  h.queue.push(
    jsonResponse(200, {
      data: {
        acknowledgeAlert: {
          episodeId: "e",
          state: "acknowledged",
          version: "4",
          eventId: "ev",
        },
      },
    }),
  );
  const result = await h.client.acknowledge("a1", "3", "key-1", {
    tenantId: "tenant-a",
    subject: "u1",
  });
  assert.equal(result.state, "acknowledged");
  assert.deepEqual(JSON.parse(h.requests[0].body).variables, {
    id: "a1",
    version: "3",
    idempotencyKey: "key-1",
  });
});

test("acknowledge refuses to send under a different tenant or user", async () => {
  const h = harness({ tenantId: "tenant-b" });
  await assert.rejects(
    h.client.acknowledge("a1", "3", "k", {
      tenantId: "tenant-a",
      subject: "u1",
    }),
    IdentityChangedError,
  );
  const other = harness({ subject: "u2" });
  await assert.rejects(
    other.client.acknowledge("a1", "3", "k", {
      tenantId: "tenant-a",
      subject: "u1",
    }),
    IdentityChangedError,
  );
  assert.equal(h.requests.length + other.requests.length, 0);
});

test("a 401 forces one token refresh and retries once", async () => {
  const h = harness();
  h.queue.push(jsonResponse(401, {}));
  h.queue.push(
    jsonResponse(200, { data: { alerts: { items: [], nextCursor: null } } }),
  );
  await h.client.list();
  // tenant lookup, first attempt, forced retry
  assert.deepEqual(h.forced, [false, false, true]);
  assert.equal(h.requests[1].headers.Authorization, "Bearer tok-2");
});

test("a second 401 is surfaced instead of looping", async () => {
  const h = harness();
  h.queue.push(jsonResponse(401, {}));
  h.queue.push(jsonResponse(401, {}));
  await assert.rejects(
    h.client.list(),
    (e: unknown) => e instanceof GraphqlError && e.status === 401,
  );
});

test("GraphQL errors carry the code and upstream status", async () => {
  const h = harness();
  h.queue.push(
    jsonResponse(200, {
      errors: [
        {
          message: "x",
          extensions: { code: "alert_conflict", httpStatus: 409 },
        },
      ],
    }),
  );
  await assert.rejects(
    h.client.detail("a1"),
    (e: unknown) =>
      e instanceof GraphqlError &&
      e.status === 409 &&
      e.code === "alert_conflict",
  );
});

test("network failure and empty data become transient status 0 errors", async () => {
  const h = harness();
  const failing = new AlertsClient(
    "https://bff.example/graphql",
    { getAccessToken: async () => ({ ...h.grant }) },
    {
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      crypto: defaultCrypto(),
    },
  );
  await assert.rejects(
    failing.list(),
    (e: unknown) => e instanceof GraphqlError && e.status === 0,
  );
  h.queue.push(jsonResponse(200, {}));
  await assert.rejects(h.client.list(), /no data/);
});
