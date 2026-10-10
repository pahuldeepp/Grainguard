import { assertAnonymousRequestRejected } from "./staging-check-contract.mjs";

const base = process.env.STAGING_URL || "http://127.0.0.1:5174";
for (const [route, service] of [
  ["/api/devices/readyz", "device-service"],
  ["/api/telemetry/readyz", "telemetry-ingest"],
]) {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(base + route, {
        signal: AbortSignal.timeout(2000),
      });
      const body = await response.json();
      if (response.ok && body.service === service && body.status === "ready") {
        ready = true;
        break;
      }
    } catch {
      /* Wait for this deployment to start. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`${service} failed staging readiness`);
}

// Readiness alone can pass when AUTH_* is absent and the product routes are not
// mounted. Require each proxied API to reject an anonymous request with 401;
// a 404 means the application is only running its health probes.
for (const [path, service, method] of [
  ["/api/devices/v1/devices", "device-service", "GET"],
  [
    "/api/telemetry/v1/devices/00000000-0000-4000-8000-000000000001/readings",
    "telemetry-ingest",
    "POST",
  ],
]) {
  const response = await fetch(base + path, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(method === "POST" && { body: "{}" }),
    signal: AbortSignal.timeout(2000),
  });
  assertAnonymousRequestRejected(response, service);
}

const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
if (!response.ok || !(await response.text()).includes("GreenGuard"))
  throw new Error("Dashboard not served");
console.log(
  "Staging passed: dashboard served, both APIs database-ready, and anonymous requests rejected by their auth gates.",
);
