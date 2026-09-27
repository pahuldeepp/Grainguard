import assert from "node:assert/strict";
import { test } from "node:test";
import { VersionedFlagStore, type FlagChange } from "@greenguard/feature-flags";
import {
  GLOBAL_FLAG_TENANT,
  optionalSendGate,
  OPTIONAL_SEND_FLAG,
} from "./flags.js";
import { handleTask } from "./worker.js";
import { incoming, makeDeps, makeTask } from "./testing/fixtures.js";
import type pg from "pg";

test("F04: optional work waits in retry queue when disabled; no ledger or provider call", async () => {
  const task = makeTask({ severity: "warning" });
  const { deps, broker, adapter } = makeDeps({} as pg.Pool);
  deps.optionalSendEnabled = async () => false;
  assert.equal(await handleTask(deps, incoming(task)), "ack");
  assert.equal(broker.keys().length, 1);
  assert.equal(adapter.delivered.size, 0);
  assert.equal(broker.published[0]?.messageId, task.intent_id);
  assert.deepEqual(broker.published[0]?.body, incoming(task).body);
});

test("F02 F03: absent, down and stale configuration disable optional sends", async () => {
  let now = 0;
  let stale = 0;
  const tenantId = makeTask().tenant_id;
  const store = new VersionedFlagStore(
    10,
    () => now,
    () => stale++,
  );
  const gate = optionalSendGate(store);
  assert.equal(await gate(tenantId), false);
  store.apply({
    scope: "tenant",
    tenantId,
    version: 1,
    flags: { [OPTIONAL_SEND_FLAG]: { value: true } },
  });
  assert.equal(await gate(tenantId), true);
  store.setUnavailable(true);
  assert.equal(await gate(tenantId), false);
  store.setUnavailable(false);
  now = 11;
  assert.equal(await gate(tenantId), false);
  assert.equal(stale, 1);
});

test("unchanged authoritative snapshot renews freshness; outage eventually defaults off", async () => {
  let now = 0;
  let outage = false;
  let calls = 0;
  const tenantId = makeTask().tenant_id;
  const store = new VersionedFlagStore(60_000, () => now);
  const gate = optionalSendGate(
    store,
    async (id): Promise<FlagChange> => {
      calls++;
      if (outage) throw new Error("control plane down");
      if (id === GLOBAL_FLAG_TENANT)
        return { scope: "global", version: 1, flags: {} };
      return {
        scope: "tenant",
        tenantId: id,
        version: 1,
        flags: { [OPTIONAL_SEND_FLAG]: { value: true } },
      };
    },
    () => now,
  );
  assert.equal(await gate(tenantId), true);
  now = 30_001;
  assert.equal(await gate(tenantId), true);
  assert.equal(calls, 4);
  outage = true;
  now = 60_002;
  assert.equal(await gate(tenantId), true); // last good still inside bound
  now = 90_002;
  assert.equal(await gate(tenantId), false);
});

test("global snapshot supplies fallback and tenant override wins", async () => {
  const tenantId = makeTask().tenant_id;
  const store = new VersionedFlagStore(60_000);
  let tenantEnabled = false;
  const gate = optionalSendGate(store, async (id): Promise<FlagChange> =>
    id === GLOBAL_FLAG_TENANT
      ? {
          scope: "global",
          version: 1,
          flags: { [OPTIONAL_SEND_FLAG]: { value: true } },
        }
      : {
          scope: "tenant",
          tenantId: id,
          version: tenantEnabled ? 2 : 1,
          flags: tenantEnabled
            ? { [OPTIONAL_SEND_FLAG]: { value: false } }
            : {},
        },
  );
  assert.equal(await gate(tenantId), true);
  tenantEnabled = true;
  store.apply({
    scope: "tenant",
    tenantId,
    version: 2,
    flags: { [OPTIONAL_SEND_FLAG]: { value: false } },
  });
  assert.equal(await gate(tenantId), false);
});
