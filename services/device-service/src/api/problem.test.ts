import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import { AuthError } from "@greenguard/tenant-auth";
import { LockNotAvailableError } from "../db/errors.js";
import { TenantProjectionUnavailableError } from "../inventory/entitlements.js";
import {
  DeviceNotFoundError,
  DuplicateBinError,
  IdempotencyConflictError,
  InvalidReferenceError,
  VersionConflictError,
} from "../inventory/errors.js";
import { PreconditionRequiredError } from "./errors.js";
import { startApi } from "../testing/api.js";
import { classify, ProblemFilter } from "./problem.js";
import {
  etag,
  parseBin,
  parseBinding,
  parseIdempotencyKey,
  parseIfMatch,
  parsePage,
  parseRegister,
  parseSite,
  parseStatus,
  toDeviceDto,
} from "./dto.js";
import { InvalidInputError } from "../inventory/errors.js";

test("every domain error maps to a stable HTTP status and code", () => {
  const cases: [unknown, number, string][] = [
    [new AuthError(401, "invalid_token"), 401, "invalid_token"],
    [new AuthError(403, "insufficient_role"), 403, "insufficient_role"],
    [new AuthError(503, "auth_unavailable"), 503, "auth_unavailable"],
    [new InvalidInputError("bad"), 400, "invalid_request"],
    [new PreconditionRequiredError(), 428, "precondition_required"],
    [new VersionConflictError("7"), 412, "version_conflict"],
    [new IdempotencyConflictError(), 409, "idempotency_conflict"],
    [new DuplicateBinError(), 409, "duplicate_resource"],
    [new LockNotAvailableError(), 409, "resource_locked"],
    [
      new TenantProjectionUnavailableError(),
      503,
      "tenant_projection_unavailable",
    ],
    [new InvalidReferenceError(), 422, "invalid_reference"],
    [new DeviceNotFoundError(), 404, "not_found"],
    [new HttpException("x", 418), 418, "http_error"],
    [new Error("secret database detail"), 500, "internal_error"],
    ["not an error", 500, "internal_error"],
  ];
  for (const [error, status, code] of cases) {
    const problem = classify(error);
    assert.equal(problem.status, status);
    assert.equal(problem.code, code);
    assert.ok(!JSON.stringify(problem).includes("secret"));
  }
  assert.equal(classify(new VersionConflictError("7")).headers?.ETag, '"7"');
  assert.equal(
    classify(new LockNotAvailableError()).headers?.["Retry-After"],
    "1",
  );
  assert.equal(
    classify(new TenantProjectionUnavailableError()).headers?.["Retry-After"],
    "5",
  );
  assert.equal(
    classify(new AuthError(503, "auth_unavailable")).headers?.["Retry-After"],
    "5",
  );
  assert.equal(
    classify(new AuthError(401, "invalid_token")).headers?.["WWW-Authenticate"],
    "Bearer",
  );
});

test("health probes keep their own body when the API is enabled", async () => {
  const api = await startApi({
    ping: async () => {
      throw new Error("db down");
    },
  });
  try {
    const res = await api.call("GET", "/readyz");
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, {
      service: "device-service",
      status: "not_ready",
    });
    assert.equal(
      res.headers.get("content-type")?.startsWith("application/json"),
      true,
    );
  } finally {
    await api.close();
  }
});

test("500 responses are logged by class name only", () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    setHeader() {},
    end: (c: string) => chunks.push(c),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ url: "/v1/x", correlationId: "c" }),
      getResponse: () => res,
    }),
  };
  try {
    new ProblemFilter({} as never).catch(
      new Error("password=hunter2"),
      host as never,
    );
    new ProblemFilter({} as never).catch("boom", host as never);
  } finally {
    console.error = original;
  }
  assert.deepEqual(
    logged.map((l) => l[1]),
    ["Error", "string"],
  );
  assert.ok(!chunks.join("").includes("hunter2"));
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(chunks[0]).correlation_id, "c");
});

test("request validators accept good input and reject bad input", () => {
  const id = "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d";
  assert.deepEqual(parseSite({ name: "North" }), { name: "North" });
  assert.deepEqual(parseBin({ siteId: id, name: "Bin" }), {
    siteId: id,
    name: "Bin",
  });
  assert.deepEqual(parseRegister({ serialNumber: "S1", siteId: id }), {
    serialNumber: "S1",
    siteId: id,
    binId: null,
  });
  assert.deepEqual(parseBinding({ siteId: id, binId: id }), {
    siteId: id,
    binId: id,
  });
  assert.equal(parseStatus({ status: "disabled" }), "disabled");
  assert.equal(parseIdempotencyKey("key-123"), "key-123");
  assert.equal(parseIfMatch('"12"'), "12");
  assert.deepEqual(parsePage(undefined, undefined), {
    limit: 50,
    afterDeviceId: undefined,
  });
  assert.deepEqual(parsePage("5", id), { limit: 5, afterDeviceId: id });
  assert.equal(etag(3n), '"3"');
  for (const bad of [
    () => parseSite(null),
    () => parseSite({ name: 5 }),
    () => parseSite({ name: "x", z: 1 }),
    () => parseStatus({}),
    () => parseIfMatch("3"),
    () => parsePage("0", undefined),
  ])
    assert.throws(bad, InvalidInputError);
  assert.throws(() => parseIfMatch(undefined), PreconditionRequiredError);
  const now = new Date("2026-09-23T10:00:00.123Z");
  assert.deepEqual(
    toDeviceDto({
      deviceId: id,
      siteId: id,
      binId: null,
      serialNumber: "S",
      status: "active",
      bindingVersion: 9007199254740993n,
      createdAt: now,
      updatedAt: now,
    }).bindingVersion,
    "9007199254740993",
  );
});

test("without API options only the health routes exist", async () => {
  const { createApp } = await import("../app.js");
  const app = await createApp({ ping: async () => undefined });
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/v1/devices`)).status, 404);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    await app.close();
  }
});
