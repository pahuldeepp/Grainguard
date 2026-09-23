import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const env = new Map();
if (existsSync(".env"))
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
  }
const secret = (key) => {
  if (!env.get(key)) env.set(key, randomBytes(24).toString("hex"));
  return env.get(key);
};
const admin = secret("POSTGRES_PASSWORD");
const inventory = secret("INVENTORY_DB_PASSWORD");
const migrator = secret("INVENTORY_MIGRATOR_PASSWORD");
const telemetry = secret("TELEMETRY_DB_PASSWORD");
const direct = "127.0.0.1:55432";
const pooled = "127.0.0.1:56432";
env.set(
  "INVENTORY_DATABASE_URL",
  `postgresql://inventory_app:${inventory}@${pooled}/greenguard_inventory`,
);
env.set(
  "INVENTORY_DIRECT_URL",
  `postgresql://inventory_app:${inventory}@${direct}/greenguard_inventory`,
);
env.set(
  "INVENTORY_MIGRATION_URL",
  `postgresql://inventory_migrator:${migrator}@${direct}/greenguard_inventory`,
);
env.set(
  "TELEMETRY_DATABASE_URL",
  `postgresql://telemetry_app:${telemetry}@${direct}/greenguard_telemetry`,
);
env.set(
  "POSTGRES_ADMIN_URL",
  `postgresql://postgres:${admin}@${direct}/postgres`,
);
writeFileSync(".env", [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", {
  mode: 0o600,
});
mkdirSync(".local/pgbouncer", { recursive: true });
writeFileSync(
  ".local/pgbouncer/userlist.txt",
  `"inventory_app" "${inventory}"\n`,
  { mode: 0o644 },
);
console.log("Local .env and PgBouncer user list are ready.");
run("npm", ["ci"]);
run("go", ["mod", "download"], "services/telemetry-ingest");
