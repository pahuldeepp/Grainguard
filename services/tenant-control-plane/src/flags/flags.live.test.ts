import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { LOOKUP_TOKEN, startApi } from "../testing/api.js";
import { validateEvent } from "@greenguard/contracts";
import { adminQuery, asRuntime, outboxEvents } from "../testing/fixtures.js";

let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi();
});
after(async () => api.close());

async function org(label: string) {
  const person = await api.person(label);
  const response = await api.call("POST", "/v1/organizations", {
    token: person.token,
    body: { name: label },
    headers: { "idempotency-key": randomUUID() },
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return { tenantId: response.json.tenantId as string, token: person.token };
}

test("F01 F05 F06: tenant override is isolated, audited and header spoofing fails", async () => {
  const a = await org("flags-a");
  const b = await org("flags-b");
  const path = `/v1/organizations/${a.tenantId}/flags`;
  const denied = await api.call("PUT", path, {
    token: b.token,
    body: { flags: { "notifications.optional_sends": { value: true } } },
    headers: {
      "idempotency-key": randomUUID(),
      "if-match": '"0"',
      "x-tenant-id": a.tenantId,
    },
  });
  assert.equal(denied.status, 404);
  const key = randomUUID();
  const create = await api.call("PUT", path, {
    token: a.token,
    body: { flags: { "notifications.optional_sends": { value: true } } },
    headers: {
      "idempotency-key": key,
      "if-match": '"0"',
      "x-tenant-id": b.tenantId,
    },
  });
  assert.equal(create.status, 200, JSON.stringify(create.json));
  assert.equal(create.json.version, "1");
  const internal = `/v1/internal/flags/${a.tenantId}`;
  assert.equal((await api.call("GET", internal)).status, 401);
  const snapshot = await api.call("GET", internal, { token: LOOKUP_TOKEN });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.version, 1);
  const replay = await api.call("PUT", path, {
    token: a.token,
    body: { flags: { "notifications.optional_sends": { value: true } } },
    headers: { "idempotency-key": key, "if-match": '"0"' },
  });
  assert.equal(replay.status, 200);
  const other = await api.call("GET", `/v1/organizations/${b.tenantId}/flags`, {
    token: b.token,
  });
  assert.deepEqual(other.json.flags, {});
  const audit = await adminQuery<{ actor_identity_id: string }>(
    "SELECT actor_identity_id FROM flag_configuration_audit WHERE tenant_id = $1",
    [a.tenantId],
  );
  const outbox = await adminQuery(
    "SELECT event_id FROM outbox_events WHERE tenant_id = $1 AND event_type = 'flag.configuration_changed'",
    [a.tenantId],
  );
  assert.equal(audit.length, 1);
  assert.equal(outbox.length, 1);
  const event = (await outboxEvents(a.tenantId)).find(
    (e) => e.event_type === "flag.configuration_changed",
  );
  assert.ok(event);
  assert.equal(
    validateEvent(event).ok,
    true,
    JSON.stringify(validateEvent(event)),
  );
  assert.equal(
    (
      await asRuntime(
        { "app.tenant_id": b.tenantId },
        "SELECT * FROM flag_configurations WHERE tenant_id = $1",
        [a.tenantId],
      )
    ).rows.length,
    0,
  );
  const [security] = await adminQuery<{
    forced: boolean;
    can_update_audit: boolean;
    can_delete_flags: boolean;
  }>(
    "SELECT c.relforcerowsecurity AS forced, has_table_privilege('control_app', 'flag_configuration_audit', 'UPDATE') AS can_update_audit, has_table_privilege('control_app', 'flag_configurations', 'DELETE') AS can_delete_flags FROM pg_class c WHERE c.oid = 'flag_configurations'::regclass",
  );
  assert.equal(security?.forced, true);
  assert.equal(security?.can_update_audit, false);
  assert.equal(security?.can_delete_flags, false);
});

test("F05 tenant admin cannot set unregistered, locked or mistyped flags (422)", async () => {
  const a = await org("flags-registry");
  const path = `/v1/organizations/${a.tenantId}/flags`;
  const attempts = [
    { "made.up.kill_switch": { value: true } },
    { "notifications.optional_sends": { value: "yes" } },
    { "notifications.optional_sends": { value: true, locked: true } },
  ];
  for (const flags of attempts) {
    const response = await api.call("PUT", path, {
      token: a.token,
      body: { flags },
      headers: { "idempotency-key": randomUUID(), "if-match": '"0"' },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
  }
  const stored = await api.call("GET", path, { token: a.token });
  assert.equal(stored.json.version, "0");
});
