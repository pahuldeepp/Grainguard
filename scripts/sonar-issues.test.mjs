import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSonarIssues } from "./sonar-issues.mjs";

test("issue summary retains rule and file locations without issue messages", () => {
  const report = summarizeSonarIssues({
    total: 3,
    issues: [
      {
        rule: "typescript:S1",
        severity: "MAJOR",
        type: "CODE_SMELL",
        component: "grainguard:services/read-api/src/a.ts",
        line: 12,
        message: "may contain sensitive source context",
      },
      {
        rule: "typescript:S1",
        severity: "MINOR",
        type: "CODE_SMELL",
        component: "grainguard:services/read-api/src/a.ts",
      },
      {
        rule: "go:S2",
        severity: "CRITICAL",
        type: "BUG",
        component: "grainguard:services/cdc-transformer/main.go",
        line: 4,
      },
    ],
  });

  assert.deepEqual(report.severityCounts, {
    CRITICAL: 1,
    MAJOR: 1,
    MINOR: 1,
  });
  assert.deepEqual(report.typeCounts, { BUG: 1, CODE_SMELL: 2 });
  assert.deepEqual(report.topRules, [
    { key: "typescript:S1", count: 2 },
    { key: "go:S2", count: 1 },
  ]);
  assert.deepEqual(report.topFiles[0], {
    key: "services/read-api/src/a.ts",
    count: 2,
  });
  assert.equal(report.issues[0].file, "services/read-api/src/a.ts");
  assert.equal("message" in report.issues[0], false);
});

test("incomplete or malformed Sonar issue pages fail closed", () => {
  for (const result of [
    undefined,
    { total: -1, issues: [] },
    { total: 2, issues: [] },
    { total: 1, issues: {} },
  ]) {
    assert.throws(() => summarizeSonarIssues(result), /incomplete or invalid/);
  }
});
