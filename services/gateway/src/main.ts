import { readFileSync } from "node:fs";
import { Agent as HTTPSAgent } from "node:https";
import { startMembershipRuntime } from "@greenguard/membership-client";
import {
  createMachineControlPlaneVerifier,
  machineAwareVerifier,
} from "@greenguard/tenant-auth/machine-control-plane";
import { createGateway } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

const saga = new URL(required("GATEWAY_SAGA_URL"));
const cert = process.env.GATEWAY_SAGA_CLIENT_CERT;
const key = process.env.GATEWAY_SAGA_CLIENT_KEY;
const ca = process.env.GATEWAY_SAGA_CA;
if (Boolean(cert) !== Boolean(key))
  throw new Error("saga client cert and key must be configured together");
if (saga.protocol === "https:" && !ca)
  throw new Error("GATEWAY_SAGA_CA is required for HTTPS saga upstream");
const sagaAgent =
  saga.protocol === "https:"
    ? new HTTPSAgent({
        ca: readFileSync(required("GATEWAY_SAGA_CA")),
        cert: cert ? readFileSync(cert) : undefined,
        key: key ? readFileSync(key!) : undefined,
      })
    : undefined;
const verifier = await startMembershipRuntime(
  (name) => process.env[name],
  (path) => readFileSync(path, "utf8"),
  "gateway",
);
const machine =
  process.env.CONTROL_PLANE_URL && process.env.CONTROL_LOOKUP_TOKEN
    ? createMachineControlPlaneVerifier({
        endpoint: process.env.CONTROL_PLANE_URL,
        lookupToken: process.env.CONTROL_LOOKUP_TOKEN,
      })
    : undefined;
const verify = machineAwareVerifier(verifier.verify, machine, "read:telemetry");
const server = createGateway({
  verify,
  bff: new URL(required("GATEWAY_BFF_URL")),
  read: new URL(required("GATEWAY_READ_URL")),
  saga,
  sagaAgent,
  timeoutMs: positiveInteger("GATEWAY_TIMEOUT_MS", 15_000),
  maxBodyBytes: positiveInteger("GATEWAY_MAX_BODY_BYTES", 1_048_576),
});
const host = process.env.GATEWAY_HOST || "127.0.0.1";
const port = positiveInteger("GATEWAY_PORT", 4002);
const metricsPort = positiveInteger("GATEWAY_METRICS_PORT", 9464);
const metricsHost = process.env.GATEWAY_METRICS_HOST || "127.0.0.1";
if (metricsPort === port)
  throw new Error("GATEWAY_METRICS_PORT must differ from GATEWAY_PORT");
server.metricsServer.listen(metricsPort, metricsHost, () =>
  console.log(`gateway metrics listening on ${metricsHost}:${metricsPort}`),
);
server.listen(port, host, () =>
  console.log(`gateway listening on ${host}:${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.closeUpgradedConnections();
    server.metricsServer.close();
    server.close(async () => {
      await verifier.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10_000).unref();
  });
}
