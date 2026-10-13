import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SECTION_CONVENTIONS,
  checkRunbooks,
} from "./observability-runbook-check.mjs";
import { parseYaml } from "./observability-yaml.mjs";

const runbookPath = "docs/runbooks/demo.md";
const goodRunbook = `# Runbook: demo\n\nDemoAlert fires when demo is broken.\n\n## Triage\n\nLook.\n\n## Recovery and evidence\n\nFix.\n`;

function rule({ name = "DemoAlert", severity = true, summary = true, url }) {
  const labels = severity
    ? "          severity: page\n"
    : "          team: x\n";
  const sum = summary ? '          summary: "broken"\n' : "";
  const link = url ? `          runbook_url: "${url}"\n` : "";
  return `groups:
  - name: demo
    rules:
      - alert: ${name}
        expr: up == 0
        for: 1m
        labels:
${labels}        annotations:
${sum}${link}`;
}

async function fixture({ rules, runbook }) {
  const root = await mkdtemp(join(tmpdir(), "runbook-check-"));
  await mkdir(join(root, "infra/observability/rules"), { recursive: true });
  await mkdir(join(root, "docs/runbooks"), { recursive: true });
  await writeFile(join(root, "infra/observability/rules/demo.yaml"), rules);
  if (runbook !== undefined) await writeFile(join(root, runbookPath), runbook);
  return root;
}

async function problemsFor(options) {
  return (await checkRunbooks({ root: await fixture(options) })).problems;
}

test("a complete alert and runbook produce no problems", async () => {
  const problems = await problemsFor({
    rules: rule({ url: runbookPath }),
    runbook: goodRunbook,
  });
  assert.deepEqual(problems, []);
});

test("both existing runbook conventions are accepted", async () => {
  assert.deepEqual(SECTION_CONVENTIONS, [
    ["Triage", "Recovery and evidence"],
    ["Symptom", "Diagnosis", "Mitigation", "Escalation"],
  ]);
  const alt = `# R\n\nDemoAlert\n\n## Symptom\n\n## Diagnosis\n\n## Mitigation\n\n## Escalation\n`;
  const problems = await problemsFor({
    rules: rule({ url: runbookPath }),
    runbook: alt,
  });
  assert.deepEqual(problems, []);
});

test("a partly written second convention names the missing heading", async () => {
  const problems = await problemsFor({
    rules: rule({ url: runbookPath }),
    runbook:
      "# R\n\nDemoAlert\n\n## Symptom\n\n## Diagnosis\n\n## Mitigation\n",
  });
  const text = problems.join("\n");
  assert.match(text, /missing-section.*Escalation/);
  assert.doesNotMatch(text, /Recovery and evidence/);
});

test("a rule with no runbook_url is reported", async () => {
  const problems = await problemsFor({ rules: rule({}), runbook: goodRunbook });
  assert.match(problems.join("\n"), /missing-runbook-url.*DemoAlert/);
});

test("a dangling runbook link is reported", async () => {
  const problems = await problemsFor({
    rules: rule({ url: "docs/runbooks/absent.md" }),
    runbook: goodRunbook,
  });
  assert.match(problems.join("\n"), /dangling-runbook.*DemoAlert/);
});

test("a link outside docs/runbooks is reported", async () => {
  const problems = await problemsFor({
    rules: rule({ url: "../../etc/passwd" }),
    runbook: goodRunbook,
  });
  assert.match(problems.join("\n"), /dangling-runbook/);
});

test("a runbook missing a required section is reported", async () => {
  const problems = await problemsFor({
    rules: rule({ url: runbookPath }),
    runbook: "# Runbook\n\nDemoAlert\n\n## Triage\n\nOnly this.\n",
  });
  assert.match(problems.join("\n"), /missing-section.*Recovery and evidence/);
});

test("a runbook that never names the alert is reported", async () => {
  const problems = await problemsFor({
    rules: rule({ url: runbookPath }),
    runbook: goodRunbook.replace("DemoAlert", "Something"),
  });
  assert.match(problems.join("\n"), /alert-not-in-runbook.*DemoAlert/);
});

test("missing severity and summary are reported", async () => {
  const problems = await problemsFor({
    rules: rule({ severity: false, summary: false, url: runbookPath }),
    runbook: goodRunbook,
  });
  const text = problems.join("\n");
  assert.match(text, /missing-severity.*DemoAlert/);
  assert.match(text, /missing-summary.*DemoAlert/);
});

test("the YAML subset parser reads block scalars and nested lists", () => {
  const doc = parseYaml(
    "a:\n  - name: x\n    expr: |\n      foo\n      bar\n    n: 'q'\n  - plain\n",
  );
  assert.deepEqual(doc, {
    a: [{ name: "x", expr: "foo\nbar\n", n: "q" }, "plain"],
  });
});
