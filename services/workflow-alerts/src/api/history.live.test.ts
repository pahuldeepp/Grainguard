import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { handleRiskEvent } from "../consumer/handler.js";
import { escalateIfStillUnacknowledged } from "../alerts/lifecycle.js";
import { defaultRule } from "../alerts/policy.js";
import { startApi } from "../testing/api.js";
import { adminQuery, newStream, riskEvent } from "../testing/fixtures.js";
let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(() => api.close());
const types = (page: Record<string, unknown>) =>
  (page.items as { type: string }[]).map((item) => item.type);
const actor = (result: Record<string, unknown>) =>
  result.actor as { kind: string; isYou: boolean; handle: string | null };
async function opened(tenantId = randomUUID()) {
  const stream = newStream(tenantId);
  const now = new Date("2026-09-26T00:00:00Z");
  const result = await handleRiskEvent(api.db, riskEvent(stream, 75), {
    now: () => now,
  });
  return {
    tenantId,
    stream,
    now,
    id: (result as { effect: { episodeId: string } }).effect.episodeId,
  };
}
const history = (id: string, token: string, query = "") =>
  api.call(
    "GET",
    `/v1/alerts/${id}/transitions${query ? `?${query}` : ""}`,
    token,
  );
const acknowledge = (
  id: string,
  token: string,
  version = "1",
  key = "ack-history",
) =>
  api.call("POST", `/v1/alerts/${id}/acknowledge`, token, {
    "if-match": `"${version}"`,
    "idempotency-key": key,
  });

test("batched risk-score rule read is deduplicated, bounded, tenant-filtered and role protected", async () => {
  const a = await opened(),
    b = await opened();
  const ids = `${defaultRule(a.tenantId).ruleId},${defaultRule(b.tenantId).ruleId},${defaultRule(a.tenantId).ruleId},${randomUUID()}`;
  for (const role of ["viewer", "operator", "admin"]) {
    const result = await api.call(
      "GET",
      `/v1/alert-rules?ids=${ids}`,
      await api.token(a.tenantId, [role]),
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(result.json.items, [
      {
        ruleId: defaultRule(a.tenantId).ruleId,
        ruleKey: "grain-risk-default",
        resourceKind: "bin",
        openScore: 40,
        clearScore: 25,
        escalationTimeoutSeconds: 900,
      },
    ]);
  }
  const viewer = await api.token(a.tenantId, ["viewer"]);
  for (const query of [
    "",
    "ids=bad",
    `ids=${Array(51).fill(defaultRule(a.tenantId).ruleId).join(",")}`,
    `ids=${a.id}&ids=${b.id}`,
  ])
    assert.equal(
      (await api.call("GET", `/v1/alert-rules?${query}`, viewer)).status,
      400,
    );
  for (const roles of [["device"], ["viewer", "device"]])
    assert.equal(
      (
        await api.call(
          "GET",
          `/v1/alert-rules?ids=${ids}`,
          await api.token(a.tenantId, roles),
        )
      ).status,
      403,
    );
  assert.equal(
    (await api.call("GET", `/v1/alert-rules?ids=${ids}`)).status,
    401,
  );
});

test("lifecycle history respects version order, exact final pages, diagnostics, truthful coverage and private DTOs", async () => {
  const a = await opened();
  const subject = `private-subject-${randomUUID()}`;
  const operator = await api.token(a.tenantId, ["operator"], subject);
  const viewer = await api.token(a.tenantId, ["viewer"], subject);
  const admin = await api.token(a.tenantId, ["admin"], subject);
  await handleRiskEvent(api.db, riskEvent(a.stream, 85), {
    now: () => new Date("2026-09-25T23:59:00Z"),
  });
  await escalateIfStillUnacknowledged(
    api.db,
    { tenantId: a.tenantId, episodeId: a.id },
    new Date("2026-09-26T00:15:00Z"),
  );
  const first = await acknowledge(a.id, operator, "3");
  assert.equal(first.status, 200);
  assert.deepEqual((await acknowledge(a.id, operator, "3")).json, first.json);
  await escalateIfStillUnacknowledged(api.db, {
    tenantId: a.tenantId,
    episodeId: a.id,
  });
  await handleRiskEvent(api.db, riskEvent(a.stream, 10));
  const all = await history(a.id, viewer);
  assert.equal(all.status, 200);
  assert.equal(all.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(types(all.json), [
    "opened",
    "updated",
    "escalated",
    "acknowledged",
    "resolved",
  ]);
  assert.equal(all.json.complete, true);
  assert.deepEqual(all.json.source, { status: "ok", reasonCode: null });
  assert.equal(
    actor((all.json.items as Record<string, unknown>[])[3]).isYou,
    true,
  );
  const exact = await history(a.id, viewer, "limit=5");
  assert.equal(exact.json.nextCursor, null);
  const page = await history(a.id, viewer, "limit=3");
  const last = await history(
    a.id,
    viewer,
    `limit=2&after=${page.json.nextCursor}`,
  );
  assert.deepEqual(types(last.json), ["acknowledged", "resolved"]);
  assert.equal(last.json.nextCursor, null);
  assert.equal((await history(a.id, viewer, "include=all")).status, 403);
  assert.equal((await history(a.id, operator, "include=all")).status, 403);
  const diagnostic = await history(a.id, admin, "include=all");
  assert.ok(types(diagnostic.json).includes("escalation_suppressed"));
  const detail = await api.call("GET", `/v1/alerts/${a.id}`, viewer);
  assert.equal(detail.json.escalatedAt, "2026-09-26T00:15:00.000Z");
  assert.equal(detail.json.acknowledgedBy, "you");
  const list = await api.call("GET", "/v1/alerts", viewer);
  const json = JSON.stringify([
    all.json,
    diagnostic.json,
    detail.json,
    list.json,
  ]);
  assert.ok(!json.includes(subject));
  for (const forbidden of [
    "actor_id",
    "actor_issuer",
    "cause_id",
    "event_id",
    "eventId",
    "causeId",
  ])
    assert.ok(!json.includes(`"${forbidden}"`));
  const [saved] = await adminQuery<{
    acknowledged_by_issuer: string;
    actor_issuer: string;
    outbox_issuer: string;
  }>(
    `SELECT e.acknowledged_by_issuer, t.actor_issuer, o.actor_issuer AS outbox_issuer FROM alert_episodes e JOIN alert_transitions t USING (tenant_id, episode_id) JOIN outbox_events o ON o.tenant_id=t.tenant_id AND o.event_id=t.event_id WHERE e.tenant_id=$1 AND e.episode_id=$2 AND t.transition_type='acknowledged'`,
    [a.tenantId, a.id],
  );
  assert.deepEqual(saved, {
    acknowledged_by_issuer: api.issuer.issuer,
    actor_issuer: api.issuer.issuer,
    outbox_issuer: api.issuer.issuer,
  });
  await adminQuery(
    "DELETE FROM alert_transitions WHERE tenant_id=$1 AND episode_id=$2 AND episode_version=2",
    [a.tenantId, a.id],
  );
  const gap = await history(a.id, admin, "include=all");
  assert.equal(gap.json.complete, false);
  assert.deepEqual(gap.json.source, {
    status: "partial",
    reasonCode: "incomplete_lifecycle",
  });
});

test("issuer collision, other member, legacy actor and all old DTOs have redacted identity", async () => {
  const a = await opened();
  const subject = `private-subject-${randomUUID()}`;
  const token = await api.token(a.tenantId, ["operator"], subject);
  await acknowledge(a.id, token);
  const issuerCollision = await api.secondIssuer.sign({
    tenant_id: a.tenantId,
    roles: ["viewer"],
    sub: subject,
  });
  const other = await api.call("GET", `/v1/alerts/${a.id}`, issuerCollision);
  assert.equal(actor(other.json).isYou, false);
  assert.match(other.json.acknowledgedBy as string, /^member-[a-f0-9]{12}$/);
  const same = await api.call("GET", `/v1/alerts/${a.id}`, token);
  assert.equal(actor(same.json).isYou, true);
  assert.equal(same.json.acknowledgedBy, "you");
  const h = await history(a.id, issuerCollision);
  assert.equal(
    actor((h.json.items as Record<string, unknown>[])[1]).isYou,
    false,
  );
  await adminQuery(
    "UPDATE alert_episodes SET acknowledged_by_issuer=NULL WHERE tenant_id=$1 AND episode_id=$2",
    [a.tenantId, a.id],
  );
  await adminQuery(
    "UPDATE alert_transitions SET actor_issuer=NULL WHERE tenant_id=$1 AND episode_id=$2 AND actor_type='user'",
    [a.tenantId, a.id],
  );
  const legacy = await api.call("GET", `/v1/alerts/${a.id}`, token);
  assert.equal(legacy.json.acknowledgedBy, "team-member");
  assert.deepEqual(actor(legacy.json), {
    kind: "user",
    isYou: false,
    handle: null,
  });
  assert.deepEqual(
    actor(
      ((await history(a.id, token)).json.items as Record<string, unknown>[])[1],
    ),
    { kind: "user", isYou: false, handle: null },
  );
  assert.ok(
    !JSON.stringify([other.json, same.json, legacy.json, h.json]).includes(
      subject,
    ),
  );
});

test("history rejects foreign IDs, malformed/binding-mismatched cursors and invalid authentication", async () => {
  const a = await opened(),
    otherAlert = await opened(a.tenantId),
    b = await opened();
  await handleRiskEvent(api.db, riskEvent(a.stream, 85));
  const token = await api.token(a.tenantId, ["admin"]),
    tokenB = await api.token(b.tenantId, ["admin"]);
  const page = await history(a.id, token, "limit=1");
  const cursor = page.json.nextCursor;
  assert.equal((await history(a.id, tokenB)).status, 404);
  assert.deepEqual(
    (await history(a.id, tokenB)).json,
    (await history(randomUUID(), tokenB)).json,
  );
  for (const [id, caller, query] of [
    [a.id, tokenB, `after=${cursor}`],
    [otherAlert.id, token, `after=${cursor}`],
    [a.id, token, `after=${cursor}&include=all`],
    [a.id, token, "limit=101"],
    [a.id, token, "include=bad"],
    [a.id, token, "after=bad"],
    [a.id, token, `after=${"a".repeat(2049)}`],
  ])
    assert.equal((await history(id, caller, query)).status, 400);
  for (const options of [
    { audience: "wrong" },
    { expiresInSec: -100 },
    { issuer: "https://unknown.test" },
  ]) {
    const bad = await api.issuer.sign(
      { tenant_id: a.tenantId, roles: ["viewer"] },
      options,
    );
    assert.equal((await history(a.id, bad)).status, 401);
    assert.equal(
      (
        await api.call(
          "GET",
          `/v1/alert-rules?ids=${defaultRule(a.tenantId).ruleId}`,
          bad,
        )
      ).status,
      401,
    );
  }
  assert.equal(
    (await api.call("GET", `/v1/alerts/${a.id}/transitions`)).status,
    401,
  );
  for (const claims of [
    { gty: "client-credentials" },
    { grant_type: "client_credentials" },
    { device_id: randomUUID() },
  ]) {
    const machine = await api.issuer.sign({
      tenant_id: a.tenantId,
      roles: ["admin"],
      ...claims,
    });
    assert.equal((await history(a.id, machine, "include=all")).status, 403);
    assert.equal(
      (
        await api.call(
          "GET",
          `/v1/alert-rules?ids=${defaultRule(a.tenantId).ruleId}`,
          machine,
        )
      ).status,
      403,
    );
    assert.equal((await acknowledge(a.id, machine)).status, 403);
  }
});

test("microsecond/time/id ties page correctly and suppressed rows cannot repair pre-audit coverage", async () => {
  const a = await opened();
  const token = await api.token(a.tenantId, ["admin"]);
  const transitionIds = [randomUUID(), randomUUID(), randomUUID()].sort();
  for (const [i, id] of transitionIds.entries())
    await adminQuery(
      `INSERT INTO alert_transitions (tenant_id, transition_id, episode_id, episode_version, transition_type, from_state, to_state, actor_type, actor_id, cause_id, event_id, occurred_at) VALUES ($1,$2,$3,1,'escalation_suppressed','open','open','system','internal',$4,NULL,$5)`,
      [
        a.tenantId,
        id,
        a.id,
        randomUUID(),
        `2026-09-26T00:00:00.${i === 2 ? "123457" : "123456"}Z`,
      ],
    );
  const got: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await history(
      a.id,
      token,
      `limit=1&include=all${cursor ? `&after=${cursor}` : ""}`,
    );
    assert.equal(page.status, 200);
    got.push(
      ...(page.json.items as { transitionId: string }[]).map(
        (x) => x.transitionId,
      ),
    );
    cursor = page.json.nextCursor as string | null;
  } while (cursor);
  assert.equal(got.length, 4);
  assert.deepEqual(got.slice(1), transitionIds);
  await adminQuery(
    "DELETE FROM alert_transitions WHERE tenant_id=$1 AND episode_id=$2 AND transition_type='opened'",
    [a.tenantId, a.id],
  );
  const empty = await history(a.id, token);
  assert.deepEqual(empty.json.items, []);
  assert.equal(empty.json.complete, false);
  assert.equal(
    (await history(a.id, token, "include=all")).json.complete,
    false,
  );
});
