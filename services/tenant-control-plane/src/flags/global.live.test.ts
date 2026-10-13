import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { validateEvent } from "@greenguard/contracts";
import { LOOKUP_TOKEN, startApi } from "../testing/api.js";
import {
  adminQuery,
  asRuntime,
  outboxEvents,
  activateTenantFixture,
} from "../testing/fixtures.js";
import { GLOBAL_FLAG_TENANT } from "./store.js";

const OPERATOR_TOKEN = "stage-09f-platform-operator-token-unique";
const OPERATOR_ID = "00000000-0000-4000-8000-000000000002";
let api: Awaited<ReturnType<typeof startApi>>;
before(async () => {
  api = await startApi({ token: OPERATOR_TOKEN, actorId: OPERATOR_ID });
});
after(async () => api.close());

test("global writes require platform credential and audit configured actor", async () => {
  const tenantAdmin = await api.person("global-denied");
  const org = await api.call("POST", "/v1/organizations", {
    token: tenantAdmin.token,
    body: { name: "Global guard tenant" },
    headers: { "idempotency-key": randomUUID() },
  });
  assert.equal(org.status, 202);
  assert.equal(org.json.state, "provisioning");
  await activateTenantFixture(
    api.db,
    { issuer: api.issuer.issuer, subject: tenantAdmin.subject },
    org.json.tenantId as string,
    {
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    },
  );
  const tenantId = org.json.tenantId as string;
  const path = "/v1/internal/flags/global";
  const snapshotPath = `/v1/internal/flags/${GLOBAL_FLAG_TENANT}`;
  const beforeSnapshot = await api.call("GET", snapshotPath, {
    token: LOOKUP_TOKEN,
  });
  assert.equal(beforeSnapshot.status, 200);
  const version = Number(beforeSnapshot.json.version);
  const body = { flags: { "notifications.optional_sends": { value: true } } };
  const headers = {
    "idempotency-key": randomUUID(),
    "if-match": `"${version}"`,
  };
  const denied = await api.call("PUT", path, {
    token: tenantAdmin.token,
    body,
    headers,
  });
  assert.equal(denied.status, 401);
  const changed = await api.call("PUT", path, {
    token: OPERATOR_TOKEN,
    body,
    headers,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(Number(changed.json.version), version + 1);
  const replay = await api.call("PUT", path, {
    token: OPERATOR_TOKEN,
    body,
    headers,
  });
  assert.equal(replay.status, 200);
  const audit = await adminQuery<{ actor_identity_id: string }>(
    "SELECT actor_identity_id FROM flag_configuration_audit WHERE tenant_id = $1 AND config_version = $2",
    [GLOBAL_FLAG_TENANT, version + 1],
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.actor_identity_id, OPERATOR_ID);
  const event = (await outboxEvents(GLOBAL_FLAG_TENANT)).find(
    (e) =>
      e.event_type === "flag.configuration_changed" &&
      e.aggregate_version === String(version + 1),
  );
  assert.ok(event);
  assert.equal(event.payload.scope, "global");
  assert.equal(
    validateEvent(event).ok,
    true,
    JSON.stringify(validateEvent(event)),
  );
  assert.equal(
    (
      await asRuntime(
        { "app.tenant_id": tenantId },
        "SELECT * FROM flag_configurations WHERE tenant_id = $1",
        [GLOBAL_FLAG_TENANT],
      )
    ).rows.length,
    0,
  );
});

test("global kill switch may be locked; unknown global keys are rejected with 422", async () => {
  const snapshotPath = `/v1/internal/flags/${GLOBAL_FLAG_TENANT}`;
  const current = await api.call("GET", snapshotPath, { token: LOOKUP_TOKEN });
  const headers = () => ({
    "idempotency-key": randomUUID(),
    "if-match": `"${current.json.version}"`,
  });
  const path = "/v1/internal/flags/global";
  const unknown = await api.call("PUT", path, {
    token: OPERATOR_TOKEN,
    body: { flags: { "made.up": { value: false } } },
    headers: headers(),
  });
  assert.equal(unknown.status, 422, JSON.stringify(unknown.json));
  const locked = await api.call("PUT", path, {
    token: OPERATOR_TOKEN,
    body: {
      flags: { "notifications.optional_sends": { value: false, locked: true } },
    },
    headers: headers(),
  });
  assert.equal(locked.status, 200, JSON.stringify(locked.json));
});
