import assert from "node:assert/strict";
import { test } from "node:test";
import { readTenantBootstrapWorkerConfig } from "./worker-config.js";

const env = (databaseUrl: string, extra: NodeJS.ProcessEnv = {}) => ({
  CONTROL_BOOTSTRAP_DATABASE_URL: databaseUrl,
  ...extra,
});

test("worker config accepts the dedicated TLS-verified control DB secret", () => {
  const config = readTenantBootstrapWorkerConfig(
    env(
      "postgresql://tenant_bootstrap_worker:secret@rds.example:5432/greenguard_control?sslmode=verify-full&sslrootcert=/etc/greenguard/rds/ca.pem",
      { CONTROL_BOOTSTRAP_POLL_MS: "2500" },
    ),
  );
  assert.equal(config.pollIntervalMs, 2500);
  assert.equal(config.errorBackoffMs, 5000);
});

test("worker config allows loopback-only plaintext for local development", () => {
  const config = readTenantBootstrapWorkerConfig(
    env(
      "postgresql://tenant_bootstrap_worker:secret@127.0.0.1:55432/greenguard_control",
    ),
  );
  assert.equal(config.databaseUrl.includes("sslmode"), false);
});

test("worker config rejects API credentials, other databases, and unverified remote TLS", () => {
  for (const url of [
    "postgresql://control_app:secret@127.0.0.1/greenguard_control",
    "postgresql://tenant_bootstrap_worker@127.0.0.1/greenguard_control",
    "postgresql://tenant_bootstrap_worker:secret@127.0.0.1/other",
    "postgresql://tenant_bootstrap_worker:secret@rds.example/greenguard_control",
    "postgresql://tenant_bootstrap_worker:secret@rds.example/greenguard_control?sslmode=verify-full&sslrootcert=ca.pem",
  ])
    assert.throws(() => readTenantBootstrapWorkerConfig(env(url)));
  assert.throws(
    () =>
      readTenantBootstrapWorkerConfig(
        env(
          "postgresql://tenant_bootstrap_worker:secret@127.0.0.1/greenguard_control",
          { CONTROL_BOOTSTRAP_POLL_MS: "10" },
        ),
      ),
    /between 500 and 60000ms/,
  );
});
