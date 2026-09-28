import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  assertOwnerMoveProtocolAvailable,
  UNSUPPORTED_MOVE_OWNERS,
  UNSUPPORTED_OWNER_MOVE_EFFECTS,
} from "./owner-capabilities.js";

const adapterOwners = ["inventory", "risk", "telemetry"] as const;

test("every sharded owner without a receipt adapter has concrete move blockers", () => {
  const unsupported = SHARDED_MOVE_OWNERS.filter(
    (owner) => !adapterOwners.includes(owner as (typeof adapterOwners)[number]),
  );
  assert.deepEqual(
    [...UNSUPPORTED_MOVE_OWNERS].sort(),
    [...unsupported].sort(),
  );
  for (const owner of unsupported) {
    const effects =
      UNSUPPORTED_OWNER_MOVE_EFFECTS[
        owner as keyof typeof UNSUPPORTED_OWNER_MOVE_EFFECTS
      ];
    assert.ok(effects.length >= 3, `${owner} needs specific missing effects`);
    assert.ok(effects.every((effect) => effect.length > 30));
    assert.throws(
      () => assertOwnerMoveProtocolAvailable(owner),
      (error) =>
        error instanceof Error &&
        error.message.startsWith(`${owner} tenant move unsupported:`),
    );
  }
});

test("owner protocol guard allows only owners with implemented adapter modules", () => {
  for (const owner of adapterOwners)
    assert.doesNotThrow(() => assertOwnerMoveProtocolAvailable(owner));
});
