import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("python3", [
  "-m",
  "unittest",
  "discover",
  "-s",
  "services/search-indexer",
  "-v",
]);
process.env.SEARCH_ALIAS = `greenguard-inventory-test-${process.pid}`;
run("python3", ["services/search-indexer/live_test.py"]);
if (process.env.SEARCH_KAFKA_LIVE === "1") {
  run(".local/search-venv/bin/python", [
    "services/search-indexer/live_kafka_test.py",
  ]);
}
