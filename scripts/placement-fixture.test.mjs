import assert from "node:assert/strict";
import test from "node:test";
import {
  INFRASTRUCTURE_TENANT,
  localShardSelection,
  ownershipSubjects,
  startPlacementAuthority,
} from "./placement-fixture.mjs";

const infrastructureTenant = INFRASTRUCTURE_TENANT;

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

test("fixture placement authority serves the bootstrapped infrastructure tenant", async () => {
  const incarnation = "20000000-0000-4000-8000-000000000001";
  const authority = await startPlacementAuthority({ s1: incarnation });
  try {
    const response = await fetch(
      `${authority.url}/v1/internal/placements/${INFRASTRUCTURE_TENANT}`,
      { headers: { authorization: `Bearer ${authority.token}` } },
    );
    assert.equal(response.status, 200);
    const placement = await response.json();
    assert.equal(placement.tenantId, INFRASTRUCTURE_TENANT);
    assert.equal(placement.shardId, "s1");
    assert.equal(placement.shardIncarnation, incarnation);
    assert.equal(placement.placementEpoch, "1");
    assert.equal(placement.state, "active");
    assert.ok(Date.parse(placement.expiresAt) > Date.now());
  } finally {
    authority.close();
  }
});
