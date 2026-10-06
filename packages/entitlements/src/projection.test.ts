import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEntitlementHeartbeat,
  applyEntitlementProjection,
} from "./projection.js";

const event = {
  event_type: "entitlements.changed" as const,
  event_id: "22222222-2222-4222-8222-222222222222",
  aggregate_type: "entitlement" as const,
  aggregate_id: "11111111-1111-4111-8111-111111111111",
  aggregate_version: "42",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  payload: {
    tenant_id: "11111111-1111-4111-8111-111111111111",
    plan_key: "pro",
    plan_version: "3",
    source_version: "42",
    limits: { "devices.max": 250 },
    features: { sso: true },
    effective_at: "2026-09-26T00:00:00Z",
  },
};

test("entitlement projection binds tenant data and reports monotonic upsert", async () => {
  let statement = "";
  let values: unknown[] = [];
  const applied = await applyEntitlementProjection(
    async (query, ...parameters) => {
      statement = query;
      values = parameters;
      return 1;
    },
    event,
  );
  assert.equal(applied, true);
  assert.match(statement, /source_version<excluded\.source_version/);
  assert.doesNotMatch(statement, /11111111/);
  assert.deepEqual(values, [
    event.tenant_id,
    "pro",
    3n,
    '{"devices.max":250}',
    '{"sso":true}',
    42n,
  ]);
  assert.equal(await applyEntitlementProjection(async () => 0, event), false);
});

test("heartbeat projection binds partition and timestamp", async () => {
  let statement = "";
  let values: unknown[] = [];
  const emittedAt = new Date("2026-09-26T00:00:00Z");
  await applyEntitlementHeartbeat(
    async (query, ...parameters) => {
      statement = query;
      values = parameters;
      return 1;
    },
    4,
    emittedAt,
  );
  assert.match(statement, /GREATEST\(entitlement_feed_health\.verified_at/);
  assert.deepEqual(values, [4, emittedAt]);
});
