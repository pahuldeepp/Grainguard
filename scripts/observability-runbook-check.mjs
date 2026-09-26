import { readdir, readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./observability-yaml.mjs";

// The two heading conventions present in docs/runbooks: a runbook must
// contain every heading of at least one of them.
export const SECTION_CONVENTIONS = [
  ["Triage", "Recovery and evidence"],
  ["Symptom", "Diagnosis", "Mitigation", "Escalation"],
];
const RUNBOOK_DIR = "docs/runbooks";

export async function loadAlerts(root) {
  const dir = join(root, "infra/observability/rules");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  const alerts = [];
  for (const file of files) {
    const doc = parseYaml(await readFile(join(dir, file), "utf8"));
    for (const group of doc?.groups ?? []) {
      for (const rule of group.rules ?? []) {
        if (rule.alert) alerts.push({ ...rule, file });
      }
    }
  }
  return alerts;
}

function headings(markdown) {
  return new Set(
    [...markdown.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) => m[1]),
  );
}

function checkLabels(alert) {
  const where = `${alert.alert} (${alert.file})`;
  const problems = [];
  if (!alert.labels?.severity) problems.push(`[missing-severity] ${where}`);
  if (!alert.annotations?.summary) problems.push(`[missing-summary] ${where}`);
  if (!alert.annotations?.runbook_url) {
    problems.push(`[missing-runbook-url] ${where}`);
  }
  return problems;
}

async function readRunbook(root, url) {
  const relative = normalize(url);
  if (!relative.startsWith(`${RUNBOOK_DIR}/`)) return null;
  try {
    return await readFile(resolve(root, relative), "utf8");
  } catch {
    return null;
  }
}

function missingSections(found) {
  const misses = SECTION_CONVENTIONS.map((convention) =>
    convention.filter((section) => !found.has(section)),
  );
  return misses.reduce((best, m) => (m.length < best.length ? m : best));
}

function checkRunbookText(alert, text) {
  const problems = [];
  const url = alert.annotations.runbook_url;
  for (const section of missingSections(headings(text))) {
    problems.push(`[missing-section] ${alert.alert}: "${section}" in ${url}`);
  }
  if (!text.includes(alert.alert)) {
    problems.push(
      `[alert-not-in-runbook] ${alert.alert} is not named in ${url}`,
    );
  }
  return problems;
}

async function checkAlert(root, alert) {
  const problems = checkLabels(alert);
  const url = alert.annotations?.runbook_url;
  if (!url) return problems;
  const text = await readRunbook(root, url);
  if (text === null) {
    problems.push(
      `[dangling-runbook] ${alert.alert}: ${url} does not resolve to a file under ${RUNBOOK_DIR}`,
    );
    return problems;
  }
  return [...problems, ...checkRunbookText(alert, text)];
}

export async function checkRunbooks({ root }) {
  const alerts = await loadAlerts(root);
  const problems = [];
  for (const alert of alerts) problems.push(...(await checkAlert(root, alert)));
  return { alerts: alerts.length, problems };
}

async function main() {
  const { alerts, problems } = await checkRunbooks({ root: resolve(".") });
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      `Runbook check failed: ${problems.length} problem(s) across ${alerts} alert(s).`,
    );
    process.exit(1);
  }
  console.log(
    `Runbook check passed: ${alerts} alert(s) have complete runbooks.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
