import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";
process.loadEnvFile(".env");
const children = [];
function launch(cmd, args, env) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  return child;
}
async function wait(url) {
  for (let i = 0; i < 80; i++) {
    if (children.some((c) => c.exitCode !== null))
      throw new Error("A service exited during startup");
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {
      /* Startup may still be in progress. */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
async function check(url, service, status = 200) {
  const r = await fetch(url);
  assert.equal(r.status, status);
  assert.deepEqual(await r.json(), {
    service,
    status: status === 200 ? "ready" : "not_ready",
  });
}
try {
  launch("./build/telemetry-ingest", [], { HTTP_ADDR: "127.0.0.1:18080" });
  launch("node", ["services/device-service/dist/main.js"], { PORT: "13001" });
  launch("node", ["services/device-service/dist/main.js"], {
    PORT: "13002",
    INVENTORY_DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
  });
  launch("./build/telemetry-ingest", [], {
    HTTP_ADDR: "127.0.0.1:18081",
    TELEMETRY_DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
  });
  await Promise.all(
    [18080, 18081, 13001, 13002].map((p) =>
      wait(`http://127.0.0.1:${p}/healthz`),
    ),
  );
  await check("http://127.0.0.1:18080/readyz", "telemetry-ingest");
  await check("http://127.0.0.1:13001/readyz", "device-service");
  await check("http://127.0.0.1:18081/readyz", "telemetry-ingest", 503);
  await check("http://127.0.0.1:13002/readyz", "device-service", 503);
  for (const [key, other] of [
    ["INVENTORY_DATABASE_URL", "greenguard_telemetry"],
    ["TELEMETRY_DATABASE_URL", "greenguard_inventory"],
  ]) {
    const own = new pg.Client({ connectionString: process.env[key] });
    try {
      await own.connect();
      const result = await own.query(
        "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user",
      );
      assert.deepEqual(result.rows[0], {
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
    } finally {
      await own.end();
    }
    const url = new URL(process.env[key]);
    url.pathname = `/${other}`;
    const denied = new pg.Client({ connectionString: url.toString() });
    try {
      await assert.rejects(
        () => denied.connect(),
        (error) => error.code === "42501",
      );
    } finally {
      await denied.end();
    }
  }
  console.log(
    "PASS: live database readiness, unavailable database returns 503, application database privileges and cross-database denial.",
  );
} finally {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => {
            child.once("exit", resolve);
            setTimeout(() => child.kill("SIGKILL"), 3000).unref();
          }),
    ),
  );
}
