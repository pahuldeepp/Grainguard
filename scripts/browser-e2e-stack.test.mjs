import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dashboardServer } from "./browser-e2e-stack.mjs";

async function withDashboard(config, run) {
  const root = mkdtempSync(path.join(tmpdir(), "greenguard-dashboard-server-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "index.html"), "<main>dashboard</main>");
  const { server } = dashboardServer(root, 1, config);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

test("dashboard server serves explicit public OIDC config without caching", async () => {
  const config = {
    authority: "http://127.0.0.1:5556/dex",
    clientId: "greenguard-dashboard",
    audience: "greenguard-dashboard",
    tokenMode: "audience",
  };
  await withDashboard(config, async (base) => {
    const response = await fetch(`${base}/config.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), config);
  });
});

test("dashboard server fails closed when runtime OIDC config is absent", async () => {
  await withDashboard(undefined, async (base) => {
    const response = await fetch(`${base}/config.json`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
