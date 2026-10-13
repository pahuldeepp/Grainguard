import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve("infra/observability");
const dashboardDir = join(root, "grafana/dashboards");
const forbidden = new Set([
  "tenant_id",
  "device_id",
  "request_id",
  "event_id",
  "trace_id",
  "span_id",
  "email",
  "phone",
  "user_id",
  "customer_id",
]);
const dashboards = (await readdir(dashboardDir)).filter((name) =>
  name.endsWith(".json"),
);
if (dashboards.length < 3)
  throw new Error("Expected overview, service/dependency, and SLO dashboards");

for (const name of dashboards) {
  const dashboard = JSON.parse(
    await readFile(join(dashboardDir, name), "utf8"),
  );
  if (!dashboard.uid || !dashboard.title || !Array.isArray(dashboard.panels)) {
    throw new Error(`${name} is missing Grafana dashboard metadata`);
  }
  for (const panel of dashboard.panels) {
    for (const target of panel.targets ?? []) {
      const expr = String(target.expr ?? "");
      for (const label of forbidden) {
        if (
          new RegExp(
            `(?:^|[,{(])\\s*${label}\\s*=|by\\s*\\([^)]*\\b${label}\\b`,
            "i",
          ).test(expr)
        ) {
          throw new Error(
            `${name} panel ${panel.title} uses forbidden metric label ${label}`,
          );
        }
      }
    }
  }
}

const rules = await readFile(join(root, "rules/platform.yaml"), "utf8");
if (/tenant_id|device_id|request_id|event_id|trace_id|span_id/.test(rules)) {
  throw new Error(
    "Prometheus rules contain a forbidden high-cardinality identifier",
  );
}
const collector = await readFile(join(root, "otel-collector.yaml"), "utf8");
if (
  !/logs:\s*\n\s+receivers:\s*\[otlp\]/.test(collector) ||
  !/exporters:\s*\[otlphttp\/loki\]/.test(collector) ||
  !/endpoint:\s*http:\/\/loki:3100\/otlp/.test(collector)
) {
  throw new Error("OTLP logs must be exported to Loki's native OTLP endpoint");
}
for (const required of [
  "ObservabilityTargetDown",
  "APIHighServerErrorRate",
  "ProjectionFreshnessUnknown",
]) {
  if (!rules.includes(`alert: ${required}`))
    throw new Error(`Missing required alert ${required}`);
}

const docs = resolve("docs/runbooks");
for (const name of [
  "observability-target-down.md",
  "api-errors.md",
  "projection-freshness.md",
  "streaming-backlog.md",
  "database-saturation.md",
  "notification-delivery.md",
  "observability-backend.md",
]) {
  await readFile(join(docs, name));
}
await readFile(join(root, "tests/platform.test.yaml"));
console.log(
  `observability config validation passed: ${dashboards.length} dashboards, bounded-label audit, rules, and runbooks`,
);
