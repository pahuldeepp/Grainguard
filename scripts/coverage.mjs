import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
function run(cmd, args, cwd = process.cwd()) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error || r.status !== 0) process.exit(r.status || 1);
}
mkdirSync("coverage", { recursive: true });
run("npm", ["run", "coverage", "--workspaces"]);
for (const workspace of [
  "apps/dashboard",
  "packages/tenant-auth",
  "packages/contracts",
  "services/device-service",
]) {
  const filename = `${workspace}/coverage/lcov.info`;
  const normalized = readFileSync(filename, "utf8").replace(
    /^SF:(.+)$/gm,
    (_, file) =>
      `SF:${path.relative(process.cwd(), path.resolve(workspace, file)).split(path.sep).join("/")}`,
  );
  if (!normalized.includes("SF:"))
    throw new Error(`Empty coverage report: ${filename}`);
  writeFileSync(filename, normalized);
}
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/go.raw.out",
    "./...",
  ],
  "services/telemetry-ingest",
);
const raw = readFileSync("coverage/go.raw.out", "utf8");
writeFileSync(
  "coverage/go.out",
  raw.replaceAll(
    "greenguard.local/telemetry-ingest/",
    "services/telemetry-ingest/",
  ),
);
console.log("Coverage reports ready for SonarQube.");
