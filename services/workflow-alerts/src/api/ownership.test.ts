import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAlertsApp } from "../app.js";
import { handleRiskEvent } from "../consumer/handler.js";
import {
  pooledDb,
  newStream,
  riskEvent,
  outboxFor,
  adminQuery,
  adminTenantQuery,
} from "../testing/fixtures.js";

test("owning authorization uses live membership and real RLS PostgreSQL without mutation", async () => {
  const tenantId = randomUUID(),
    userId = randomUUID();
  let state = "operator",
    calls = 0;
  const token = "lookup-only-service-credential-00000001";
  const membership = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const query = new URL(req.url!, "http://localhost").searchParams;
    assert.equal(query.get("identityId"), userId);
    if (state === "outage") {
      res.writeHead(503).end();
      return;
    }
    if (state === "revoked") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        tenantId: query.get("tenantId"),
        identityId: userId,
        state: "active",
        roles: [state],
        version: 1,
      }),
    );
  });
  let app: Awaited<ReturnType<typeof createAlertsApp>> | undefined;
  let db: ReturnType<typeof pooledDb> | undefined;
  try {
    await new Promise<void>((resolve) =>
      membership.listen(0, "127.0.0.1", resolve),
    );
    db = pooledDb();
    app = await createAlertsApp({
      db,
      ownership: {
        serviceToken: token,
        membershipToken: token,
        membershipUrl: `http://127.0.0.1:${(membership.address() as { port: number }).port}`,
      },
    });
    await app.listen(0, "127.0.0.1");
    const result = await handleRiskEvent(
      db,
      riskEvent(newStream(tenantId), 75),
    );
    const alertId = (result as { effect: { episodeId: string } }).effect
      .episodeId;
    const selectors = { tenantId, userId, alertId, etag: '"1"' };
    const call = async (
      values: Record<string, string> = selectors,
      auth = token,
    ) =>
      fetch(
        (await app!.getUrl()) +
          "/v1/internal/alert-authorization?" +
          new URLSearchParams(values),
        { headers: { authorization: `Bearer ${auth}` } },
      );
    const before = await outboxFor(tenantId);
    const episodeBefore = await adminQuery(
      "SELECT row_to_json(e) AS episode FROM alert_episodes e WHERE tenant_id=$1 AND episode_id=$2",
      [tenantId, alertId],
    );
    const transitionsBefore = await adminQuery(
      "SELECT row_to_json(t) AS transition FROM alert_transitions t WHERE tenant_id=$1 ORDER BY transition_id",
      [tenantId],
    );
    const response = await call();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authorized: true, ...selectors });
    const count = calls;
    assert.equal((await call(selectors, "wrong")).status, 401);
    assert.equal(calls, count);
    assert.equal(
      (await call({ ...selectors, tenantId: randomUUID() })).status,
      404,
    );
    assert.equal(
      (await call({ ...selectors, alertId: randomUUID() })).status,
      404,
    );
    assert.equal((await call({ ...selectors, etag: '"2"' })).status, 404);
    assert.equal((await call({ ...selectors, extra: "ignored" })).status, 400);
    state = "viewer";
    assert.equal((await call()).status, 403);
    state = "revoked";
    assert.equal((await call()).status, 403);
    state = "outage";
    assert.equal((await call()).status, 503);
    state = "admin";
    assert.equal((await call()).status, 200);
    assert.deepEqual(
      await adminQuery(
        "SELECT row_to_json(e) AS episode FROM alert_episodes e WHERE tenant_id=$1 AND episode_id=$2",
        [tenantId, alertId],
      ),
      episodeBefore,
    );
    assert.deepEqual(
      await adminQuery(
        "SELECT row_to_json(t) AS transition FROM alert_transitions t WHERE tenant_id=$1 ORDER BY transition_id",
        [tenantId],
      ),
      transitionsBefore,
    );
    await adminTenantQuery(
      tenantId,
      "UPDATE alert_episodes SET state='acknowledged' WHERE tenant_id=$1 AND episode_id=$2",
      [tenantId, alertId],
    );
    assert.equal((await call()).status, 404);
    assert.deepEqual(await outboxFor(tenantId), before);
  } finally {
    if (app) await app.close();
    else if (db) await db.$disconnect();
    await new Promise<void>((resolve) => membership.close(() => resolve()));
  }
});
