import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { LOOKUP_TOKEN, startApi } from "../testing/api.js";
import { activateTenantFixture } from "../testing/fixtures.js";
let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(() => api.close());
async function org(label: string) {
  const actor = await api.person(label);
  const created = await api.call("POST", "/v1/organizations", {
    token: actor.token,
    body: { name: label },
    headers: { "idempotency-key": randomUUID() },
  });
  assert.equal(created.status, 202);
  assert.equal(created.json.state, "provisioning");
  await activateTenantFixture(
    api.db,
    { issuer: api.issuer.issuer, subject: actor.subject },
    created.json.tenantId as string,
    {
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
  );
  return { actor, tenantId: created.json.tenantId as string };
}
test("verified membership binds tenant placement and rejects forged claims", async () => {
  const a = await org("a"),
    b = await org("b");
  const path = `/v1/organizations/${a.tenantId}/placement`;
  const own = await api.call("GET", path, { token: a.actor.token });
  assert.equal(own.status, 200);
  assert.equal(own.json.tenantId, a.tenantId);
  assert.equal(own.json.placementEpoch, "1");
  assert.equal(own.headers.get("cache-control"), "no-store");
  assert.equal(
    (await api.call("GET", path, { token: b.actor.token })).status,
    404,
  );
  const forged = await api.person("forged", {
    tenant_id: a.tenantId,
    roles: ["admin"],
  });
  assert.equal(
    (await api.call("GET", path, { token: forged.token })).status,
    404,
  );
  assert.equal((await api.call("GET", path)).status, 401);
});
test("internal endpoint requires service authentication; callers cannot supply shard/epoch routing", async () => {
  const a = await org("internal");
  const path = `/v1/internal/placements/${a.tenantId}`;
  assert.equal((await api.call("GET", path)).status, 401);
  assert.equal(
    (await api.call("GET", path, { token: a.actor.token })).status,
    401,
  );
  assert.equal(
    (await api.call("GET", path, { token: LOOKUP_TOKEN })).status,
    200,
  );
  assert.equal(
    (await api.call("GET", `${path}?shardId=s4`, { token: LOOKUP_TOKEN }))
      .status,
    400,
  );
  assert.equal(
    (
      await api.call("GET", path, {
        token: LOOKUP_TOKEN,
        headers: { "x-placement-epoch": "55" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api.call("GET", `/v1/internal/placements/${randomUUID()}`, {
        token: LOOKUP_TOKEN,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await api.call("GET", "/v1/internal/placements/invalid", {
        token: LOOKUP_TOKEN,
      })
    ).status,
    400,
  );
  assert.equal(
    (await api.call("POST", `${path}/move`, { token: LOOKUP_TOKEN })).status,
    404,
  );
  assert.equal(
    (
      await api.call("POST", "/v1/organizations", {
        token: a.actor.token,
        body: { name: "hint", shardId: "s4" },
        headers: { "idempotency-key": randomUUID() },
      })
    ).status,
    400,
  );
});

test("read lease endpoints require service auth, reject hints and never permit caching", async () => {
  const a = await org("read-lease");
  const acquire = `/v1/internal/placements/${a.tenantId}/read-leases`;
  for (const token of [undefined, a.actor.token]) {
    assert.equal((await api.call("POST", acquire, { token })).status, 401);
  }
  const lease = await api.call("POST", acquire, { token: LOOKUP_TOKEN });
  assert.equal(lease.status, 201);
  assert.equal(lease.headers.get("cache-control"), "no-store");
  const actions: [string, string][] = [
    ["POST", acquire],
    ["POST", `${acquire}/${lease.json.leaseId}/admit`],
    ["DELETE", `${acquire}/${lease.json.leaseId}`],
  ];
  for (const [method, path] of actions) {
    assert.equal(
      (await api.call(method, `${path}?shardId=s4`, { token: LOOKUP_TOKEN }))
        .status,
      400,
    );
    assert.equal(
      (
        await api.call(method, path, {
          token: LOOKUP_TOKEN,
          headers: { "x-placement-epoch": "99" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await api.call(method, path, {
          token: LOOKUP_TOKEN,
          body: { shardId: "s4" },
        })
      ).status,
      400,
    );
  }
  const admitted = await api.call(
    "POST",
    `${acquire}/${lease.json.leaseId}/admit`,
    { token: LOOKUP_TOKEN },
  );
  assert.equal(admitted.status, 201);
  assert.equal(admitted.headers.get("cache-control"), "no-store");
  const released = await api.call(
    "DELETE",
    `${acquire}/${lease.json.leaseId}`,
    { token: LOOKUP_TOKEN },
  );
  assert.equal(released.status, 200);
  assert.equal(released.headers.get("cache-control"), "no-store");
  assert.equal(
    (
      await api.call("POST", `${acquire}/${lease.json.leaseId}/admit`, {
        token: LOOKUP_TOKEN,
      })
    ).status,
    409,
  );
});
