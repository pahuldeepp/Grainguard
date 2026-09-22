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
const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
if (!response.ok || !(await response.text()).includes("GreenGuard"))
  throw new Error("Dashboard not served");
console.log(
  "Staging passed: dashboard served; both database-backed API routes ready through nginx.",
);
