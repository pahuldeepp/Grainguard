import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { outboxRowToEvent, validateEvent } from "@greenguard/contracts";
import { createTenant } from "../testing/fixtures.js";
import { startApi } from "../testing/api.js";
import { adminQuery } from "../testing/fixtures.js";

interface OutboxRecord {
  event_id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  event_type: string;
  schema_version: number;
  occurred_at: Date;
  correlation_id: string;
  causation_id: string;
  traceparent: string;
  payload: unknown;
}

let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(() => api.close());

async function tenant() {
  const tenantId = randomUUID();
  await createTenant(api.db, tenantId, `tenant ${tenantId.slice(0, 8)}`);
  const admin = await api.token(tenantId, ["admin"], "admin-1");
  const operator = await api.token(tenantId, ["operator"], "operator-1");
  const viewer = await api.token(tenantId, ["viewer"], "viewer-1");
  const site = await api.call("POST", "/v1/sites", {
    headers: { "idempotency-key": randomUUID() },
    token: admin,
    body: { name: "North" },
  });
  const bin = await api.call("POST", "/v1/bins", {
    headers: { "idempotency-key": randomUUID() },
    token: admin,
    body: { siteId: site.json?.siteId, name: "Bin 1" },
  });
  return {
    tenantId,
    admin,
    operator,
    viewer,
    siteId: site.json?.siteId as string,
    binId: bin.json?.binId as string,
  };
}

const register = (
  t: { operator: string; siteId: string; binId: string },
  extra: Record<string, string> = {},
) =>
  api.call("POST", "/v1/devices", {
    token: t.operator,
    headers: { "idempotency-key": randomUUID(), ...extra },
    body: {
      serialNumber: `SN-${randomUUID()}`,
      siteId: t.siteId,
      binId: t.binId,
    },
  });

test("authentication: missing, malformed, expired, wrong-audience and forged tokens are 401", async () => {
  const t = await tenant();
  const expired = await api.issuer.sign(
    { tenant_id: t.tenantId, roles: ["admin"] },
    { expiresInSec: -120 },
  );
  const wrongAudience = await api.issuer.sign(
    { tenant_id: t.tenantId, roles: ["admin"] },
    { audience: "other" },
  );
  for (const token of [null, "garbage", expired, wrongAudience]) {
    const res = await api.call("GET", "/v1/devices", { token });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    assert.equal(res.json?.status, 401);
    assert.ok(!res.text.includes("garbage"));
  }
});

test("authorization: viewers read but cannot write; only admins create sites and bins", async () => {
  const t = await tenant();
  assert.equal(
    (await api.call("GET", "/v1/devices", { token: t.viewer })).status,
    200,
  );
  const forbidden = await api.call("POST", "/v1/devices", {
    token: t.viewer,
    headers: { "idempotency-key": randomUUID() },
    body: { serialNumber: "x", siteId: t.siteId },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json?.code, "insufficient_role");
  const site = await api.call("POST", "/v1/sites", {
    headers: { "idempotency-key": randomUUID() },
    token: t.operator,
    body: { name: "x" },
  });
  assert.equal(site.status, 403);
  const bin = await api.call("POST", "/v1/bins", {
    headers: { "idempotency-key": randomUUID() },
    token: t.operator,
    body: { siteId: t.siteId, name: "x" },
  });
  assert.equal(bin.status, 403);
});

test("grain lot placement is admin-only, tenant-scoped and validates its outbox contract", async () => {
  const a = await tenant();
  const b = await tenant();
  const effectiveFrom = "2026-09-20T08:00:00.000Z";
  const path = `/v1/bins/${a.binId}/lots`;
  const body = { grainType: "wheat", variety: "spring", effectiveFrom };
  const forbidden = await api.call("POST", path, {
    token: a.operator,
    headers: { "idempotency-key": randomUUID() },
    body,
  });
  assert.equal(forbidden.status, 403);
  const placed = await api.call("POST", path, {
    token: a.admin,
    headers: { "idempotency-key": randomUUID() },
    body,
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.json?.occupancyVersion, "1");
  const at = `/v1/bins/${a.binId}/lots/at?observedAt=${encodeURIComponent(effectiveFrom)}`;
  const own = await api.call("GET", at, { token: a.viewer });
  assert.equal(
    (own.json?.placement as { grainType?: string })?.grainType,
    "wheat",
  );
  const foreign = await api.call("GET", at, { token: b.viewer });
  assert.equal(foreign.json?.placement, null);
  const [row] = await adminQuery<OutboxRecord>(
    `SELECT event_id, tenant_id, aggregate_type, aggregate_id,
      aggregate_version::text, event_type, schema_version, occurred_at,
      correlation_id, causation_id, traceparent, payload
      FROM outbox_events WHERE event_id=$1`,
    [placed.json?.eventId],
  );
  assert.equal(
    validateEvent(
      outboxRowToEvent({
        eventId: row.event_id,
        tenantId: row.tenant_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: BigInt(row.aggregate_version),
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        occurredAt: row.occurred_at,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        traceparent: row.traceparent,
        payload: row.payload,
      }),
    ).ok,
    true,
  );
});

test("tenant isolation over HTTP: tenant B cannot see or change tenant A, and a forged tenant header is ignored", async () => {
  const a = await tenant();
  const b = await tenant();
  const created = await register(a);
  assert.equal(created.status, 201);
  const deviceId = created.json?.deviceId as string;
  const forged = { "x-tenant-id": a.tenantId };
  const list = await api.call("GET", "/v1/devices", {
    token: b.viewer,
    headers: forged,
  });
  assert.deepEqual(list.json?.items, []);
  const get = await api.call("GET", `/v1/devices/${deviceId}`, {
    token: b.viewer,
    headers: forged,
  });
  assert.equal(get.status, 404);
  const patch = await api.call("PATCH", `/v1/devices/${deviceId}`, {
    token: b.operator,
    headers: { "if-match": '"1"', ...forged },
    body: { siteId: b.siteId, binId: null },
  });
  assert.equal(patch.status, 404);
  const status = await api.call("POST", `/v1/devices/${deviceId}/status`, {
    token: b.operator,
    body: { status: "disabled" },
  });
  assert.equal(status.status, 404);
  const crossSite = await api.call("POST", "/v1/devices", {
    token: b.operator,
    headers: { "idempotency-key": randomUUID() },
    body: { serialNumber: "cross", siteId: a.siteId },
  });
  assert.equal(crossSite.status, 422);
  assert.equal(crossSite.json?.code, "invalid_reference");
  const own = await api.call("GET", `/v1/devices/${deviceId}`, {
    token: a.viewer,
  });
  assert.equal(own.status, 200);
  assert.equal(own.json?.status, "active");
});

test("registration is idempotent over HTTP and requires a valid Idempotency-Key", async () => {
  const t = await tenant();
  const key = randomUUID();
  const body = { serialNumber: `SN-${randomUUID()}`, siteId: t.siteId };
  const first = await api.call("POST", "/v1/devices", {
    token: t.operator,
    headers: { "idempotency-key": key },
    body,
  });
  const again = await api.call("POST", "/v1/devices", {
    token: t.operator,
    headers: { "idempotency-key": key },
    body,
  });
  assert.equal(first.status, 201);
  assert.deepEqual(again.json, first.json);
  assert.equal(first.headers.get("etag"), '"1"');
  assert.equal(
    first.headers.get("location"),
    `/v1/devices/${first.json?.deviceId}`,
  );
  const changed = await api.call("POST", "/v1/devices", {
    token: t.operator,
    headers: { "idempotency-key": key },
    body: { ...body, serialNumber: "different" },
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json?.code, "idempotency_conflict");
  for (const headers of [
    {},
    { "idempotency-key": "has space" },
    { "idempotency-key": "x".repeat(201) },
  ] as Record<string, string>[]) {
    const res = await api.call("POST", "/v1/devices", {
      token: t.operator,
      headers,
      body,
    });
    assert.equal(res.status, 400);
    assert.equal(res.json?.code, "invalid_request");
  }
  const dup = await api.call("POST", "/v1/devices", {
    token: t.operator,
    headers: { "idempotency-key": randomUUID() },
    body,
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json?.code, "duplicate_resource");
});

test("optimistic concurrency: ETag, If-Match, 428 and 412", async () => {
  const t = await tenant();
  const created = await register(t);
  const path = `/v1/devices/${created.json?.deviceId}`;
  const read = await api.call("GET", path, { token: t.viewer });
  assert.equal(read.headers.get("etag"), '"1"');
  assert.equal(read.json?.bindingVersion, "1");
  const cached = await api.call("GET", path, {
    token: t.viewer,
    headers: { "if-none-match": '"1"' },
  });
  assert.equal(cached.status, 304);
  const body = { siteId: t.siteId, binId: null };
  const missing = await api.call("PATCH", path, { token: t.operator, body });
  assert.equal(missing.status, 428);
  assert.equal(missing.json?.code, "precondition_required");
  const malformed = await api.call("PATCH", path, {
    token: t.operator,
    headers: { "if-match": "1" },
    body,
  });
  assert.equal(malformed.status, 400);
  const ok = await api.call("PATCH", path, {
    token: t.operator,
    headers: { "if-match": '"1"' },
    body,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("etag"), '"2"');
  assert.equal(ok.json?.bindingVersion, "2");
  const stale = await api.call("PATCH", path, {
    token: t.operator,
    headers: { "if-match": '"1"' },
    body,
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.headers.get("etag"), '"2"');
  assert.equal(stale.json?.code, "version_conflict");
  const zero = await api.call("PATCH", path, {
    token: t.operator,
    headers: { "if-match": '"0"' },
    body,
  });
  assert.equal(zero.status, 400);
});

test("status changes bump the version and validate input", async () => {
  const t = await tenant();
  const created = await register(t);
  const path = `/v1/devices/${created.json?.deviceId}/status`;
  const ok = await api.call("POST", path, {
    token: t.operator,
    body: { status: "disabled" },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("etag"), '"2"');
  const bad = await api.call("POST", path, {
    token: t.operator,
    body: { status: "exploded" },
  });
  assert.equal(bad.status, 400);
  const missing = await api.call("POST", `/v1/devices/${randomUUID()}/status`, {
    token: t.operator,
    body: { status: "active" },
  });
  assert.equal(missing.status, 404);
});

test("pagination: bounded pages with a stable cursor", async () => {
  const t = await tenant();
  for (let i = 0; i < 3; i++) await register(t);
  const first = await api.call("GET", "/v1/devices?limit=2", {
    token: t.viewer,
  });
  assert.equal(first.json?.items?.length, 2);
  assert.equal(first.json?.nextCursor, first.json?.items?.[1].deviceId);
  const next = await api.call(
    "GET",
    `/v1/devices?limit=2&after=${first.json?.nextCursor}`,
    { token: t.viewer },
  );
  assert.equal(next.json?.items?.length, 1);
  assert.equal(next.json?.nextCursor, null);
  for (const query of [
    "limit=0",
    "limit=501",
    "limit=abc",
    "limit=1.5",
    "after=not-a-uuid",
  ]) {
    const res = await api.call("GET", `/v1/devices?${query}`, {
      token: t.viewer,
    });
    assert.equal(res.status, 400, query);
  }
});

test("malformed requests get problem+json without leaking internals", async () => {
  const t = await tenant();
  const headers = { "idempotency-key": randomUUID() };
  for (const body of [
    [],
    "text",
    { serialNumber: "x" },
    { serialNumber: "", siteId: t.siteId },
    { serialNumber: "x", siteId: "nope" },
    { serialNumber: "x", siteId: t.siteId, binId: "nope" },
    { serialNumber: "x", siteId: t.siteId, extra: 1 },
  ]) {
    const res = await api.call("POST", "/v1/devices", {
      token: t.operator,
      headers,
      body,
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
  }
  const json = await api.call("POST", "/v1/devices", {
    token: t.operator,
    headers,
    rawBody: "{not json",
  });
  assert.equal(json.status, 400);
  const unknown = await api.call("GET", "/v1/nope", { token: t.viewer });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json?.code, "http_error");
  const badId = await api.call("GET", "/v1/devices/not-a-uuid", {
    token: t.viewer,
  });
  assert.equal(badId.status, 404);
  const noDevice = await api.call("GET", `/v1/devices/${randomUUID()}`, {
    token: t.viewer,
  });
  assert.equal(noDevice.status, 404);
  assert.equal(noDevice.json?.code, "not_found");
  for (const [path, body] of [
    ["/v1/sites", {}],
    ["/v1/bins", { siteId: "x", name: "n" }],
    ["/v1/bins", { siteId: t.siteId }],
  ] as const) {
    assert.equal(
      (
        await api.call("POST", path, {
          token: t.admin,
          body,
          headers: { "idempotency-key": randomUUID() },
        })
      ).status,
      400,
    );
  }
  const foreignBin = await api.call("POST", "/v1/bins", {
    headers: { "idempotency-key": randomUUID() },
    token: t.admin,
    body: { siteId: randomUUID(), name: "x" },
  });
  assert.equal(foreignBin.status, 422);
});

test("correlation: valid IDs are kept and reach the outbox; invalid ones are replaced", async () => {
  const t = await tenant();
  const correlation = randomUUID();
  const trace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const kept = await register(t, {
    "x-correlation-id": correlation,
    traceparent: trace,
  });
  assert.equal(kept.headers.get("x-correlation-id"), correlation);
  const [row] = await adminQuery<{
    correlation_id: string;
    traceparent: string;
  }>(
    "SELECT correlation_id, traceparent FROM outbox_events WHERE aggregate_id = $1::uuid",
    [kept.json?.deviceId],
  );
  assert.deepEqual(row, { correlation_id: correlation, traceparent: trace });
  const bad = await register(t, {
    "x-correlation-id": "not-a-uuid",
    traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
  });
  const replaced = bad.headers.get("x-correlation-id") as string;
  assert.notEqual(replaced, "not-a-uuid");
  assert.match(replaced, /^[0-9a-f-]{36}$/);
  const [generated] = await adminQuery<{ traceparent: string }>(
    "SELECT traceparent FROM outbox_events WHERE aggregate_id = $1::uuid",
    [bad.json?.deviceId],
  );
  assert.match(
    generated.traceparent,
    /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-01$/,
  );
  const problem = await api.call("GET", "/v1/devices", {
    token: null,
    headers: { "x-correlation-id": correlation },
  });
  assert.equal(problem.json?.correlation_id, correlation);
});

test("event contracts: every outbox event written through the API validates", async () => {
  const t = await tenant();
  const created = await register(t);
  const id = created.json?.deviceId as string;
  await api.call("PATCH", `/v1/devices/${id}`, {
    token: t.operator,
    headers: { "if-match": '"1"' },
    body: { siteId: t.siteId, binId: null },
  });
  await api.call("POST", `/v1/devices/${id}/status`, {
    token: t.operator,
    body: { status: "disabled" },
  });
  const rows = await adminQuery<OutboxRecord>(
    "SELECT * FROM outbox_events WHERE aggregate_id = $1::uuid ORDER BY aggregate_version",
    [id],
  );
  assert.deepEqual(
    rows.map((r) => r.event_type),
    ["device.registered", "device.binding_changed", "device.status_changed"],
  );
  for (const r of rows) {
    const event = outboxRowToEvent({
      eventId: r.event_id,
      tenantId: r.tenant_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      aggregateVersion: BigInt(r.aggregate_version),
      eventType: r.event_type,
      schemaVersion: r.schema_version,
      occurredAt: r.occurred_at,
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      traceparent: r.traceparent,
      payload: r.payload,
    });
    const result = validateEvent(event);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test("traceparent flags are normalised to the sampled bit so stored events stay valid", async () => {
  const t = await tenant();
  const ids = "4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7";
  for (const [flags, expected] of [
    ["03", "01"],
    ["00", "00"],
    ["02", "00"],
    ["ff", "01"],
  ]) {
    const res = await register(t, { traceparent: `00-${ids}-${flags}` });
    const [row] = await adminQuery<OutboxRecord>(
      "SELECT * FROM outbox_events WHERE aggregate_id = $1::uuid",
      [res.json?.deviceId],
    );
    assert.equal(row.traceparent, `00-${ids}-${expected}`);
    const result = validateEvent(
      outboxRowToEvent({
        eventId: row.event_id,
        tenantId: row.tenant_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: BigInt(row.aggregate_version),
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        occurredAt: row.occurred_at,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        traceparent: row.traceparent,
        payload: row.payload,
      }),
    );
    assert.equal(result.ok, true, flags);
  }
});

test("H6: facility commands require valid keys and replay stable responses", async () => {
  const t = await tenant();
  for (const [path, body] of [
    ["/v1/sites", { name: "Idempotent" }],
    ["/v1/bins", { name: "Idempotent", siteId: t.siteId }],
  ] as const) {
    for (const headers of [{}, { "idempotency-key": "with spaces" }] as Record<
      string,
      string
    >[]) {
      const response = await api.call("POST", path, {
        token: t.admin,
        body,
        headers,
      });
      assert.equal(response.status, 400);
    }
    const options = {
      token: t.admin,
      body,
      headers: { "idempotency-key": randomUUID() },
    };
    const first = await api.call("POST", path, options);
    assert.equal(first.status, 201);
    assert.deepEqual((await api.call("POST", path, options)).json, first.json);
    assert.ok(first.json?.eventId);
    const conflict = await api.call("POST", path, {
      ...options,
      body: { ...body, name: "different" },
    });
    assert.equal(conflict.status, 409);
  }
});
