import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFlagEvent,
  checkTenantFlags,
  FLAG_REGISTRY,
  contextFromVerifiedPrincipal,
  parseFlagEvent,
  PoisonFlagEventError,
  createFlagEvaluator,
  VersionedFlagStore,
} from "./index.js";

test("flag feed applies only increasing complete tenant snapshots", () => {
  const store = new VersionedFlagStore(60_000);
  const event = {
    event_type: "flag.configuration_changed",
    schema_version: 1,
    tenant_id: A,
    aggregate_version: "2",
    payload: {
      scope: "tenant",
      config_version: "2",
      flags: { "optional-notifications": { value: true } },
    },
  };
  assert.equal(applyFlagEvent(store, event), true);
  assert.equal(applyFlagEvent(store, event), false);
  assert.equal(
    store.resolve(A, "optional-notifications", "boolean")?.value,
    true,
  );
  assert.equal(
    store.resolve(B, "optional-notifications", "boolean"),
    undefined,
  );
  assert.throws(
    () => applyFlagEvent(store, { ...event, aggregate_version: "3" }),
    /version/,
  );
});

test("reserved infrastructure event updates global fallback only", () => {
  const store = new VersionedFlagStore(60_000);
  const global = {
    event_type: "flag.configuration_changed",
    schema_version: 1,
    tenant_id: "00000000-0000-4000-8000-000000000001",
    aggregate_version: "1",
    payload: {
      scope: "global",
      config_version: "1",
      flags: { "optional-notifications": { value: true } },
    },
  };
  assert.equal(applyFlagEvent(store, global), true);
  assert.equal(
    store.resolve(A, "optional-notifications", "boolean")?.value,
    true,
  );
  assert.equal(
    store.resolve(B, "optional-notifications", "boolean")?.value,
    true,
  );
  assert.throws(
    () => applyFlagEvent(store, { ...global, tenant_id: A }),
    /global flag scope/,
  );
});

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const principal = (tenantId: string) => ({
  tenantId,
  subject: "verified-subject",
  roles: ["operator"],
});
const definitions = {
  "optional-notifications": false,
  "scoring-v2": false,
  "scoring-weight": 1,
} as const;

test("F01 tenant override is isolated and global fallback stays separate", async () => {
  const store = new VersionedFlagStore(60_000);
  store.apply({
    scope: "global",
    version: 1,
    flags: { "optional-notifications": { value: false } },
  });
  store.apply({
    scope: "tenant",
    tenantId: A,
    version: 4,
    flags: { "optional-notifications": { value: true } },
  });
  const evaluator = createFlagEvaluator(definitions, store);
  assert.deepEqual(
    await evaluator.evaluate(
      "optional-notifications",
      contextFromVerifiedPrincipal(principal(A)),
    ),
    { value: true, reason: "configured", configVersion: 4 },
  );
  assert.deepEqual(
    await evaluator.evaluate(
      "optional-notifications",
      contextFromVerifiedPrincipal(principal(B)),
    ),
    { value: false, reason: "configured", configVersion: 1 },
  );
});

test("F02 provider outage and type mismatch return typed defaults", async () => {
  const store = new VersionedFlagStore(60_000);
  store.apply({
    scope: "tenant",
    tenantId: A,
    version: 1,
    flags: {
      "scoring-v2": { value: true },
      "scoring-weight": { value: "unsafe" },
    },
  });
  const evaluator = createFlagEvaluator(definitions, store);
  const context = contextFromVerifiedPrincipal(principal(A));
  assert.deepEqual(await evaluator.evaluate("scoring-weight", context), {
    value: 1,
    reason: "default",
  });
  store.setUnavailable(true);
  assert.deepEqual(await evaluator.evaluate("scoring-v2", context), {
    value: false,
    reason: "default",
  });
});

test("F03 stale cache defaults and reports scope", async () => {
  let now = 100;
  const stale: string[] = [];
  const store = new VersionedFlagStore(
    50,
    () => now,
    (scope) => stale.push(scope),
  );
  store.apply({
    scope: "tenant",
    tenantId: A,
    version: 1,
    flags: { "scoring-v2": { value: true } },
  });
  const evaluator = createFlagEvaluator(definitions, store);
  now = 151;
  store.apply({
    scope: "global",
    version: 1,
    flags: { "scoring-v2": { value: true } },
  });
  assert.deepEqual(
    await evaluator.evaluate(
      "scoring-v2",
      contextFromVerifiedPrincipal(principal(A)),
    ),
    { value: false, reason: "default" },
  );
  assert.deepEqual(stale, [A]);
  store.refresh({
    scope: "tenant",
    tenantId: A,
    version: 1,
    flags: { "scoring-v2": { value: true } },
  });
  assert.equal(
    (
      await evaluator.evaluate(
        "scoring-v2",
        contextFromVerifiedPrincipal(principal(A)),
      )
    ).value,
    true,
  );
});

test("configuration changes are monotonic, immutable, and rollout buckets stable", async () => {
  const store = new VersionedFlagStore(60_000);
  const mutable = { "scoring-v2": { value: true } };
  assert.equal(
    store.apply({ scope: "tenant", tenantId: A, version: 2, flags: mutable }),
    true,
  );
  mutable["scoring-v2"].value = false;
  assert.equal(
    store.apply({ scope: "tenant", tenantId: A, version: 1, flags: mutable }),
    false,
  );
  const evaluator = createFlagEvaluator(definitions, store);
  const context = contextFromVerifiedPrincipal(principal(A));
  assert.equal((await evaluator.evaluate("scoring-v2", context)).value, true);
  store.apply({
    scope: "tenant",
    tenantId: A,
    version: 3,
    flags: { "scoring-v2": { value: true, rolloutPercent: 0 } },
  });
  assert.equal((await evaluator.evaluate("scoring-v2", context)).value, false);
  store.apply({
    scope: "tenant",
    tenantId: A,
    version: 4,
    flags: { "scoring-v2": { value: true, rolloutPercent: 100 } },
  });
  assert.equal((await evaluator.evaluate("scoring-v2", context)).value, true);
});

test("F06 caller context and unheld role cannot spoof tenant or role", async () => {
  const store = new VersionedFlagStore(60_000);
  const evaluator = createFlagEvaluator(definitions, store);
  await assert.rejects(
    evaluator.evaluate("scoring-v2", { tenantId: A }),
    /verified principal context/,
  );
  assert.throws(
    () => contextFromVerifiedPrincipal(principal(A), { role: "admin" }),
    /not held/,
  );
  assert.throws(
    () =>
      contextFromVerifiedPrincipal({ ...principal(A), tenantId: "spoofed" }),
    /invalid verified principal/,
  );
});

test("global locked kill switch beats a tenant override", () => {
  const store = new VersionedFlagStore(60_000);
  store.apply({
    scope: "global",
    version: 1,
    flags: { "notifications.optional_sends": { value: false, locked: true } },
  });
  store.apply({
    scope: "tenant",
    tenantId: A,
    version: 1,
    flags: { "notifications.optional_sends": { value: true } },
  });
  assert.equal(
    store.resolve(A, "notifications.optional_sends", "boolean")?.value,
    false,
  );
  store.apply({
    scope: "global",
    version: 2,
    flags: { "notifications.optional_sends": { value: false } },
  });
  assert.equal(
    store.resolve(A, "notifications.optional_sends", "boolean")?.value,
    true,
  );
});

test("flag registry allows only declared tenant-settable keys and types", () => {
  assert.equal(
    checkTenantFlags({ "notifications.optional_sends": { value: true } }),
    undefined,
  );
  assert.match(
    checkTenantFlags({ "made.up": { value: true } }) ?? "",
    /made\.up/,
  );
  assert.match(
    checkTenantFlags({ "notifications.optional_sends": { value: "yes" } }) ??
      "",
    /boolean/,
  );
  assert.match(
    checkTenantFlags({
      "notifications.optional_sends": { value: true, locked: true },
    } as never) ?? "",
    /locked/,
  );
});

test("poison flag events are classified; unknown keys are poison", () => {
  const event = {
    event_type: "flag.configuration_changed",
    schema_version: 1,
    tenant_id: A,
    aggregate_version: "1",
    payload: {
      scope: "tenant",
      config_version: "1",
      flags: { nope: { value: true } },
    },
  };
  assert.throws(
    () => parseFlagEvent(event, FLAG_REGISTRY),
    (e: unknown) =>
      e instanceof PoisonFlagEventError &&
      (e as PoisonFlagEventError).reason === "unknown_flag_key",
  );
  assert.throws(
    () =>
      parseFlagEvent({ ...event, payload: { scope: "tenant" } }, FLAG_REGISTRY),
    (e: unknown) =>
      e instanceof PoisonFlagEventError &&
      (e as PoisonFlagEventError).reason === "schema_invalid",
  );
});

test("tenant snapshot cache is bounded by LRU size", () => {
  const store = new VersionedFlagStore(60_000, Date.now, undefined, 3);
  const ids = [1, 2, 3, 4, 5].map(
    (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`,
  );
  for (const tenantId of ids)
    store.apply({
      scope: "tenant",
      tenantId,
      version: 1,
      flags: { x: { value: true } },
    });
  assert.equal(store.tenantCount(), 3);
  assert.equal(store.resolve(ids[0]!, "x", "boolean"), undefined);
  assert.equal(store.resolve(ids[4]!, "x", "boolean")?.value, true);
});
