import { createHash } from "node:crypto";

export function ciComposeProjectName(env) {
  if (env.GITHUB_ACTIONS !== "true") return undefined;
  if (!env.RUNNER_TEMP)
    throw new Error("RUNNER_TEMP is required to isolate CI Compose resources");
  const suffix = createHash("sha256")
    .update(env.RUNNER_TEMP)
    .digest("hex")
    .slice(0, 12);
  return `greenguard-ci-${suffix}`;
}

export function composeContainerName(service, env = process.env) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(service))
    throw new Error(`Invalid Compose service name: ${service}`);
  const project = env.COMPOSE_PROJECT_NAME || "greenguard-dev";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project))
    throw new Error("Invalid COMPOSE_PROJECT_NAME");
  return `${project}-${service}-1`;
}
