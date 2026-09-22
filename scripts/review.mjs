import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const settings = existsSync(".local/tooling.json")
  ? JSON.parse(readFileSync(".local/tooling.json", "utf8"))
  : {};
const executable =
  process.env.CODERABBIT_BIN || settings.coderabbit || "coderabbit";
const extra = process.argv.slice(2);
const args = extra.length ? extra : ["--uncommitted", "--base", "main"];
const result = spawnSync(executable, ["review", "--agent", ...args], {
  stdio: "inherit",
});
if (result.error)
  throw new Error(
    "CodeRabbit CLI not found. Install it from https://docs.coderabbit.ai/cli or set CODERABBIT_BIN.",
  );
process.exit(result.status ?? 1);
