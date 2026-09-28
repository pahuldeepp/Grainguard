import { initTracing } from "@greenguard/otel";
import { createPublicKey } from "node:crypto";
import { createS3ExportStorage } from "@greenguard/audit";
import { createControlPlaneApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { AuditSources } from "./audit/owners.js";

// Entry point kept testable: configuration comes in as a parameter.
export async function start(env: NodeJS.ProcessEnv) {
  const config = readConfig(env);
  const app = await createControlPlaneApp({
    db: createDb(config.databaseUrl),
    lookupToken: config.lookupToken,
    apiKeyPepper: config.apiKeyPepper,
    apiKeyEnvironment: config.apiKeyEnvironment,
    m2m: config.m2m,
    machineIssuers: config.machineIssuers,
    flagAdmin: config.flagAdmin,
    audit: config.audit && {
      directory: config.audit.directory,
      publicKey: createPublicKey(
        config.audit.publicKeyPem.replaceAll("\\n", "\n"),
      ),
      linkSecret: config.audit.linkSecret,
      storage: config.audit.s3 && createS3ExportStorage(config.audit.s3),
      presignTtlSeconds: config.audit.s3?.presignTtlSeconds,
      sources: new AuditSources(
        config.audit.inventoryDatabaseUrl,
        config.audit.billingDatabaseUrl,
      ),
    },
    auth:
      config.auth &&
      ("issuers" in config.auth
        ? {
            issuers: config.auth.issuers.map((issuer) => ({
              issuer: issuer.issuer,
              audience: issuer.audience,
              keys: { jwksUrl: issuer.jwksUrl },
            })),
          }
        : {
            issuer: config.auth.issuer,
            audience: config.auth.audience,
            tokenMode: config.auth.tokenMode,
            cognitoClientIds: config.auth.cognitoClientIds,
            keys: { jwksUrl: config.auth.jwksUrl },
          }),
    tracing:
      config.otlpEndpoint === undefined
        ? undefined
        : initTracing({
            serviceName: "tenant-control-plane",
            otlpEndpoint: config.otlpEndpoint,
            sampleRatio: 1,
          }),
  });
  await app.listen(config.port, config.host);
  return app;
}

if (process.argv[1]?.endsWith("tenant-control-plane/dist/main.js"))
  await start(process.env);
