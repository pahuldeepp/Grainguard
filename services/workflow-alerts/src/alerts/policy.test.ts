import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { deterministicId } from "./ids.js";
import {
  decide,
  defaultRule,
  escalationDue,
  type Episode,
  type RiskSignal,
} from "./policy.js";

const rule = defaultRule(randomUUID());
const signal = (
  score: number | null,
  severity: RiskSignal["severity"] = "warning",
): RiskSignal => ({
  score,
  severity,
  alertEligible: severity === "warning" || severity === "critical",
});
const active = {
  severity: "warning",
  score: 50,
  openedAt: new Date(0),
} as Episode;

test("opens only at or above the open threshold with an alert-eligible severity", () => {
  assert.deepEqual(decide(rule, undefined, signal(40)), {
    kind: "open",
    severity: "warning",
    score: 40,
  });
  assert.deepEqual(decide(rule, undefined, signal(39)), { kind: "none" });
  assert.deepEqual(decide(rule, undefined, signal(60, "normal")), {
    kind: "none",
  });
  assert.deepEqual(decide(rule, undefined, signal(null, "insufficient_data")), {
    kind: "none",
  });
});

test("an active episode updates, holds and resolves with hysteresis", () => {
  assert.deepEqual(decide(rule, active, signal(50)), { kind: "none" });
  assert.deepEqual(decide(rule, active, signal(80, "critical")), {
    kind: "update",
    severity: "critical",
    score: 80,
  });
  assert.deepEqual(decide(rule, active, signal(30, "normal")), {
    kind: "update",
    severity: "warning",
    score: 30,
  });
  assert.deepEqual(decide(rule, active, signal(25, "normal")), {
    kind: "update",
    severity: "warning",
    score: 25,
  });
  assert.deepEqual(decide(rule, active, signal(24, "normal")), {
    kind: "resolve",
    score: 24,
  });
  assert.deepEqual(decide(rule, active, signal(null, "insufficient_data")), {
    kind: "none",
  });
});

test("escalation is due only after the rule timeout", () => {
  assert.equal(escalationDue(rule, active, new Date(899_999)), false);
  assert.equal(escalationDue(rule, active, new Date(900_000)), true);
});

test("deterministic IDs are stable, distinct and RFC 4122 shaped", () => {
  const a = deterministicId("t", "e", "1", "opened");
  assert.equal(a, deterministicId("t", "e", "1", "opened"));
  assert.notEqual(a, deterministicId("t", "e", "2", "opened"));
  assert.notEqual(deterministicId("ab", "c"), deterministicId("a", "bc"));
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
