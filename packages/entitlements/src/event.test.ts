import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeEntitlementEvent,
  decodeHeartbeat,
  InvalidEntitlementEvent,
} from "./event.js";
const a = "11111111-1111-4111-8111-111111111111",
  b = "22222222-2222-4222-8222-222222222222";
const event = {
  event_id: b,
  event_type: "entitlements.changed",
  tenant_id: a,
  aggregate_type: "entitlement",
  aggregate_id: a,
  aggregate_version: "2",
  payload: {
    tenant_id: a,
    plan_key: "standard",
    plan_version: "1",
    source_version: "2",
    limits: { "devices.max": 100 },
    features: { audit_export: true },
    effective_at: "2026-09-25T00:00:00Z",
  },
};
test("billing event rejects wrong key, forged tenant, and version mismatch", () => {
  assert.equal(
    decodeEntitlementEvent(
      Buffer.from(JSON.stringify(event)),
      Buffer.from(`${a}:${a}`),
    )?.tenant_id,
    a,
  );
  assert.throws(
    () =>
      decodeEntitlementEvent(
        Buffer.from(JSON.stringify(event)),
        Buffer.from(`${b}:${b}`),
      ),
    InvalidEntitlementEvent,
  );
  assert.throws(
    () =>
      decodeEntitlementEvent(
        Buffer.from(
          JSON.stringify({
            ...event,
            payload: { ...event.payload, tenant_id: b },
          }),
        ),
        Buffer.from(`${a}:${a}`),
      ),
    InvalidEntitlementEvent,
  );
  assert.throws(
    () =>
      decodeEntitlementEvent(
        Buffer.from(JSON.stringify({ ...event, aggregate_version: "1" })),
        Buffer.from(`${a}:${a}`),
      ),
    InvalidEntitlementEvent,
  );
});
test("heartbeat decodes emitted_at, ignores plan events and rejects malformed heartbeats", () => {
  const beat = Buffer.from(
    JSON.stringify({
      event_type: "entitlements.heartbeat",
      emitted_at: "2026-09-25T00:00:00Z",
    }),
  );
  assert.equal(
    decodeHeartbeat(beat)?.toISOString(),
    "2026-09-25T00:00:00.000Z",
  );
  assert.equal(decodeHeartbeat(Buffer.from(JSON.stringify(event))), null);
  assert.throws(
    () =>
      decodeHeartbeat(
        Buffer.from(
          JSON.stringify({
            event_type: "entitlements.heartbeat",
            emitted_at: "nope",
          }),
        ),
      ),
    InvalidEntitlementEvent,
  );
  assert.throws(
    () => decodeHeartbeat(Buffer.from("{")),
    InvalidEntitlementEvent,
  );
});
test("plan decoder ignores heartbeats", () => {
  assert.equal(
    decodeEntitlementEvent(
      Buffer.from(
        JSON.stringify({
          event_type: "entitlements.heartbeat",
          emitted_at: "2026-09-25T00:00:00Z",
        }),
      ),
      null,
    ),
    null,
  );
});
