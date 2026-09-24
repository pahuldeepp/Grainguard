import { spawnSync } from "node:child_process";

// Provision/migrate the shadow separately. No credential or SQL is logged.
const [action, tenant, ...flags] = process.argv.slice(2);
const versionFlag = flags.indexOf("--version");
const version = versionFlag >= 0 ? flags[versionFlag + 1] : undefined;
const extra = flags.filter(
  (flag, i) =>
    flag !== "--dry-run" &&
    (versionFlag < 0 || (i !== versionFlag && i !== versionFlag + 1)),
);
if (
  !["rebuild", "status", "compare"].includes(action) ||
  !tenant ||
  extra.length > 0 ||
  (versionFlag >= 0 && !/^[1-9][0-9]{0,8}$/.test(version ?? ""))
) {
  console.error(
    "Usage: node --env-file=.env scripts/projection-replay.mjs <rebuild|status|compare> <tenant UUID> [--version N] [--dry-run]",
  );
  process.exit(2);
}
const result = spawnSync("go", ["run", "."], {
  cwd: new URL("../services/projection-builder/", import.meta.url),
  env: {
    ...process.env,
    PROJECTION_MODE: "replay",
    PROJECTION_REPLAY_ACTION: action,
    PROJECTION_REPLAY_TENANT: tenant,
    PROJECTION_REPLAY_SCHEMA: version ? `read_v${version}` : "",
    PROJECTION_REPLAY_DRY_RUN: flags.includes("--dry-run") ? "1" : "0",
  },
  stdio: "inherit",
});
if (result.error) console.error("Unable to start projection replay");
process.exit(result.status ?? 1);
