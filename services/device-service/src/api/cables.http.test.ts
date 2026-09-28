import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startApi } from "../testing/api.js";
import { seedTenant } from "../testing/fixtures.js";

let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(async () => {
  await api.close();
});
async function owner() {
  const fixture = await seedTenant(api.db);
  return {
    ...fixture,
    admin: await api.token(fixture.tenantId, ["admin"]),
    operator: await api.token(fixture.tenantId, ["operator"]),
    viewer: await api.token(fixture.tenantId, ["viewer"]),
  };
}
const input = (t: { deviceId: string; binId: string }) => ({
  deviceId: t.deviceId,
  binId: t.binId,
  label: "Cable one",
  sensors: [
    { label: "Upper", position: 1, depthM: null },
    { label: "Lower", position: 2, depthM: 1 },
  ],
});

test("cable HTTP routes authenticate, enforce roles and tenant ownership", async () => {
  const a = await owner();
  const b = await owner();
  assert.equal(
    (await api.call("GET", `/v1/bins/${a.binId}/cables`)).status,
    401,
  );
  assert.equal(
    (
      await api.call("POST", "/v1/cables", {
        token: a.viewer,
        headers: { "idempotency-key": randomUUID() },
        body: input(a),
      })
    ).status,
    403,
  );
  const created = await api.call("POST", "/v1/cables", {
    token: a.operator,
    headers: { "idempotency-key": randomUUID() },
    body: input(a),
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("etag"), '"1"');
  const path = created.headers.get("location") as string;
  const fetched = await api.call("GET", path, { token: a.viewer });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json?.cableVersion, "1");
  for (const method of ["GET", "PATCH", "DELETE"])
    assert.equal(
      (
        await api.call(method, path, {
          token: b.operator,
          headers: { "if-match": '"1"' },
          ...(method === "PATCH" && { body: input(b) }),
        })
      ).status,
      404,
    );
  assert.equal(
    (await api.call("GET", `/v1/bins/${a.binId}/cables`, { token: b.viewer }))
      .status,
    404,
  );
  assert.equal(
    (
      await api.call("POST", "/v1/cables", {
        token: b.operator,
        headers: { "idempotency-key": randomUUID() },
        body: input(a),
      })
    ).status,
    422,
  );
  for (const method of ["PATCH", "DELETE"])
    assert.equal(
      (
        await api.call(method, path, {
          token: a.viewer,
          headers: { "if-match": '"1"' },
          ...(method === "PATCH" && { body: input(a) }),
        })
      ).status,
      403,
    );
});

test("cable HTTP If-Match edits/removals expose new versions and stale preconditions", async () => {
  const a = await owner();
  const body = input(a);
  const created = await api.call("POST", "/v1/cables", {
    token: a.admin,
    headers: { "idempotency-key": randomUUID() },
    body,
  });
  const path = created.headers.get("location") as string;
  assert.equal(
    (await api.call("PATCH", path, { token: a.operator, body })).status,
    428,
  );
  assert.equal(
    (await api.call("DELETE", path, { token: a.operator })).status,
    428,
  );
  assert.equal(
    (
      await api.call("PATCH", path, {
        token: a.operator,
        headers: { "if-match": "1" },
        body,
      })
    ).status,
    400,
  );
  const sensors = created.json?.sensors as {
    sensorId: string;
    label: string;
    position: number;
    depthM: number | null;
  }[];
  const changed = await api.call("PATCH", path, {
    token: a.operator,
    headers: { "if-match": '"1"' },
    body: { ...body, sensors: [sensors[0]] },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get("etag"), '"2"');
  const stale = await api.call("PATCH", path, {
    token: a.operator,
    headers: { "if-match": '"1"' },
    body,
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.headers.get("etag"), '"2"');
  const deleted = await api.call("DELETE", path, {
    token: a.operator,
    headers: { "if-match": '"2"' },
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.headers.get("etag"), '"3"');
  assert.deepEqual(deleted.json?.sensors, []);
  assert.equal(
    (
      await api.call("DELETE", path, {
        token: a.operator,
        headers: { "if-match": '"3"' },
      })
    ).status,
    404,
  );
});

test("cable HTTP input rejects spoofed tenant/asset/sensor identities and unsupported units", async () => {
  const a = await owner();
  assert.equal(
    (
      await api.call("GET", `/v1/bins/${a.binId}/cables?after=invalid`, {
        token: a.viewer,
      })
    ).status,
    400,
  );
  for (const body of [
    { ...input(a), tenantId: randomUUID() },
    { ...input(a), assetId: randomUUID() },
    {
      ...input(a),
      sensors: [{ label: "Top", sensorId: randomUUID(), position: 1 }],
    },
    {
      ...input(a),
      sensors: [{ label: "Top", position: 1, depth: 1, depthUnit: "ft" }],
    },
  ])
    assert.equal(
      (
        await api.call("POST", "/v1/cables", {
          token: a.operator,
          headers: { "idempotency-key": randomUUID() },
          body,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await api.call("POST", "/v1/cables", {
        token: a.operator,
        body: input(a),
      })
    ).status,
    400,
  );
});
