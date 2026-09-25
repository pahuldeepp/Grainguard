import { existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const command = process.argv[2];
if (!["up", "init", "scan", "down"].includes(command))
  throw new Error("Use sonar.mjs up|init|scan|down");
if (!existsSync(".env.sonar")) {
  writeFileSync(
    ".env.sonar",
    `SONAR_DB_PASSWORD=${randomBytes(24).toString("hex")}
SONAR_ADMIN_PASSWORD=Gg1!${randomBytes(24).toString("hex")}
`,
    { mode: 0o600, flag: "wx" },
  );
}
process.loadEnvFile(".env.sonar");
const host = "http://127.0.0.1:9000";
function compose(args, failOnError = true) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      ".env.sonar",
      "-f",
      "infra/sonar/compose.yaml",
      ...args,
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (failOnError && result.status !== 0) process.exit(result.status || 1);
  return result.status || 0;
}
async function api(
  route,
  params = {},
  password = process.env.SONAR_ADMIN_PASSWORD,
  method = "POST",
) {
  const query = new URLSearchParams(params);
  const response = await fetch(
    `${host}/api/${route}${method === "GET" ? "?" + query : ""}`,
    {
      method,
      headers: {
        Authorization:
          "Basic " + Buffer.from("admin:" + password).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: method === "GET" ? undefined : query,
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(`SonarQube ${route} returned HTTP ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : {};
}
if (command === "down") {
  compose(["down"]);
  process.exit(0);
}
if (command === "up") {
  compose(["up", "-d", "database", "sonarqube"]);
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try {
      const response = await fetch(host + "/api/system/status", {
        signal: AbortSignal.timeout(2000),
      });
      if ((await response.json()).status === "UP") {
        ready = true;
        break;
      }
    } catch {
      /* Server starts asynchronously. */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ready) {
    compose(["ps", "-a"], false);
    compose(["logs", "--tail", "120", "database", "sonarqube"], false);
    throw new Error("SonarQube did not become ready; inspect Compose logs.");
  }
  console.log("SonarQube ready at " + host);
  process.exit(0);
}
if (command === "init") {
  const valid = await api(
    "authentication/validate",
    {},
    process.env.SONAR_ADMIN_PASSWORD,
    "GET",
  );
  if (!valid.valid)
    await api(
      "users/change_password",
      {
        login: "admin",
        previousPassword: "admin",
        password: process.env.SONAR_ADMIN_PASSWORD,
      },
      "admin",
    );
  const found = await api(
    "projects/search",
    { projects: "grainguard" },
    undefined,
    "GET",
  );
  if (found.components.length === 0)
    await api("projects/create", {
      project: "grainguard",
      name: "Grainguard",
      visibility: "private",
    });
  const gates = await api("qualitygates/list", {}, undefined, "GET");
  const gate = gates.qualitygates.find((g) => g.name === "Grainguard strict");
  if (!gate) await api("qualitygates/create", { name: "Grainguard strict" });
  const detail = await api(
    "qualitygates/show",
    { name: "Grainguard strict" },
    undefined,
    "GET",
  );
  // Overall gates make first/full scans meaningful even in a fresh CI instance.
  const conditions = [
    ["coverage", "LT", "80"],
    ["duplicated_lines_density", "GT", "0"],
    ["violations", "GT", "0"],
    ["security_hotspots_reviewed", "LT", "100"],
    ["new_coverage", "LT", "80"],
    ["new_duplicated_lines_density", "GT", "0"],
  ];
  for (const [metric, op, error] of conditions) {
    const existing = detail.conditions.find((c) => c.metric === metric);
    await api(
      existing
        ? "qualitygates/update_condition"
        : "qualitygates/create_condition",
      {
        ...(existing
          ? { id: String(existing.id) }
          : { gateName: "Grainguard strict" }),
        metric,
        op,
        error,
      },
    );
  }
  await api("qualitygates/select", {
    projectKey: "grainguard",
    gateName: "Grainguard strict",
  });
  await api("settings/set", {
    component: "grainguard",
    key: "sonar.qualitygate.ignoreSmallChanges",
    value: "false",
  });
  if (!process.env.SONAR_TOKEN) {
    const token = await api("user_tokens/generate", {
      name: "grainguard-local-" + Date.now(),
      type: "PROJECT_ANALYSIS_TOKEN",
      projectKey: "grainguard",
    });
    appendFileSync(
      ".env.sonar",
      `SONAR_TOKEN=${token.token}
`,
    );
  }
  console.log(
    "Private project and strict gate configured. Credentials are in ignored .env.sonar (mode 0600).",
  );
  process.exit(0);
}
if (!process.env.SONAR_TOKEN) throw new Error("Run make sonar-init first");
for (const f of [
  "apps/dashboard/coverage/lcov.info",
  "services/device-service/coverage/lcov.info",
  "coverage/go.out",
])
  if (!existsSync(f)) throw new Error(`Missing ${f}; run make coverage`);
mkdirSync(".scannerwork", { recursive: true, mode: 0o777 });
const scanExit = compose(["run", "--rm", "scanner"], false);
const gateStatus = await api(
  "qualitygates/project_status",
  { projectKey: "grainguard" },
  undefined,
  "GET",
);
const measures = await api(
  "measures/component",
  {
    component: "grainguard",
    metricKeys:
      "coverage,line_coverage,branch_coverage,violations,security_hotspots,duplicated_lines_density",
  },
  undefined,
  "GET",
);
mkdirSync("coverage", { recursive: true });
writeFileSync(
  "coverage/sonar-quality-gate.json",
  JSON.stringify(
    { gate: gateStatus.projectStatus, measures: measures.component.measures },
    null,
    2,
  ) + "\n",
);
const hotspots = measures.component.measures.find(
  (m) => m.metric === "security_hotspots",
);
if (
  scanExit !== 0 ||
  gateStatus.projectStatus.status !== "OK" ||
  !hotspots ||
  Number(hotspots.value) !== 0
)
  process.exit(scanExit || 1);
console.log("SonarQube gate passed; zero security hotspots confirmed.");
