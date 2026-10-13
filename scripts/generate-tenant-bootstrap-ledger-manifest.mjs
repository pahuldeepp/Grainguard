#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const OWNERS = {
  telemetry: {
    database: "greenguard_telemetry",
    service: "services/telemetry-ingest/migrations",
    ledger: "golang-migrate",
  },
  projection: {
    database: "greenguard_read",
    service: "services/projection-builder/migrations",
    ledger: "golang-migrate",
  },
  jobs: {
    database: "greenguard_jobs",
    service: "services/jobs-worker/migrations",
    ledger: "golang-migrate",
  },
  saga: {
    database: "greenguard_sagas",
    service: "services/saga-orchestrator/migrations",
    ledger: "golang-migrate",
  },
  hardware: {
    database: "greenguard_hardware",
    service: "services/hardware-service/migrations",
    ledger: "golang-migrate",
  },
  inventory: {
    database: "greenguard_inventory",
    service: "services/device-service/prisma/migrations",
    ledger: "prisma",
  },
  alerts: {
    database: "greenguard_alerts",
    service: "services/workflow-alerts/prisma/migrations",
    ledger: "prisma",
  },
  risk: {
    database: "greenguard_risk",
    service: "services/risk-engine/migrations",
    ledger: "sha256",
  },
  notifications: {
    database: "greenguard_notifications",
    service: "services/notification-service/migrations",
    ledger: "version-list",
  },
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const root = resolve(value("--root", process.cwd()));
const outputArgument = value("--output", "");
if (!outputArgument) throw new Error("--output is required");
const output = resolve(outputArgument);

async function collect(owner, spec) {
  const dir = join(root, spec.service);
  const files = (await readdir(dir)).sort();
  let migrations;
  if (spec.ledger === "prisma") {
    migrations = [];
    for (const name of files) {
      if (!/^\d{14}_[a-z0-9_]+$/.test(name)) continue;
      const relativePath = `${name}/migration.sql`;
      const contents = await readFile(join(dir, relativePath));
      migrations.push({
        version: name,
        path: relativePath,
        sha256: sha256(contents),
      });
    }
  } else {
    migrations = [];
    for (const name of files) {
      const valid =
        spec.ledger === "version-list"
          ? /^\d{4}_[a-z0-9_]+\.sql$/.test(name)
          : /^\d{6}_[a-z0-9_]+\.up\.sql$/.test(name);
      if (!valid) continue;
      const contents = await readFile(join(dir, name));
      const version = spec.ledger === "version-list" ? name : name.slice(0, 6);
      migrations.push({ version, path: name, sha256: sha256(contents) });
    }
  }
  if (!migrations.length)
    throw new Error(`${owner}: no forward migrations found at ${spec.service}`);
  if (
    new Set(migrations.map(({ version }) => version)).size !== migrations.length
  )
    throw new Error(
      `${owner}: duplicate migration versions at ${spec.service}`,
    );
  const fingerprint = sha256(
    JSON.stringify({
      owner,
      database: spec.database,
      ledger: spec.ledger,
      migrations,
    }),
  );
  return {
    database: spec.database,
    source: spec.service,
    ledger: spec.ledger,
    headVersion: migrations.at(-1).version,
    migrations,
    fingerprint,
  };
}

const owners = {};
for (const [owner, spec] of Object.entries(OWNERS))
  owners[owner] = await collect(owner, spec);
const manifest = { schemaVersion: 1, owners };
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o444,
    flag: "wx",
  });
  // Rebuilds replace the complete public manifest without making its previous
  // read-only copy writable or leaving a partially written ledger behind.
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
console.log(
  `generated tenant-bootstrap ledger manifest for ${Object.keys(owners).length} owner services`,
);
