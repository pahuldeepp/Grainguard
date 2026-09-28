import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calibratedRiskEventV2,
  newStream,
  riskEvent,
} from "../testing/fixtures.js";
import { riskInput } from "./handler.js";

test("risk v2 orders by aggregate stream version while v1 keeps its assessment version", () => {
  const stream = newStream();
  const v2 = calibratedRiskEventV2(stream);
  assert.equal(v2.payload.assessment_version, "2");
  assert.equal(v2.aggregate_version, "42");
  assert.equal(riskInput(v2).assessmentVersion, 42n);

  const v1 = riskEvent(stream, 20, { version: 43 });
  assert.equal(riskInput(v1).assessmentVersion, 43n);
});
