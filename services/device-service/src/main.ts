import { initTracing } from "@greenguard/otel";
import { readFileSync } from "node:fs";
import { startMembershipRuntime } from "@greenguard/membership-client";
import { createClientCredentialsVerifier } from "@greenguard/tenant-auth/service-principals";
import { loadVersionRegistry } from "./api/versioning/index.js";
import { createApp, DatabaseProbe } from "./app.js";
import { readConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { controlClientLookup } from "./import/auth.js";
const config = readConfig(process.env);
if (config.importAuth && !config.auth)
  throw new Error(
    "import authentication requires the inventory API authentication settings",
  );
const membership = config.auth
  ? await startMembershipRuntime(
      (name) => process.env[name],
      (path) => readFileSync(path, "utf8"),
      "device-service",
    )
  : undefined;
const api = config.auth && {
  db: createDb(config.databaseUrl),
  verifier: membership!,
  ...(config.importAuth && {
    importSourceId: config.importAuth.sourceId,
    importVerifier: createClientCredentialsVerifier({
      issuer: config.importAuth.issuer,
      audience: config.importAuth.audience,
      jwksUrl: config.importAuth.jwksUrl,
      tenantClaim: config.importAuth.tenantClaim,
      lookup: controlClientLookup(
        config.importAuth.controlUrl,
        config.importAuth.lookupToken,
      ),
    }),
  }),
  versions: loadVersionRegistry(process.env),
  tracing:
    config.otel &&
    initTracing({
      serviceName: "device-service",
      otlpEndpoint: config.otel.otlpEndpoint,
      sampleRatio: config.otel.sampleRatio,
    }),
};
if (!api)
  console.warn(
    "device-service: AUTH_* not set, /v1 API disabled (health only)",
  );
export const app = await createApp(new DatabaseProbe(config.databaseUrl), api);
await app.listen(config.port, config.host);
console.log("device-service listening on localhost");
