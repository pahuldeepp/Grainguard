import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@greenguard/tenant-auth";
import { AlertClient } from "./alerts.js";
import { createApolloServer } from "./schema.js";
import { ProvisioningClient } from "./provisioning.js";
import { NotificationClient } from "./notifications.js";

const alertId = "11111111-1111-4111-8111-111111111111";
const principal: Principal = {
  subject: "alice",
  tenantId: "22222222-2222-4222-8222-222222222222",
  roles: ["operator"],
  expiresAt: new Date(Date.now() + 60_000),
};
const item = {
  alertId,
  ruleId: "rule",
  binId: "bin",
  state: "open",
  severity: "high",
  score: 82,
  version: "7",
  openWindowStart: "2026-09-25T00:00:00Z",
  openedAt: "2026-09-25T00:00:00Z",
  acknowledgedAt: null,
  acknowledgedBy: null,
  resolvedAt: null,
  escalationLevel: 0,
};

test("alert list and acknowledgement forward bearer, cursor and concurrency headers without tenant override", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new AlertClient(
    "http://127.0.0.1:3100",
    async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Response.json(
        calls.length === 1
          ? { items: [item], nextCursor: alertId }
          : {
              episodeId: alertId,
              state: "acknowledged",
              version: "8",
              eventId: "event-1",
            },
      );
    },
  );
  const page = await client.list(
    principal,
    "Bearer valid",
    20,
    alertId,
    "open",
  );
  assert.equal(page.nextCursor, alertId);
  assert.match(
    calls[0].url,
    /limit=20&after=11111111-1111-4111-8111-111111111111&state=open/,
  );
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    "Bearer valid",
  );
  assert.ok(!calls[0].url.includes(principal.tenantId));
  const ack = await client.acknowledge(
    principal,
    "Bearer valid",
    alertId,
    "7",
    "command-1",
  );
  assert.equal(ack.state, "acknowledged");
  assert.equal(
    (calls[1].init.headers as Record<string, string>)["If-Match"],
    '"7"',
  );
  assert.equal(
    (calls[1].init.headers as Record<string, string>)["Idempotency-Key"],
    "command-1",
  );
});

test("GraphQL acknowledge accepts the owner command receipt after commit", async () => {
  const client = new AlertClient("http://127.0.0.1:3100", async () =>
    Response.json({
      episodeId: alertId,
      state: "acknowledged",
      version: "8",
      eventId: "33333333-3333-4333-8333-333333333333",
    }),
  );
  const server = createApolloServer();
  const result = await server.executeOperation(
    {
      query:
        'mutation { acknowledgeAlert(id: "11111111-1111-4111-8111-111111111111", version: "7", idempotencyKey: "command-1") { episodeId state version eventId } }',
    },
    {
      contextValue: {
        principal,
        authorization: "Bearer valid",
        alerts: client,
        provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
      },
    },
  );
  assert.equal(result.body.kind, "single");
  if (result.body.kind === "single") {
    assert.equal(result.body.singleResult.errors, undefined);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(result.body.singleResult.data?.acknowledgeAlert),
      ),
      {
        episodeId: alertId,
        state: "acknowledged",
        version: "8",
        eventId: "33333333-3333-4333-8333-333333333333",
      },
    );
  }
  await server.stop();
});

test("viewer cannot acknowledge and invalid cursors never reach the owner", async () => {
  let called = false;
  const client = new AlertClient("http://127.0.0.1:3100", async () => {
    called = true;
    return Response.json({ items: [], nextCursor: null });
  });
  const viewer = { ...principal, roles: ["viewer"] as Principal["roles"] };
  assert.throws(() =>
    client.acknowledge(viewer, "Bearer valid", alertId, "7", "key"),
  );
  assert.throws(
    () => client.list(viewer, "Bearer valid", 10, "foreign-cursor"),
    /invalid_alert_page/,
  );
  assert.equal(called, false);
});

test("alert transition history forwards only the owner cursor and rejects malformed cursors", async () => {
  let call: { url: string; headers: Headers } | undefined;
  const client = new AlertClient(
    "http://127.0.0.1:3100",
    async (input, init) => {
      call = { url: String(input), headers: new Headers(init?.headers) };
      return Response.json({
        alertId,
        items: [],
        nextCursor: null,
        complete: true,
        source: { status: "ok", reasonCode: null },
      });
    },
  );
  const page = await client.history(
    principal,
    "Bearer valid",
    alertId,
    20,
    "opaque.cursor-1",
  );
  assert.equal(page.complete, true);
  assert.match(
    call?.url ?? "",
    /\/v1\/alerts\/.*\/transitions\?limit=20&after=opaque.cursor-1/,
  );
  assert.equal(call?.headers.get("authorization"), "Bearer valid");
  assert.ok(!call?.url.includes(principal.tenantId));
  assert.throws(
    () => client.history(principal, "Bearer valid", alertId, 20, "bad cursor"),
    /invalid_alert_history/,
  );
});

test("alert notifications enforce operator role and verify alert ownership before notification owners", async () => {
  let notificationCalls = 0;
  const alerts = new AlertClient("http://127.0.0.1:3100", async () =>
    Response.json({ code: "not_found" }, { status: 404 }),
  );
  const notifications = new NotificationClient(
    "http://127.0.0.1:3200",
    "http://127.0.0.1:3201",
    async () => {
      notificationCalls++;
      return Response.json({ items: [] });
    },
  );
  const server = createApolloServer();
  const query = `query { alertNotifications(id: "${alertId}", limit: 20) { complete } }`;
  const viewer = await server.executeOperation(
    { query },
    {
      contextValue: {
        principal: { ...principal, roles: ["viewer"] },
        authorization: "Bearer valid",
        alerts,
        notifications,
        provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
      },
    },
  );
  assert.equal(viewer.body.kind, "single");
  if (viewer.body.kind === "single")
    assert.equal(
      viewer.body.singleResult.errors?.[0]?.extensions?.code,
      "insufficient_role",
    );
  const foreign = await server.executeOperation(
    { query },
    {
      contextValue: {
        principal,
        authorization: "Bearer valid",
        alerts,
        notifications,
        provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
      },
    },
  );
  assert.equal(foreign.body.kind, "single");
  if (foreign.body.kind === "single")
    assert.equal(
      foreign.body.singleResult.errors?.[0]?.extensions?.httpStatus,
      404,
    );
  assert.equal(notificationCalls, 0);
  await server.stop();
});

test("GraphQL alert page maps owner data and carries an opaque cursor", async () => {
  const client = new AlertClient("http://127.0.0.1:3100", async () =>
    Response.json({ items: [item], nextCursor: alertId }),
  );
  const server = createApolloServer();
  const result = await server.executeOperation(
    {
      query:
        "query { alerts(limit: 10) { items { alertId score version } nextCursor } }",
    },
    {
      contextValue: {
        principal,
        authorization: "Bearer valid",
        alerts: client,
        provisioning: new ProvisioningClient("http://127.0.0.1:8092"),
      },
    },
  );
  assert.equal(result.body.kind, "single");
  if (result.body.kind === "single") {
    assert.equal(result.body.singleResult.errors, undefined);
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.body.singleResult.data?.alerts)),
      {
        items: [{ alertId, score: 82, version: "7" }],
        nextCursor: alertId,
      },
    );
  }
  await server.stop();
});
