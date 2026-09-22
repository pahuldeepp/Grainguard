import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const statePath = ".local/deployment.json";
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const requested = process.argv[2];
const revision =
  requested === "rollback" ? state.previous?.revision : requested;
if (!/^[a-f0-9]{40}$/.test(revision || ""))
  throw new Error(
    "Provide a full successful main commit SHA, or rollback after two successful deployments.",
  );
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${cmd} failed (${result.status})`);
  return result.stdout;
}
const capture = { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
const raw = run(
  "gh",
  [
    "api",
    `repos/pahuldeepp/Grainguard/actions/workflows/ci.yml/runs?head_sha=${revision}&event=push&status=success`,
  ],
  capture,
);
if (
  !JSON.parse(raw).workflow_runs.some(
    (r) =>
      r.head_sha === revision &&
      r.head_branch === "main" &&
      r.conclusion === "success",
  )
)
  throw new Error(
    "No successful main CI + image publication for this commit. Deployment blocked.",
  );
mkdirSync(".local", { recursive: true });
const env = {
  ...process.env,
  IMAGE_PREFIX: "ghcr.io/pahuldeepp/grainguard",
  IMAGE_TAG: revision,
};
const base = [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "infra/staging/compose.yaml",
];
let images;
if (requested === "rollback") {
  images = state.previous.images;
} else {
  run("docker", [...base, "pull"], { env });
  images = {};
  for (const service of ["dashboard", "device-service", "telemetry-ingest"]) {
    const repository = `${env.IMAGE_PREFIX}/${service}`;
    const inspected = JSON.parse(
      run("docker", ["image", "inspect", `${repository}:${revision}`], capture),
    );
    const digest = inspected[0].RepoDigests.find((value) =>
      value.startsWith(repository + "@sha256:"),
    );
    if (!digest)
      throw new Error(`Missing immutable image digest for ${service}`);
    images[service] = { image: digest };
  }
}
const override = ".local/deployment-images.json";
function activate(selection, pull = false) {
  writeFileSync(
    override,
    JSON.stringify({ services: selection }, null, 2) + "\n",
    { mode: 0o600 },
  );
  const compose = [...base, "-f", override];
  if (pull) run("docker", [...compose, "pull"], { env });
  run("docker", [...compose, "up", "-d", "--no-build", "--wait"], { env });
  run("node", ["scripts/staging-check.mjs"]);
}
try {
  activate(images, requested === "rollback");
} catch (error) {
  if (state.current) {
    console.error(
      "Readiness failed; restoring previous successful image digests.",
    );
    activate(state.current.images, true);
  }
  throw error;
}
writeFileSync(
  statePath,
  JSON.stringify(
    {
      current: { revision, images },
      previous:
        state.current?.revision === revision
          ? state.previous
          : state.current || null,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log(`Deployed verified release ${revision} to http://127.0.0.1:5174`);
