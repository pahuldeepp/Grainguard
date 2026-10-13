#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = resolve(root, "work");
const markerName = ".stage12-compose-gate.json";
const markerPrefix = "greenguard-stage12-";

export function createIsolatedMakefile(
  baseMakefile,
  { envPath, project, overlayPath },
) {
  const generatedMakefilePath = `work/${project}/Makefile`;
  return baseMakefile
    .replace("-include .env", `-include ${envPath}`)
    .replace(
      "COMPOSE = docker compose --env-file .env -f infra/compose/compose.yaml",
      `COMPOSE = docker compose --env-file ${envPath} -p ${project} -f infra/compose/compose.yaml -f ${overlayPath}`,
    )
    .replace(
      "RISK_VENV = .local/risk-venv",
      `RISK_VENV = work/${project}/risk-venv`,
    )
    .replaceAll("$(MAKE)", `$(MAKE) -f ${generatedMakefilePath}`);
}

export function configureIsolatedControlPlaneLookup(env, token) {
  env.set("CONTROL_PLANE_URL", "http://127.0.0.1:3010");
  env.set("CONTROL_LOOKUP_TOKEN", token);
  return env;
}

function fail(message) {
  console.error(`stage12-compose-gate: ${message}`);
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function parsedExample() {
  return readFileSync(resolve(root, ".env.example"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return at < 1 ? null : [line.slice(0, at), line.slice(at + 1)];
    })
    .filter(Boolean);
}

const dbUsers = {
  inventory_app: "INVENTORY_DB_PASSWORD",
  inventory_projector: "INVENTORY_PROJECTOR_PASSWORD",
  telemetry_app: "TELEMETRY_DB_PASSWORD",
  telemetry_entitlement_projector: "TELEMETRY_ENTITLEMENT_PROJECTOR_PASSWORD",
  projection_app: "PROJECTION_DB_PASSWORD",
  read_entitlement_projector: "READ_ENTITLEMENT_PROJECTOR_PASSWORD",
  read_query: "READ_QUERY_DB_PASSWORD",
  risk_app: "RISK_DB_PASSWORD",
  jobs_app: "JOBS_DB_PASSWORD",
  notifications_app: "NOTIFICATIONS_DB_PASSWORD",
  alerts_app: "ALERTS_DB_PASSWORD",
  saga_app: "SAGA_DB_PASSWORD",
  hardware_app: "HARDWARE_DB_PASSWORD",
  control_app: "CONTROL_DB_PASSWORD",
  control_entitlement_projector: "CONTROL_ENTITLEMENT_PROJECTOR_PASSWORD",
  billing_app: "BILLING_DB_PASSWORD",
};

async function prepare() {
  mkdirSync(workRoot, { recursive: true });
  const suffix = randomBytes(5).toString("hex");
  const project = `${markerPrefix}${suffix}`;
  const dir = resolve(workRoot, project);
  mkdirSync(dir, { mode: 0o700 });
  const directPort = await freePort();
  let pooledPort = await freePort();
  while (pooledPort === directPort) pooledPort = await freePort();
  const password = randomBytes(32).toString("hex");
  const env = new Map(
    parsedExample().map(([key, value]) => [
      key,
      value
        .replaceAll("replace_me", password)
        .replaceAll("127.0.0.1:55432", `127.0.0.1:${directPort}`)
        .replaceAll("127.0.0.1:56432", `127.0.0.1:${pooledPort}`),
    ]),
  );
  env.set("JOBS_NOTIFICATION_CURSOR_KEY", randomBytes(32).toString("hex"));
  env.set("NOTIFICATIONS_AUDIT_HMAC_KEY", randomBytes(32).toString("hex"));
  configureIsolatedControlPlaneLookup(
    env,
    randomBytes(48).toString("base64url"),
  );
  env.set("RABBITMQ_URL", "");
  const envPath = resolve(dir, "stage12.env");
  writeFileSync(
    envPath,
    [...env].map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );

  const userlistPath = resolve(dir, "userlist.txt");
  writeFileSync(
    userlistPath,
    Object.entries(dbUsers)
      .map(([user, key]) => `"${user}" "${env.get(key)}"`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const overlayPath = resolve(dir, "compose.override.yaml");
  writeFileSync(
    overlayPath,
    `services:\n  postgres:\n    ports: !override\n      - "127.0.0.1:${directPort}:5432"\n  pgbouncer:\n    ports: !override\n      - "127.0.0.1:${pooledPort}:6432"\n    volumes:\n      - "${userlistPath}:/run/pgbouncer/userlist.txt:ro"\n`,
    { mode: 0o600, flag: "wx" },
  );

  const baseMakefile = readFileSync(resolve(root, "Makefile"), "utf8");
  const isolatedMakefile = createIsolatedMakefile(baseMakefile, {
    envPath,
    project,
    overlayPath,
  });
  if (
    isolatedMakefile === baseMakefile ||
    /^COMPOSE = docker compose --env-file \.env /m.test(isolatedMakefile)
  ) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("could not construct an isolated Makefile");
  }
  const makefilePath = resolve(dir, "Makefile");
  writeFileSync(makefilePath, isolatedMakefile, { mode: 0o600, flag: "wx" });
  writeFileSync(
    resolve(dir, markerName),
    JSON.stringify(
      {
        format: 1,
        project,
        envPath,
        overlayPath,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return { dir, project, makefilePath, envPath };
}

function loadState(dirArg) {
  const dir = resolve(root, dirArg);
  const markerPath = resolve(dir, markerName);
  if (!existsSync(markerPath))
    fail(`refusing: missing ownership marker in ${dir}`);
  const state = JSON.parse(readFileSync(markerPath, "utf8"));
  if (
    state.format !== 1 ||
    !state.project?.startsWith(markerPrefix) ||
    resolve(dir) !== resolve(workRoot, state.project) ||
    resolve(state.envPath) !== resolve(dir, "stage12.env") ||
    resolve(state.overlayPath) !== resolve(dir, "compose.override.yaml")
  ) {
    fail(`refusing: isolation marker does not match this generated workspace`);
  }
  return { dir, state, makefilePath: resolve(dir, "Makefile") };
}

function composeFor({ state }) {
  return [
    "compose",
    "--env-file",
    state.envPath,
    "-p",
    state.project,
    "-f",
    resolve(root, "infra/compose/compose.yaml"),
    "-f",
    state.overlayPath,
  ];
}

async function main() {
  const [action = "help", ...args] = process.argv.slice(2);
  if (action === "help" || action === "--help") {
    console.log(`Usage:
  node scripts/stage12-compose-gate.mjs run [--keep]
  node scripts/stage12-compose-gate.mjs status <work/stage12-compose-...>
  node scripts/stage12-compose-gate.mjs cleanup <work/stage12-compose-...>

run creates a fresh, uniquely named Compose project, env file, database volume,
and risk venv under work/. It runs make verify then make smoke. It never sources
the repository .env. Successful runs are cleaned automatically; on failure the
stack is retained for diagnosis. --keep retains it after success as well.
`);
    return;
  }
  if (action === "run") {
    const keep = args.includes("--keep");
    const isolation = await prepare();
    const loaded = loadState(isolation.dir);
    console.log(`Isolated Stage 12 project: ${loaded.state.project}`);
    console.log(`Evidence/workspace: ${loaded.dir}`);
    console.log("Running the full local verify target, then runtime smoke...");
    try {
      run("make", ["-f", loaded.makefilePath, "verify"], {
        env: { ...process.env, GREENGUARD_ENV_FILE: loaded.envPath },
      });
      run("make", ["-f", loaded.makefilePath, "smoke"], {
        env: { ...process.env, GREENGUARD_ENV_FILE: loaded.envPath },
      });
      if (!keep) {
        run("docker", [
          ...composeFor(loaded),
          "down",
          "--volumes",
          "--remove-orphans",
        ]);
        rmSync(loaded.dir, { recursive: true, force: true });
        console.log(
          "PASS: isolated Compose verification and smoke; project and volume removed.",
        );
      } else {
        console.log(
          "PASS: isolated Compose verification and smoke; stack retained by request.",
        );
        console.log(
          `Cleanup: node scripts/stage12-compose-gate.mjs cleanup ${loaded.dir}`,
        );
      }
    } catch (error) {
      console.error(`FAIL: ${error.message}`);
      console.error(
        `Stack retained for inspection. Cleanup: node scripts/stage12-compose-gate.mjs cleanup ${loaded.dir}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (action === "status" || action === "cleanup") {
    if (args.length !== 1)
      fail(`${action} requires one generated work directory`);
    const loaded = loadState(args[0]);
    if (action === "status") {
      run("docker", [...composeFor(loaded), "ps", "--all"]);
      return;
    }
    run("docker", [
      ...composeFor(loaded),
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
    rmSync(loaded.dir, { recursive: true, force: true });
    console.log(
      `Cleaned only owned project ${loaded.state.project} and its project volume.`,
    );
    return;
  }
  fail(`unknown action ${action}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
