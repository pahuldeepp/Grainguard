import assert from "node:assert/strict";
import test from "node:test";
import {
  localShardSelection,
  ownershipSubjects,
} from "./placement-fixture.mjs";

const infrastructureTenant = "00000000-0000-4000-8000-000000000001";

test("placement fixtures always bootstrap infrastructure and customer tenants once", () => {
  const tenant = "10000000-0000-4000-8000-000000000001";

  assert.deepEqual(ownershipSubjects([tenant]), [tenant, infrastructureTenant]);
  assert.deepEqual(ownershipSubjects([infrastructureTenant]), [
    infrastructureTenant,
  ]);
  assert.deepEqual(ownershipSubjects([tenant, tenant]), [
    tenant,
    infrastructureTenant,
  ]);
});

test("single-shard E2E fixtures explicitly mark placeholder endpoints inactive", () => {
  assert.deepEqual(localShardSelection(), {
    SHARD_ACTIVE_IDS: "s1",
    SHARD_LOCAL_LOOPBACK: "true",
  });
});
