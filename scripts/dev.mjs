import { spawn } from "node:child_process";
process.loadEnvFile(".env");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 3000).unref();
  process.exitCode = code;
}
function launch(cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: "inherit", env: process.env });
  children.push(child);
  child.on("error", () => stop(1));
  child.on("exit", (code) => {
    if (!stopping) stop(code || 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
launch("../../build/telemetry-ingest", [], "services/telemetry-ingest");
launch("node", ["--watch", "dist/main.js"], "services/device-service");
launch(
  "node",
  ["../../node_modules/typescript/bin/tsc", "--watch"],
  "services/device-service",
);
launch(
  "node",
  ["../../node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  "apps/dashboard",
);
console.log(
  "GreenGuard dashboard: http://127.0.0.1:5173 — Ctrl+C stops app services; make db-down stops PostgreSQL.",
);
