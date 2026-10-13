import assert from "node:assert/strict";
import test from "node:test";
import { assertMeasuredQualityGate } from "./sonar-gate.mjs";

function report(values = {}) {
  return {
    gate: { status: "OK" },
    measures: Object.entries({
      ncloc: "100",
      coverage: "80",
      security_hotspots: "0",
      ...values,
    })
      .filter(([, value]) => value !== undefined)
      .map(([metric, value]) => ({ metric, value })),
  };
}
test("measured coverage at the threshold passes", () =>
  assert.doesNotThrow(() => assertMeasuredQualityGate(report())));
test("a green empty scan cannot pass", () => {
  assert.throws(
    () =>
      assertMeasuredQualityGate(report({ ncloc: "0", coverage: undefined })),
    /no measurable source/,
  );
  assert.throws(
    () => assertMeasuredQualityGate(report({ ncloc: undefined })),
    /no measurable source/,
  );
});
test("missing, invalid and insufficient coverage cannot pass", () => {
  for (const coverage of [undefined, "", "NaN", "79.99", "101"])
    assert.throws(
      () => assertMeasuredQualityGate(report({ coverage })),
      /coverage/,
    );
});
test("hotspots and a failed server gate remain blocking", () => {
  assert.throws(
    () => assertMeasuredQualityGate(report({ security_hotspots: "1" })),
    /hotspot/,
  );
  assert.throws(
    () => assertMeasuredQualityGate(report({ security_hotspots: undefined })),
    /hotspot/,
  );
  assert.throws(
    () => assertMeasuredQualityGate({ ...report(), gate: { status: "ERROR" } }),
    /did not pass/,
  );
});
