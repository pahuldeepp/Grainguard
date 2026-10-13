// Authorized local forensic collector. Does not accept DSNs, tokens, tenant IDs
// or payloads from command-line input; protected config remains private.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  createVerifierFromEnv,
  httpPlacementFetcher,
} from "@greenguard/membership-client";
import { login } from "../../../../../scripts/oidc-login.mjs";
const pools = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) =>
  originalFetch(url, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
  });
let report = {
  version: 1,
  status: "blocked",
  executionAllowed: false,
  blockers: ["trusted_collection_failed"],
  freshControlPlaneMembershipVerified: false,
  storage: [],
};
try {
  Object.assign(
    process.env,
    parseEnv(readFileSync(".env", "utf8")),
    parseEnv(readFileSync(".local/assistant-agent.env", "utf8")),
    parseEnv(readFileSync(".local/bff-assistant-live.env", "utf8")),
  );
  const { collectRestoreEvidence } = await import(
    pathToFileURL(resolve(".local/device-restore-collector-build/collector.js"))
  );
  const { observeLocalInventory } = await import(
    pathToFileURL(
      resolve(".local/device-restore-collector-build/postgres-collector.js"),
    )
  );
  const tokens = await login({
    email: "alice@greenguard.test",
    password: process.env.OIDC_DEV_PASSWORD,
  });
  const authorization = "Bearer " + tokens.access_token;
  const getter = (k) =>
    k === "AUTH_MEMBERSHIP_SOURCE"
      ? "control-plane"
      : k === "CONTROL_PLANE_URL"
        ? process.env.CONTROL_PLANE_MEMBERSHIP_URL
        : k === "CONTROL_LOOKUP_TOKEN"
          ? process.env.CONTROL_PLANE_MEMBERSHIP_SERVICE_TOKEN
          : process.env[k];
  const resolveAuthority = httpPlacementFetcher({
    baseUrl: process.env.CONTROL_PLANE_MEMBERSHIP_URL,
    token: process.env.CONTROL_PLANE_MEMBERSHIP_SERVICE_TOKEN,
  });
  const verifyFresh = async () => {
    const verifier = createVerifierFromEnv(getter, (p) =>
      readFileSync(p, "utf8"),
    );
    try {
      return await verifier.verify(authorization);
    } finally {
      verifier.close();
    }
  };
  const migrations = resolve("services/device-service/prisma/migrations");
  const expectedMigrations = readdirSync(migrations)
    .filter((x) => /^\d/.test(x))
    .sort()
    .map((name) => ({
      name,
      sha256: createHash("sha256")
        .update(readFileSync(resolve(migrations, name, "migration.sql")))
        .digest("hex"),
    }));
  const registry = JSON.parse(
    readFileSync(".local/sharding/device-service.json", "utf8"),
  );
  const project = process.env.GG_SHARD_COMPOSE_PROJECT;
  if (!/^greenguard-sharding(?:-[a-z0-9-]+)?$/.test(project ?? ""))
    throw new Error("physical project must be explicitly configured");
  const urls = [
    { label: "legacy", port: new URL(process.env.POSTGRES_ADMIN_URL).port },
    ...Object.entries(registry.shards).map(([label, s]) => {
      const u = new URL(s.primaryUrl);
      if (u.hostname !== "127.0.0.1") throw new Error("local primary only");
      return { label, port: u.port };
    }),
  ];
  const sources = urls.map(({ label, port }) => {
    const url = new URL(process.env.POSTGRES_ADMIN_URL);
    if (
      url.hostname !== "127.0.0.1" ||
      !["postgres:", "postgresql:"].includes(url.protocol)
    )
      throw new Error("local admin only");
    url.port = port;
    url.pathname = "/greenguard_inventory";
    const inventory = new pg.Pool({
      connectionString: url.href,
      max: 1,
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
    });
    pools.push(inventory);
    let physical = null;
    if (label !== "legacy") {
      const labels = execFileSync(
        "docker",
        [
          "ps",
          "--filter",
          `publish=${port}`,
          "--format",
          '{{.Label "com.docker.compose.project"}}',
        ],
        { encoding: "utf8", timeout: 5000 },
      )
        .trim()
        .split("\n");
      if (labels.length !== 1 || labels[0] !== project)
        throw new Error("physical project label mismatch");
      url.pathname = "/postgres";
      physical = new pg.Pool({
        connectionString: url.href,
        max: 1,
        connectionTimeoutMillis: 2000,
        query_timeout: 3000,
      });
      pools.push(physical);
    }
    return {
      label,
      inventory,
      physical,
      composeProject: project,
      expectedMigrations,
    };
  });
  report = await collectRestoreEvidence({
    membershipSource: "control-plane",
    verifyFresh,
    resolveAuthority,
    readStorage: async (tenant) => {
      const result = [];
      for (const source of sources)
        result.push(await observeLocalInventory(source, tenant));
      return result;
    },
    now: Date.now,
  });
} catch {
  /* Raw auth, SQL, configuration and payload errors never enter evidence. */
} finally {
  globalThis.fetch = originalFetch;
  await Promise.all(pools.map((pool) => pool.end()));
}
writeFileSync(
  "evidence/intelligence/device-alerts-local/trusted-restore-collector.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    status: report.status,
    executionAllowed: report.executionAllowed,
    freshControlPlaneMembershipVerified:
      report.freshControlPlaneMembershipVerified,
    blockers: report.blockers,
    observedStores: report.storage.length,
  }),
);
