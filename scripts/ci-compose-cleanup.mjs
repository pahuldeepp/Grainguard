import { spawnSync } from "node:child_process";

if (process.env.GITHUB_ACTIONS !== "true") {
  console.log("CI Compose cleanup skipped outside GitHub Actions.");
  process.exit(0);
}

const project = process.env.COMPOSE_PROJECT_NAME;
if (!/^greenguard-ci-[a-f0-9]{12}$/.test(project ?? "")) {
  console.log(
    "CI Compose cleanup skipped: no job-scoped GreenGuard project was initialized.",
  );
  process.exit(0);
}

function ids(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw (
      result.error ??
      new Error(result.stderr || `docker ${args.join(" ")} failed`)
    );
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function remove(listArgs, removeArgs) {
  const resources = ids(listArgs);
  if (resources.length === 0) return;
  const result = spawnSync("docker", [...removeArgs, ...resources], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error || result.status !== 0)
    throw (
      result.error ?? new Error(`Could not remove CI ${kind} for ${project}`)
    );
}

const projectLabel = `label=com.docker.compose.project=${project}`;
remove(["ps", "--all", "--quiet", "--filter", projectLabel], ["rm", "--force"]);
remove(
  ["volume", "ls", "--quiet", "--filter", projectLabel],
  ["volume", "rm", "--force"],
);
remove(
  ["network", "ls", "--quiet", "--filter", projectLabel],
  ["network", "rm"],
);
console.log(`Removed Compose resources for ${project}.`);
