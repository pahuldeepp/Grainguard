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
