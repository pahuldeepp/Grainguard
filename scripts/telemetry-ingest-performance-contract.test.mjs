import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workload = readFileSync(
  new URL("../tests/performance/telemetry-ingest.js", import.meta.url),
  "utf8",
);

test("telemetry load gate enforces the API p95 SLO", () => {
  assert.match(workload, /http_req_duration:\s*\["p\(95\)<300"\]/);
});
