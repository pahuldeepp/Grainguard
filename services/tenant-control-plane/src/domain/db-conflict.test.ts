import assert from "node:assert/strict";
import { test } from "node:test";
import { isUniqueViolation } from "./db-conflict.js";
import { problemFor } from "../api/problem.js";
import { DomainConflictError } from "./errors.js";

test("raw SQL unique violations are recognized without matching messages", () => {
  assert.equal(
    isUniqueViolation({ code: "P2010", meta: { code: "23505" } }),
    true,
  );
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation({ code: "P2002" }), true);
  assert.equal(
    isUniqueViolation({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "23505" } } },
    }),
    true,
  );
  assert.equal(
    isUniqueViolation({ code: "P2010", meta: { code: "23503" } }),
    false,
  );
  assert.equal(
    isUniqueViolation(new Error("unique constraint violation")),
    false,
  );
});

test("domain conflicts have a stable HTTP 409 mapping", () => {
  assert.deepEqual(problemFor(new DomainConflictError("already claimed")), {
    status: 409,
    code: "resource_conflict",
    headers: {},
  });
});
