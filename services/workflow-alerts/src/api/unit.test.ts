import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpException } from "@nestjs/common";
import { AuthError } from "@greenguard/tenant-auth";
import { InvalidStateError } from "../alerts/errors.js";
import {
  InvalidTenantError,
  LockTimeoutError,
  sqlState,
} from "../db/tenant.js";
import type { AlertRequest } from "./auth.js";
import { correlate, page } from "./parse.js";
import { toProblem } from "./problem.js";

test("problem mapping covers auth, state, lock and unknown errors", () => {
  assert.deepEqual(toProblem(new AuthError(403, "insufficient_role")), {
    status: 403,
    code: "insufficient_role",
    headers: undefined,
  });
  assert.equal(toProblem(new InvalidStateError("resolved")).status, 409);
  assert.equal(toProblem(new InvalidTenantError()).status, 400);
  assert.deepEqual(toProblem(new LockTimeoutError()).headers, {
    "Retry-After": "1",
  });
  assert.equal(toProblem(new HttpException("x", 405)).status, 405);
  assert.equal(toProblem(new Error("boom")).status, 500);
});

test("page defaults and correlation IDs", () => {
  assert.deepEqual(page(), { limit: 50, after: undefined, state: undefined });
  const req = {
    headers: { "x-correlation-id": ["not-a-uuid"] },
  } as unknown as AlertRequest;
  correlate(req);
  assert.match(req.correlationId as string, /^[0-9a-f-]{36}$/);
  assert.match(req.traceparent as string, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test("sqlState reads only the driver adapter SQLSTATE", () => {
  assert.equal(sqlState(null), undefined);
  assert.equal(
    sqlState({
      meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
    }),
    "55P03",
  );
  assert.equal(
    sqlState({ meta: { driverAdapterError: { cause: { originalCode: 1 } } } }),
    undefined,
  );
});
