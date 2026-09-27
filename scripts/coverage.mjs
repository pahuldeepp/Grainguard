import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
function run(cmd, args, cwd = process.cwd()) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error || r.status !== 0) process.exit(r.status || 1);
}
mkdirSync("coverage", { recursive: true });
run("npm", ["run", "coverage", "--workspaces"]);
for (const workspace of [
  "apps/dashboard",
  "packages/otel",
  "packages/tenant-auth",
  "packages/contracts",
  "packages/read-model",
  "packages/feature-flags",
  "packages/entitlements",
  "packages/audit",
  "services/bff",
  "services/gateway",
  "services/read-api",
  "services/device-service",
  "services/workflow-alerts",
  "services/notification-service",
  "services/tenant-control-plane",
  "services/billing-service",
  "packages/membership-client",
  "packages/kafka-runtime",
]) {
  const filename = `${workspace}/coverage/lcov.info`;
  const normalized = readFileSync(filename, "utf8").replace(
    /^SF:(.+)$/gm,
    (_, file) =>
      `SF:${path.relative(process.cwd(), path.resolve(workspace, file)).split(path.sep).join("/")}`,
  );
  if (!normalized.includes("SF:"))
    throw new Error(`Empty coverage report: ${filename}`);
  writeFileSync(filename, normalized);
}
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/go.raw.out",
    "./...",
  ],
  "services/telemetry-ingest",
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/kafka-transport.raw.out",
    "./...",
  ],
  "packages/kafka-transport",
);
writeFileSync(
  "coverage/kafka-transport.out",
  readFileSync("coverage/kafka-transport.raw.out", "utf8").replaceAll(
    "greenguard.local/kafka-transport/",
    "packages/kafka-transport/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/go-common.raw.out",
    "./...",
  ],
  "packages/go-common",
);
writeFileSync(
  "coverage/go-common.out",
  readFileSync("coverage/go-common.raw.out", "utf8").replaceAll(
    "greenguard.local/go-common/",
    "packages/go-common/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/go-migrations.raw.out",
    "./...",
  ],
  "packages/go-migrations",
);
writeFileSync(
  "coverage/go-migrations.out",
  readFileSync("coverage/go-migrations.raw.out", "utf8").replaceAll(
    "greenguard.local/go-migrations/",
    "packages/go-migrations/",
  ),
);
const raw = readFileSync("coverage/go.raw.out", "utf8");
writeFileSync(
  "coverage/go.out",
  raw.replaceAll(
    "greenguard.local/telemetry-ingest/",
    "services/telemetry-ingest/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/cdc-transformer.raw.out",
    "./...",
  ],
  "services/cdc-transformer",
);
writeFileSync(
  "coverage/cdc-transformer.out",
  readFileSync("coverage/cdc-transformer.raw.out", "utf8").replaceAll(
    "greenguard.local/cdc-transformer/",
    "services/cdc-transformer/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/projection-builder.raw.out",
    "./...",
  ],
  "services/projection-builder",
);
writeFileSync(
  "coverage/projection-builder.out",
  readFileSync("coverage/projection-builder.raw.out", "utf8").replaceAll(
    "greenguard.local/projection-builder/",
    "services/projection-builder/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/cassandra-writer.raw.out",
    "./...",
  ],
  "services/cassandra-writer",
);
writeFileSync(
  "coverage/cassandra-writer.out",
  readFileSync("coverage/cassandra-writer.raw.out", "utf8").replaceAll(
    "greenguard.local/cassandra-writer/",
    "services/cassandra-writer/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/cache-invalidator.raw.out",
    "./...",
  ],
  "services/cache-invalidator",
);
writeFileSync(
  "coverage/cache-invalidator.out",
  readFileSync("coverage/cache-invalidator.raw.out", "utf8").replaceAll(
    "greenguard.local/cache-invalidator/",
    "services/cache-invalidator/",
  ),
);
run("python3", ["-m", "venv", ".local/search-venv"]);
run(".local/search-venv/bin/pip", [
  "install",
  "-r",
  "services/search-indexer/requirements-dev.txt",
]);
run(".local/search-venv/bin/coverage", [
  "run",
  "--source=services/search-indexer",
  "--omit=*/test_*.py,*/live_*.py",
  "-m",
  "unittest",
  "discover",
  "-s",
  "services/search-indexer",
  "-p",
  "test_*.py",
]);
run(".local/search-venv/bin/coverage", [
  "xml",
  "-o",
  "services/search-indexer/coverage.xml",
]);
const pythonXML = "services/search-indexer/coverage.xml";
writeFileSync(
  pythonXML,
  readFileSync(pythonXML, "utf8").replace(
    /<source>[^<]*<\/source>/,
    "<source>.</source>",
  ),
);
run("python3", ["-m", "venv", ".local/risk-venv"]);
run(".local/risk-venv/bin/pip", [
  "install",
  "-q",
  "-r",
  "services/risk-engine/requirements-dev.txt",
]);
// Live greenguard_risk tests run here too (make coverage runs db-migrate first).
run(".local/risk-venv/bin/coverage", [
  "run",
  "--branch",
  "--data-file=coverage/risk-engine.coverage",
  "--source=services/risk-engine/risk_engine",
  "-m",
  "unittest",
  "discover",
  "-s",
  "services/risk-engine",
  "-t",
  "services/risk-engine",
  "-p",
  "test_*.py",
]);
run(".local/risk-venv/bin/coverage", [
  "xml",
  "--data-file=coverage/risk-engine.coverage",
  "-o",
  "services/risk-engine/coverage.xml",
]);
const riskXML = "services/risk-engine/coverage.xml";
writeFileSync(
  riskXML,
  readFileSync(riskXML, "utf8").replace(
    /<source>[^<]*<\/source>/,
    "<source>.</source>",
  ),
);
// Stage 06d jobs-worker: live greenguard_jobs tests run here (make coverage migrates first).
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/jobs-worker.raw.out",
    "./...",
  ],
  "services/jobs-worker",
);
writeFileSync(
  "coverage/jobs-worker.out",
  readFileSync("coverage/jobs-worker.raw.out", "utf8").replaceAll(
    "greenguard.local/jobs-worker/",
    "services/jobs-worker/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/saga-orchestrator.raw.out",
    "./...",
  ],
  "services/saga-orchestrator",
);
writeFileSync(
  "coverage/saga-orchestrator.out",
  readFileSync("coverage/saga-orchestrator.raw.out", "utf8").replaceAll(
    "greenguard.local/saga-orchestrator/",
    "services/saga-orchestrator/",
  ),
);
run(
  "go",
  [
    "test",
    "-race",
    "-coverpkg=./...",
    "-coverprofile=../../coverage/hardware-service.raw.out",
    "./...",
  ],
  "services/hardware-service",
);
writeFileSync(
  "coverage/hardware-service.out",
  readFileSync("coverage/hardware-service.raw.out", "utf8").replaceAll(
    "greenguard.local/hardware-service/",
    "services/hardware-service/",
  ),
);
console.log("Coverage reports ready for SonarQube.");
