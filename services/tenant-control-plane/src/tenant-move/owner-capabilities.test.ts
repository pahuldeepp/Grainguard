import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARDED_MOVE_OWNERS } from "../domain/placement.js";
import {
  assertOwnerMoveProtocolAvailable,
  UNSUPPORTED_MOVE_OWNERS,
  UNSUPPORTED_OWNER_MOVE_EFFECTS,
} from "./owner-capabilities.js";

test("every sharded owner fails closed until it has a complete all-owner move adapter", () => {
  const unsupported = [...SHARDED_MOVE_OWNERS];
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

test("local owner primitives do not make telemetry, risk, or inventory migratable alone", () => {
  for (const owner of ["inventory", "risk", "telemetry"] as const) {
    assert.throws(
      () => assertOwnerMoveProtocolAvailable(owner),
      new RegExp(`${owner} tenant move unsupported:.*all-owner coordinator`),
    );
  }
});
