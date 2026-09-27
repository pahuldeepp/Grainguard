import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EntitlementStore,
  MAX_STALENESS_MS,
  type ChangedEvent,
} from "./index.js";
const event = (tenant: string, version: string, max: number): ChangedEvent => ({
  event_type: "entitlements.changed",
  tenant_id: tenant,
  payload: {
    tenant_id: tenant,
    plan_key: "standard",
    plan_version: "2",
    source_version: version,
    limits: { "devices.max": max },
    features: { audit_export: true },
    effective_at: new Date().toISOString(),
  },
});
test("higher versions win; duplicates and reordered events cannot roll back", () => {
  const store = new EntitlementStore();
  store.heartbeat(0, new Date());
  assert.equal(store.apply(event("a", "2", 100)), true);
  assert.equal(store.apply(event("a", "2", 1)), false);
  assert.equal(store.apply(event("a", "1", 1)), false);
  assert.equal(store.decision("a", "devices.max").limit, 100);
});
test("tenant isolation and stale or missing fallback deny paid features", () => {
  let now = new Date();
  const alerts: string[] = [];
  const store = new EntitlementStore(
    (t) => alerts.push(t),
    () => now,
  );
  store.heartbeat(0, now);
  store.apply(event("a", "1", 100));
  assert.equal(store.decision("b", "devices.max").limit, 10);
  assert.equal(store.feature("b", "audit_export"), false);
  assert.equal(store.feature("a", "audit_export"), true);
  now = new Date(now.getTime() + MAX_STALENESS_MS + 1);
  assert.deepEqual(store.decision("a", "devices.max"), {
    limit: 10,
    planKey: "free",
    planVersion: 1,
    fallback: true,
  });
  assert.deepEqual(alerts, ["b", "b", "a"]);
});
test("an unchanged paid plan is honored while heartbeats arrive and fails closed only when the feed is stale", () => {
  const start = new Date();
  let now = start;
  const alerts: string[] = [];
  const store = new EntitlementStore(
    (t) => alerts.push(t),
    () => now,
  );
  store.apply(event("a", "1", 100));
  for (let minute = 1; minute <= 60; minute++) {
    now = new Date(start.getTime() + minute * 60_000);
    store.heartbeat(0, now);
  }
  assert.equal(store.decision("a", "devices.max").limit, 100);
  assert.equal(store.feature("a", "audit_export"), true);
  now = new Date(now.getTime() + MAX_STALENESS_MS + 1);
  assert.equal(store.decision("a", "devices.max").limit, 10);
  store.heartbeat(0, now);
  assert.equal(store.decision("a", "devices.max").limit, 100);
  assert.deepEqual(alerts, ["a"]);
});
test("a lagging partition keeps the feed stale and a late heartbeat cannot move health backwards", () => {
  const now = new Date();
  const store = new EntitlementStore(
    () => {},
    () => now,
  );
  store.apply(event("a", "1", 100));
  store.heartbeat(0, now);
  store.heartbeat(1, new Date(now.getTime() - MAX_STALENESS_MS - 1));
  assert.equal(store.decision("a", "devices.max").limit, 10);
  store.heartbeat(1, now);
  store.heartbeat(1, new Date(now.getTime() - 3_600_000));
  assert.equal(store.decision("a", "devices.max").limit, 100);
});
