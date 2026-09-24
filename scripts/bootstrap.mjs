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
secret("CDC_DB_PASSWORD");
const admin = secret("POSTGRES_PASSWORD");
const inventory = secret("INVENTORY_DB_PASSWORD");
const migrator = secret("INVENTORY_MIGRATOR_PASSWORD");
const telemetry = secret("TELEMETRY_DB_PASSWORD");
const telemetryMigrator = secret("TELEMETRY_MIGRATOR_PASSWORD");
const projection = secret("PROJECTION_DB_PASSWORD");
const readQuery = secret("READ_QUERY_DB_PASSWORD");
const projectionMigrator = secret("PROJECTION_MIGRATOR_PASSWORD");
const risk = secret("RISK_DB_PASSWORD");
const riskMigrator = secret("RISK_MIGRATOR_PASSWORD");
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
  `postgresql://telemetry_app:${telemetry}@${pooled}/greenguard_telemetry`,
);
env.set(
  "TELEMETRY_DIRECT_URL",
  `postgresql://telemetry_app:${telemetry}@${direct}/greenguard_telemetry`,
);
env.set(
  "TELEMETRY_MIGRATION_URL",
  `postgresql://telemetry_migrator:${telemetryMigrator}@${direct}/greenguard_telemetry`,
);
env.set(
  "POSTGRES_ADMIN_URL",
  `postgresql://postgres:${admin}@${direct}/postgres`,
);
env.set(
  "PROJECTION_DATABASE_URL",
  `postgresql://projection_app:${projection}@${pooled}/greenguard_read`,
);
env.set(
  "PROJECTION_DIRECT_URL",
  `postgresql://projection_app:${projection}@${direct}/greenguard_read`,
);
env.set(
  "PROJECTION_MIGRATION_URL",
  `postgresql://projection_migrator:${projectionMigrator}@${direct}/greenguard_read`,
);
env.set(
  "READ_QUERY_DATABASE_URL",
  `postgresql://read_query:${readQuery}@${pooled}/greenguard_read`,
);
env.set(
  "RISK_DATABASE_URL",
  `postgresql://risk_app:${risk}@${pooled}/greenguard_risk`,
);
env.set(
  "RISK_DIRECT_URL",
  `postgresql://risk_app:${risk}@${direct}/greenguard_risk`,
);
env.set(
  "RISK_MIGRATION_URL",
  `postgresql://risk_migrator:${riskMigrator}@${direct}/greenguard_risk`,
);
// Stage 06d owners: JOBS_* (greenguard_jobs) and NOTIFICATIONS_* (greenguard_notifications).
const stage06dUsers = [];
for (const [prefix, role, db] of [
  ["JOBS", "jobs", "greenguard_jobs"],
  ["NOTIFICATIONS", "notifications", "greenguard_notifications"],
  // Stage 06b workflow-alerts owner (greenguard_alerts).
  ["ALERTS", "alerts", "greenguard_alerts"],
]) {
  const app = secret(`${prefix}_DB_PASSWORD`);
  const owner = secret(`${prefix}_MIGRATOR_PASSWORD`);
  env.set(
    `${prefix}_DATABASE_URL`,
    `postgresql://${role}_app:${app}@${pooled}/${db}`,
  );
  env.set(
    `${prefix}_DIRECT_URL`,
    `postgresql://${role}_app:${app}@${direct}/${db}`,
  );
  env.set(
    `${prefix}_MIGRATION_URL`,
    `postgresql://${role}_migrator:${owner}@${direct}/${db}`,
  );
  stage06dUsers.push(`"${role}_app" "${app}"\n`);
}
env.set(
  "RABBITMQ_URL",
  `amqp://greenguard:${secret("RABBITMQ_PASSWORD")}@127.0.0.1:55672/`,
);
writeFileSync(".env", [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", {
  mode: 0o600,
});
mkdirSync(".local/pgbouncer", { recursive: true });
writeFileSync(
  ".local/pgbouncer/userlist.txt",
  `"inventory_app" "${inventory}"\n"telemetry_app" "${telemetry}"\n"projection_app" "${projection}"\n"read_query" "${readQuery}"\n"risk_app" "${risk}"\n` +
    stage06dUsers.join(""),
  { mode: 0o644 },
);
console.log("Local .env and PgBouncer user list are ready.");
run("npm", ["ci"]);
run("go", ["mod", "download"], "services/telemetry-ingest");

run("go", ["mod", "download"], "services/projection-builder");
