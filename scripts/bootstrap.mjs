import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const run = (cmd, args, cwd = process.cwd()) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error || r.status !== 0) process.exit(r.status || 1);
};
const expected = readFileSync(".nvmrc", "utf8").trim();
if (process.versions.node !== expected)
  throw new Error(`Use Node ${expected} from .nvmrc`);
run("go", ["version"]);
run("docker", ["compose", "version"]);
if (!existsSync(".env")) {
  const admin = randomBytes(24).toString("hex"),
    inventory = randomBytes(24).toString("hex"),
    telemetry = randomBytes(24).toString("hex");
  writeFileSync(
    ".env",
    `POSTGRES_PASSWORD=${admin}
INVENTORY_DB_PASSWORD=${inventory}
TELEMETRY_DB_PASSWORD=${telemetry}
INVENTORY_DATABASE_URL=postgresql://inventory_app:${inventory}@127.0.0.1:55432/greenguard_inventory
TELEMETRY_DATABASE_URL=postgresql://telemetry_app:${telemetry}@127.0.0.1:55432/greenguard_telemetry
`,
    { mode: 0o600, flag: "wx" },
  );
  console.log("Created private local .env.");
}
run("npm", ["ci"]);
run("go", ["mod", "download"], "services/telemetry-ingest");
