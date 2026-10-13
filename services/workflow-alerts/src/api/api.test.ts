import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { handleRiskEvent } from "../consumer/handler.js";
import { startApi } from "../testing/api.js";
import {
  appQuery,
  asTenant,
  newStream,
  outboxFor,
  riskEvent,
} from "../testing/fixtures.js";

type Api = Awaited<ReturnType<typeof startApi>>;
let api: Api;
before(async () => {
  api = await startApi();
});
after(() => api.close());

async function openAlert(tenantId = randomUUID()) {
  const s = newStream(tenantId);
  const r = await handleRiskEvent(api.db, riskEvent(s, 75));
  return {
    tenantId,
    id: (r as { effect: { episodeId: string } }).effect.episodeId,
  };
}

const ack = (id: string, token: string, headers: Record<string, string>) =>
  api.call("POST", `/v1/alerts/${id}/acknowledge`, token, headers);

describe("alerts HTTP API", () => {
  test("read, acknowledge with Idempotency-Key and If-Match, replay the same answer", async () => {
    const a = await openAlert();
    const operator = await api.token(a.tenantId, ["operator"], "op-7");
    const got = await api.call("GET", `/v1/alerts/${a.id}`, operator);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("etag"), '"1"');
    assert.equal(got.json["state"], "open");
    const headers = { "idempotency-key": "ack-1", "if-match": '"1"' };
    const first = await ack(a.id, operator, headers);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("etag"), '"2"');
    const replay = await ack(a.id, operator, headers);
    assert.deepEqual(replay.json, first.json);
    const fresh = await ack(a.id, operator, {
      "idempotency-key": "ack-2",
      "if-match": '"2"',
    });
    assert.equal(fresh.status, 409);
    assert.equal(fresh.json["code"], "invalid_state");
    const events = (await outboxFor(a.tenantId)).map((r) => r["event_type"]);
    assert.deepEqual(events, ["alert.opened", "alert.acknowledged"]);
    const [row] = (await outboxFor(a.tenantId)).slice(-1);
    assert.equal(
      (row["payload"] as Record<string, unknown>)["acknowledged_by"],
      "op-7",
    );
  });

  test("preconditions: 428 without If-Match, 412 with a stale one, 400 without a key", async () => {
    const a = await openAlert();
    const operator = await api.token(a.tenantId, ["admin"]);
    const missing = await ack(a.id, operator, { "idempotency-key": "k" });
    assert.equal(missing.status, 428);
    assert.equal(
      missing.headers.get("content-type"),
      "application/problem+json",
    );
    const stale = await ack(a.id, operator, {
      "idempotency-key": "k",
      "if-match": '"9"',
    });
    assert.equal(stale.status, 412);
    assert.equal(stale.headers.get("etag"), '"1"');
    const nokey = await ack(a.id, operator, { "if-match": '"1"' });
    assert.equal(nokey.status, 400);
    const badMatch = await ack(a.id, operator, {
      "idempotency-key": "k",
      "if-match": "1",
    });
    assert.equal(badMatch.status, 400);
  });

  test("roles: viewer reads but cannot acknowledge; no token is 401", async () => {
    const a = await openAlert();
    const viewer = await api.token(a.tenantId, ["viewer"]);
    assert.equal((await api.call("GET", "/v1/alerts", viewer)).status, 200);
    const denied = await ack(a.id, viewer, {
      "idempotency-key": "v",
      "if-match": '"1"',
    });
    assert.equal(denied.status, 403);
    const device = await api.token(a.tenantId, ["device"]);
    assert.equal((await api.call("GET", "/v1/alerts", device)).status, 403);
    const anonymous = await api.call("GET", "/v1/alerts");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
  });

  test("tenant B cannot list, read or acknowledge tenant A's alert", async () => {
    const a = await openAlert();
    const b = await openAlert();
    const tokenB = await api.token(b.tenantId, ["admin"]);
    const list = await api.call("GET", "/v1/alerts?limit=200", tokenB);
    const ids = (list.json["items"] as { alertId: string }[]).map(
      (i) => i.alertId,
    );
    assert.deepEqual(ids, [b.id]);
    assert.equal(
      (await api.call("GET", `/v1/alerts/${a.id}`, tokenB)).status,
      404,
    );
    const cross = await ack(a.id, tokenB, {
      "idempotency-key": "x",
      "if-match": '"1"',
    });
    assert.equal(cross.status, 404);
    assert.deepEqual(
      (await outboxFor(a.tenantId)).map((r) => r["event_type"]),
      ["alert.opened"],
    );
  });

  test("keyset pagination and state filter stay inside the tenant", async () => {
    const tenantId = randomUUID();
    const ids = [
      (await openAlert(tenantId)).id,
      (await openAlert(tenantId)).id,
      (await openAlert(tenantId)).id,
    ].sort();
    const token = await api.token(tenantId, ["viewer"]);
    const first = await api.call("GET", "/v1/alerts?limit=2", token);
    const cursor = first.json["nextCursor"] as string;
    assert.equal(cursor, ids[1]);
    const second = await api.call(
      "GET",
      `/v1/alerts?limit=2&after=${cursor}&state=open`,
      token,
    );
    assert.deepEqual(
      (second.json["items"] as { alertId: string }[]).map((i) => i.alertId),
      [ids[2]],
    );
    assert.equal(second.json["nextCursor"], null);
    for (const query of ["limit=0", "after=nope", "state=closed"])
      assert.equal(
        (await api.call("GET", `/v1/alerts?${query}`, token)).status,
        400,
      );
    assert.equal(
      (await api.call("GET", "/v1/alerts/not-a-uuid", token)).status,
      404,
    );
  });

  test("health and readiness probes", async () => {
    assert.equal((await api.call("GET", "/healthz")).status, 200);
    assert.equal((await api.call("GET", "/readyz")).status, 200);
  });
});

describe("row-level security at the SQL layer", () => {
  test("alerts_app without tenant context sees nothing; with B's context sees none of A", async () => {
    const a = await openAlert();
    const b = randomUUID();
    const tables = [
      "alert_rules",
      "alert_episodes",
      "consumer_inbox",
      "alert_transitions",
      "risk_stream_positions",
    ];
    for (const table of tables) {
      const none = await appQuery<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
        [a.tenantId],
      );
      assert.equal(none[0].n, "0", table);
    }
    for (const sql of [
      "SELECT 1 FROM alert_episodes WHERE tenant_id = $1",
      "SELECT 1 FROM alert_transitions WHERE tenant_id = $1",
      "UPDATE alert_episodes SET score = 1 WHERE tenant_id = $1",
    ])
      assert.equal(await asTenant(b, sql, [a.tenantId]), 0, sql);
    assert.equal(
      await asTenant(
        a.tenantId,
        "SELECT 1 FROM alert_episodes WHERE tenant_id = $1",
        [a.tenantId],
      ),
      1,
    );
  });

  test("alerts_app cannot write another tenant's rows or delete anything", async () => {
    const a = await openAlert();
    const other = randomUUID();
    await assert.rejects(
      asTenant(
        other,
        `INSERT INTO command_receipts (tenant_id, idempotency_key, command_type, command_id, normalized_request, response_body, accepted_at)
         VALUES ($1::uuid, 'k', 'alert.acknowledge', gen_random_uuid(), '{}', '{}', now())`,
        [a.tenantId],
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "42501" &&
        /row-level security|tenant context does not match row tenant/.test(
          String(error),
        ),
    );
    for (const table of [
      "alert_episodes",
      "outbox_events",
      "alert_transitions",
    ])
      await assert.rejects(
        appQuery(`DELETE FROM ${table} WHERE tenant_id = $1`, [a.tenantId]),
        /permission denied/,
      );
    await assert.rejects(
      appQuery("SELECT count(*) FROM outbox_events"),
      /permission denied/,
    );
  });
});
