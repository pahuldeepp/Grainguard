import assert from "node:assert/strict";
import test from "node:test";
import { assertAnonymousRequestRejected } from "./staging-check-contract.mjs";

test("staging accepts a mounted API that rejects anonymous requests", () => {
  assert.doesNotThrow(() =>
    assertAnonymousRequestRejected({ status: 401 }, "telemetry-ingest"),
  );
});

test("staging rejects a health-only API whose product route returns 404", () => {
  assert.throws(
    () => assertAnonymousRequestRejected({ status: 404 }, "telemetry-ingest"),
    /must reject anonymous requests with 401; received 404/,
  );
});

test("staging rejects an API whose anonymous request is not authenticated", () => {
  assert.throws(
    () => assertAnonymousRequestRejected({ status: 200 }, "device-service"),
    /must reject anonymous requests with 401; received 200/,
  );
});
