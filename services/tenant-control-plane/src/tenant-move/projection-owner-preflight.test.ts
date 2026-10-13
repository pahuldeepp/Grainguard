import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProjectionMovePreflight,
  PROJECTION_MOVE_BLOCKERS,
} from "./projection-owner-preflight.js";

const tenant = "44444444-4444-4444-8444-444444444444";

test("projection owner preflight refuses a valid tenant before placement can advance", () => {
  assert.throws(
    () => assertProjectionMovePreflight(tenant),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^projection tenant move blocked:/);
      for (const blocker of PROJECTION_MOVE_BLOCKERS) {
        assert.ok(error.message.includes(blocker));
      }
      return true;
    },
  );
});

test("projection owner preflight rejects malformed tenant ids", () => {
  assert.throws(
    () => assertProjectionMovePreflight("tenant-a"),
    /invalid projection move tenant id/,
  );
});
