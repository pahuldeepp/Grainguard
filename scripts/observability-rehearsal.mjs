import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTarget,
  serveTarget,
} from "../infra/observability/rehearsal/target.mjs";
import { loadAlerts } from "./observability-runbook-check.mjs";
import {
  SCENARIOS,
  forSeconds,
  formatTable,
  lagMetricName,
  prometheusConfig,
  rehearsalAlertmanager,
  scaleRulesText,
} from "./observability-rehearsal-lib.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OBS = join(ROOT, "infra/observability");
const GENERATED = join(OBS, "rehearsal/.generated");
const PROJECT = "greenguard-obs-rehearsal";
const env = process.env;
const FACTOR = Number(env.REHEARSAL_FACTOR ?? 60);
const PORTS = {
  prom: Number(env.REHEARSAL_PROM_PORT ?? 29090),
  am: Number(env.REHEARSAL_AM_PORT ?? 29093),
  target: Number(env.REHEARSAL_TARGET_PORT ?? 29100),
  hook: Number(env.REHEARSAL_HOOK_PORT ?? 29180),
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const now = () => performance.now() / 1000;

function startWebhook(received) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}");
      for (const alert of payload.alerts ?? []) {
        received.push({
          at: now(),
          status: alert.status,
          labels: alert.labels,
          annotations: alert.annotations,
        });
      }
      res.end("ok");
    });
  });
  return new Promise((done) =>
    server.listen(PORTS.hook, "127.0.0.1", () => done(server)),
  );
}

async function promAlerts() {
  const res = await fetch(`http://127.0.0.1:${PORTS.prom}/api/v1/alerts`);
  return (await res.json()).data.alerts;
}

async function waitFor(check, what, timeoutS) {
  const start = now();
  while (now() - start < timeoutS) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutS}s waiting for ${what}`);
}

function imageOf(compose, repo) {
  return new RegExp(`image:\\s*(${repo}:\\S+)`).exec(compose)[1];
}

function compose(args, images) {
  const composeEnv = {
    ...env,
    PROMETHEUS_IMAGE: images.prometheus,
    ALERTMANAGER_IMAGE: images.alertmanager,
    REHEARSAL_PROM_PORT: String(PORTS.prom),
    REHEARSAL_AM_PORT: String(PORTS.am),
  };
  const file = join(OBS, "rehearsal/compose.yaml");
  execFileSync("docker", ["compose", "-p", PROJECT, "-f", file, ...args], {
    env: composeEnv,
    stdio: "inherit",
  });
}

async function generate() {
  const platform = scaleRulesText(
    await readFile(join(OBS, "rules/platform.yaml"), "utf8"),
    FACTOR,
  );
  const brokers = scaleRulesText(
    await readFile(join(OBS, "rules/brokers.yaml"), "utf8"),
    FACTOR,
  );
  const slo = scaleRulesText(
    await readFile(join(OBS, "rules/slo.yaml"), "utf8"),
    FACTOR,
  );
  const am = rehearsalAlertmanager(
    await readFile(join(OBS, "alertmanager.yaml"), "utf8"),
    `http://host.docker.internal:${PORTS.hook}/alerts`,
  );
  await mkdir(join(GENERATED, "rules"), { recursive: true });
  await writeFile(join(GENERATED, "rules/platform.yaml"), platform);
  await writeFile(join(GENERATED, "rules/brokers.yaml"), brokers);
  await writeFile(join(GENERATED, "rules/slo.yaml"), slo);
  await writeFile(join(GENERATED, "alertmanager.yml"), am);
  await writeFile(
    join(GENERATED, "prometheus.yml"),
    prometheusConfig({ targetPort: PORTS.target }),
  );
  return `${platform}\n${brokers}\n${slo}`;
}

function control(scenario, mode) {
  return fetch(
    `http://127.0.0.1:${PORTS.target}/control?scenario=${scenario}&mode=${mode}`,
    { method: "POST" },
  );
}

function matches(item, alert, status) {
  return item.labels.alertname === alert && item.status === status;
}

async function assertDelivery(rule, delivered) {
  const { labels, annotations } = delivered;
  const want = {
    severity: rule.labels.severity,
    runbook: rule.annotations.runbook_url,
  };
  if (labels.severity !== want.severity)
    throw new Error(`severity ${labels.severity} != ${want.severity}`);
  if (annotations.runbook_url !== want.runbook)
    throw new Error("runbook_url differs from the rule");
  if (!existsSync(join(ROOT, want.runbook)))
    throw new Error(`runbook ${want.runbook} does not exist`);
}

async function fire(ctx, scenario, row) {
  const t0 = now();
  await control(scenario.control, "fail");
  const limit = ctx.forS + 30;
  await waitFor(
    async () =>
      (await promAlerts()).find((a) => a.labels.alertname === scenario.alert),
    "pending",
    limit,
  ).then((a) => {
    row.pending = now() - t0;
    return a;
  });
  await waitFor(
    async () =>
      (await promAlerts()).find(
        (a) => a.labels.alertname === scenario.alert && a.state === "firing",
      ),
    "firing",
    limit,
  );
  row.firing = now() - t0;
  if (row.firing - row.pending < ctx.forS - 1.5) {
    throw new Error(
      `fired ${(row.firing - row.pending).toFixed(1)}s after pending, before the ${ctx.forS}s for window`,
    );
  }
  const delivered = await waitFor(
    async () =>
      ctx.received.find(
        (r) => r.at >= t0 && matches(r, scenario.alert, "firing"),
      ),
    "webhook firing notification",
    limit,
  );
  row.notified = now() - t0;
  return delivered;
}

async function recover(ctx, scenario, row) {
  const t1 = now();
  await control(scenario.control, "heal");
  await waitFor(
    async () =>
      !(await promAlerts()).some((a) => a.labels.alertname === scenario.alert),
    "alert to leave Prometheus",
    60,
  );
  await waitFor(
    async () =>
      ctx.received.find(
        (r) => r.at >= t1 && matches(r, scenario.alert, "resolved"),
      ),
    "webhook resolved notification",
    90,
  );
  row.resolved = now() - t1;
  await waitFor(
    async () => (await promAlerts()).length === 0,
    "all alerts clear",
    60,
  );
}

async function rehearse(ctx, scenario, rule) {
  const row = { alert: scenario.alert, control: scenario.control };
  ctx.forS = forSeconds(ctx.scaled, scenario.alert);
  try {
    await assertDelivery(rule, await fire(ctx, scenario, row));
    await recover(ctx, scenario, row);
  } catch (error) {
    row.error = `FAILED: ${error.message}`;
    await control("reset", "heal");
    await sleep(20_000);
  }
  return row;
}

async function ready(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.ok;
}

async function start(images, received, rules) {
  const scaled = await generate();
  checkRules(images);
  const target = createTarget({
    lagMetric: lagMetricName(rules.get("DebeziumSourceLagHigh")),
  });
  const servers = [
    await serveTarget(target, PORTS.target),
    await startWebhook(received),
  ];
  compose(["up", "-d"], images);
  await waitFor(() => ready(PORTS.prom, "/-/ready"), "Prometheus ready", 60);
  await waitFor(() => ready(PORTS.am, "/-/ready"), "Alertmanager ready", 60);
  await waitFor(
    async () => (await promAlerts()).length === 0 && (await targetUp()),
    "healthy baseline",
    60,
  );
  return { scaled, servers };
}

async function targetUp() {
  const res = await fetch(
    `http://127.0.0.1:${PORTS.prom}/api/v1/query?query=up`,
  );
  const result = (await res.json()).data.result;
  return result.some((s) => s.value[1] === "1");
}

// Fail early and readably when the scaled copy of the rules does not parse.
function checkRules(images) {
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "promtool",
      "-v",
      `${GENERATED}/rules:/rules:ro`,
      images.prometheus,
      "check",
      "rules",
      "/rules/platform.yaml",
      "/rules/brokers.yaml",
      "/rules/slo.yaml",
    ],
    { stdio: "inherit" },
  );
}

async function stop(images, servers) {
  try {
    compose(["down", "-v"], images);
  } finally {
    for (const server of servers) await server.close();
    await rm(GENERATED, { recursive: true, force: true });
  }
}

async function main() {
  const mainCompose = await readFile(join(OBS, "compose.yaml"), "utf8");
  const images = {
    prometheus: imageOf(mainCompose, "prom/prometheus"),
    alertmanager: imageOf(mainCompose, "prom/alertmanager"),
  };
  const rules = new Map((await loadAlerts(ROOT)).map((a) => [a.alert, a]));
  const received = [];
  const ctx = { received };
  const rows = [];
  let servers = [];
  try {
    const started = await start(images, received, rules);
    servers = started.servers;
    ctx.scaled = started.scaled;
    for (const scenario of SCENARIOS)
      rows.push(await rehearse(ctx, scenario, rules.get(scenario.alert)));
  } finally {
    await stop(images, servers);
  }
  console.log(
    `\nRehearsal (time divisor ${FACTOR}, images ${images.prometheus}, ${images.alertmanager})\n`,
  );
  console.log(formatTable(rows));
  if (rows.some((r) => r.error)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
