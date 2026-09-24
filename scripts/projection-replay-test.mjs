import { spawnSync } from "node:child_process";

for (const key of [
  "POSTGRES_ADMIN_URL",
  "PROJECTION_MIGRATION_URL",
  "PROJECTION_DIRECT_URL",
]) {
  if (!process.env[key]) {
    console.error(`${key} is required; load the local .env before running`);
    process.exit(2);
  }
}
const result = spawnSync(
  "go",
  [
    "test",
    "-race",
    "-count=1",
    "-v",
    "-run",
    "^Test(GlobalVersionedReplayFromZero|Live(DatabaseReplayResume|VersionedReplay))$",
    ".",
  ],
  {
    cwd: new URL("../services/projection-builder/", import.meta.url),
    env: {
      ...process.env,
      PROJECTION_LIVE_REPLAY: "1",
      PROJECTION_LIVE_VERSION_REPLAY: "1",
      KAFKA_BROKERS: process.env.KAFKA_BROKERS || "127.0.0.1:59092",
    },
    stdio: "inherit",
  },
);
if (result.error) console.error("Unable to start live replay acceptance");
process.exit(result.status ?? 1);
